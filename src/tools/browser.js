// An embedded Chromium view shared by the user and the AI. The user can click
// around in it directly; the AI drives it through the tool functions below.

const { WebContentsView, session } = require('electron');

const MAX_TEXT = 12000;

class SharedBrowser {
  constructor(win) {
    this.win = win;
    this.view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition('persist:browser'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    const wc = this.view.webContents;
    const notify = () =>
      this.win.webContents.send('browser:state', {
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
      wc.on(ev, notify);
    }
    // Keep popups inside the shared view so the AI and user see the same page.
    wc.setWindowOpenHandler(({ url }) => {
      wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.loadURL('https://duckduckgo.com/');
  }

  setBounds(b) {
    this.bounds = b;
    if (this.visible) this.view.setBounds(b);
  }

  setVisible(v) {
    this.visible = v;
    if (v) {
      this.win.contentView.addChildView(this.view);
      this.view.setBounds(this.bounds);
    } else {
      this.win.contentView.removeChildView(this.view);
    }
  }

  get wc() {
    return this.view.webContents;
  }

  async navigate(url) {
    if (!/^[a-z]+:\/\//i.test(url)) {
      url = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(url) ? `https://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
    }
    await this.loadAndSettle(() => this.wc.loadURL(url));
    return this.wc.getURL();
  }

  // Runs an action and waits for any navigation it triggers to finish.
  async loadAndSettle(action) {
    const done = new Promise((resolve) => {
      const t = setTimeout(resolve, 15000);
      const finish = () => {
        clearTimeout(t);
        setTimeout(resolve, 600); // let client-side rendering catch up
      };
      this.wc.once('did-stop-loading', finish);
    });
    try {
      await action();
    } catch (e) {
      if (!String(e.message).includes('ERR_ABORTED')) throw e;
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500)).then(() => (this.wc.isLoading() ? done : null))]);
  }

  async search(query) {
    await this.loadAndSettle(() => this.wc.loadURL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`));
    const results = await this.wc.executeJavaScript(`
      [...document.querySelectorAll('.result')].slice(0, 8).map(r => {
        const a = r.querySelector('a.result__a');
        let href = a ? a.href : '';
        try { const u = new URL(href); if (u.searchParams.get('uddg')) href = u.searchParams.get('uddg'); } catch {}
        return { title: a ? a.innerText.trim() : '', url: href, snippet: (r.querySelector('.result__snippet')||{}).innerText || '' };
      }).filter(r => r.url)
    `);
    if (!results.length) return 'No results found (the search page may have shown a captcha — check the browser panel).';
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.trim()}`).join('\n');
  }

  // Returns readable page text plus a numbered list of interactive elements.
  // Elements get a data-mh-id attribute so click/type can target them later.
  async read() {
    const page = await this.wc.executeJavaScript(`(() => {
      const els = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button]')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .slice(0, 150);
      const items = els.map((e, i) => {
        e.setAttribute('data-mh-id', i);
        const label = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.title || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        const kind = e.tagName === 'A' ? 'link' : (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') ? 'input' : e.tagName.toLowerCase();
        return '[' + i + '] ' + kind + ': ' + label;
      });
      return { title: document.title, url: location.href, text: document.body ? document.body.innerText : '', items };
    })()`);
    let text = page.text.replace(/\n{3,}/g, '\n\n');
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n…(truncated)';
    return `Title: ${page.title}\nURL: ${page.url}\n\n${text}\n\nInteractive elements:\n${page.items.join('\n')}`;
  }

  async click(id) {
    let found = false;
    await this.loadAndSettle(async () => {
      found = await this.wc.executeJavaScript(`(() => {
        const e = document.querySelector('[data-mh-id="${Number(id)}"]');
        if (!e) return false;
        e.scrollIntoView({ block: 'center' });
        e.click();
        return true;
      })()`);
    });
    if (!found) return `No element [${id}] — call read_page first to get fresh element numbers.`;
    return `Clicked [${id}]. Now on: ${this.wc.getTitle()} (${this.wc.getURL()})`;
  }

  async type(id, text, submit) {
    const ok = await this.wc.executeJavaScript(`(() => {
      const e = document.querySelector('[data-mh-id="${Number(id)}"]');
      if (!e) return false;
      e.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value');
      if (setter && setter.set) setter.set.call(e, ${JSON.stringify(text)}); else e.value = ${JSON.stringify(text)};
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) return `No element [${id}] — call read_page first.`;
    if (submit) {
      await this.loadAndSettle(() =>
        this.wc.executeJavaScript(`(() => {
          const e = document.querySelector('[data-mh-id="${Number(id)}"]');
          if (e.form) { e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit(); }
          else e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        })()`)
      );
      return `Typed into [${id}] and submitted. Now on: ${this.wc.getTitle()} (${this.wc.getURL()})`;
    }
    return `Typed into [${id}].`;
  }
}

module.exports = { SharedBrowser };
