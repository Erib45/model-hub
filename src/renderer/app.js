const { hub } = window;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const fmtSpeed = (bps) => (bps > 0 ? (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1e3))} KB/s`) : '');
const fmtEta = (sec) =>
  sec != null && isFinite(sec) && sec > 0
    ? sec >= 3600
      ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
      : sec >= 60
        ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
        : `${Math.round(sec)}s`
    : '';
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p || '';

const state = {
  view: 'chat',
  models: [],
  chat: null, // current chat object
  busy: new Set(), // chatIds currently generating
  activities: new Map(), // chatId -> { phase, label, target, panel, cwd, model, startedAt }
  agentQueue: { testerActive: null, testerQueue: [], mergerActive: null, mergerQueue: [] },
  pulls: new Map(), // modelName -> pull progress state
  live: null, // DOM refs for the streaming assistant bubble
  panelTab: 'browser',
  panelOpen: false,
  cwd: '',
  repoRoot: '',
  branch: '',
  ollamaRunning: false,
  ollamaVersion: '',
};

// ---------------- markdown (minimal, safe) ----------------

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-link>$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-link>$2</a>');
}

function markdown(src) {
  const out = [];
  const parts = String(src).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      out.push(`<div class="codeblock">${lang ? `<span class="lang">${esc(lang)}</span>` : ''}<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre><button class="copy">Copy</button></div>`);
      return;
    }
    const lines = esc(part).split('\n');
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    let table = null;
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const flushTable = () => {
      if (table) {
        const [head, ...body] = table;
        out.push(`<div class="table-wrap"><table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      }
      table = null;
    };
    for (const line of lines) {
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushPara(); flushList();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // header separator
        (table ||= []).push(cells(line));
        continue;
      }
      flushTable();
      if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
        flushPara(); flushList();
        out.push(`<h3>${inline(m[2])}</h3>`);
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        flushPara();
        const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[1]);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList(); flushTable();
  });
  return out.join('');
}

document.addEventListener('click', (e) => {
  const copy = e.target.closest('.codeblock .copy');
  if (copy) {
    navigator.clipboard.writeText(copy.parentElement.querySelector('code').innerText);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  }
  const link = e.target.closest('a[data-link]');
  if (link) {
    // Links from chat open in the shared browser panel.
    e.preventDefault();
    openPanel('browser');
    hub.browser.navigate(link.href);
  }
});

// ---------------- views ----------------

function showView(view) {
  state.view = view;
  for (const v of ['chat', 'library', 'discover', 'settings', 'setup']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'library') renderLibrary();
  if (view === 'settings') loadSettings();
  if (view === 'discover') renderDiscover();
  if (view === 'setup') renderSetup();
  renderChatList();
}
document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------------- ollama status ----------------

async function refreshStatus() {
  const s = await hub.ollama.status();
  state.ollamaRunning = !!s.running;
  state.ollamaVersion = s.version || '';
  const el = $('#ollamaStatus');
  if (s.running) {
    el.innerHTML = `<span class="dot" style="background:var(--ok);color:var(--ok)"></span>Ollama ${esc(s.version)}`;
  } else {
    el.innerHTML = `<span class="dot" style="background:var(--danger);color:var(--danger)"></span>Ollama offline <button id="startOllama">Start</button>`;
    $('#startOllama').onclick = async () => {
      el.textContent = 'Starting Ollama…';
      await hub.ollama.start();
      await refreshStatus();
      await loadModels();
    };
  }
  if (typeof renderTitlebarStatus === 'function') renderTitlebarStatus();
  return s.running;
}

async function loadModels() {
  try {
    state.models = await hub.models.list();
  } catch {
    state.models = [];
  }
  renderModelSelect();
  if (state.view === 'library') renderLibrary();
}

const modelInfo = (id) => state.models.find((m) => m.id === id);
const PROVIDER_LABEL = {
  ollama: 'Local (Ollama)',
  'ollama-cloud': 'Ollama cloud',
  claudecode: 'Claude Code (your plan)',
  codexcli: 'Codex (your ChatGPT plan)',
  geminicli: 'Gemini CLI (your Google account)',
  antigravity: 'Antigravity (your Google AI plan)',
  anthropic: 'Claude API',
  openai: 'OpenAI API',
  gemini: 'Gemini API',
};
const PROVIDER_SUFFIX = { claudecode: ' (your Claude plan)', codexcli: ' (your ChatGPT plan)', geminicli: ' (your Google account)', antigravity: ' (your Google AI plan)', anthropic: ' (Claude API)', openai: ' (OpenAI API)', gemini: ' (Gemini API)' };
const PLAN_PROVIDERS = ['claudecode', 'codexcli', 'geminicli', 'antigravity'];
const groupOf = (m) => (m.cloud ? 'ollama-cloud' : m.provider);

// ---------------- library ----------------

async function renderLibrary() {
  const local = state.models.filter((m) => m.local);
  const cloud = state.models.filter((m) => !m.local);
  const grid = $('#installedGrid');
  if (!local.length) {
    grid.innerHTML = `<div class="muted">No models installed yet. Download one below — e.g. <b>qwen3-coder:30b</b> for coding or <b>gpt-oss:20b</b> for research.</div>`;
  } else {
    grid.innerHTML = '';
    for (const m of local) grid.appendChild(modelCard(m));
  }
  $('#cloudHint').textContent = cloud.length
    ? 'Models from your connected accounts. Usage is billed by the provider.'
    : 'Connect Claude or Gemini under Settings → Accounts to use cloud models here.';
  $('#cloudGrid').innerHTML = '';
  for (const m of cloud) $('#cloudGrid').appendChild(modelCard(m));
}

function modelCard(m) {
  const el = document.createElement('div');
  el.className = 'card';
  const caps = (m.capabilities || []).filter((c) => c !== 'completion' && !m.tags.includes(c));
  el.innerHTML = `
    <h3><span>${esc(m.title)}</span>${m.loaded ? '<span class="chip loaded">in memory</span>' : ''}</h3>
    <div class="name">${esc(m.name)} <span class="chip">${esc(PROVIDER_LABEL[groupOf(m)])}</span></div>
    <div class="meta">${[m.parameterSize, m.quantization, m.size ? fmtSize(m.size) : '', m.contextLength ? `${Math.round(m.contextLength / 1024)}k ctx max` : ''].filter(Boolean).map(esc).join(' · ')}</div>
    <div class="chips">${m.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}${caps.map((c) => `<span class="chip cap">${esc(c)}</span>`).join('')}</div>
    <div class="desc ${m.description ? '' : 'empty'}" title="Click to edit">${esc(m.description || 'No description yet — click to add what this model is good at.')}</div>
    <div class="actions">
      <button class="primary" data-act="chat">Chat</button>
      ${m.loaded ? '<button data-act="unload">Unload</button>' : ''}
      ${m.provider === 'ollama' ? `<button class="danger" data-act="delete">${m.cloud ? 'Remove' : 'Delete'}</button>` : ''}
    </div>`;
  el.querySelector('.desc').onclick = () => editDescription(el, m);
  el.querySelector('[data-act=chat]').onclick = async () => {
    await newChat(m.id);
  };
  el.querySelector('[data-act=unload]')?.addEventListener('click', async () => {
    await hub.models.unload(m.name);
    loadModels();
  });
  const del = el.querySelector('[data-act=delete]');
  if (del) del.onclick = async () => {
    if (del.dataset.confirm) {
      del.disabled = true;
      await hub.models.remove(m.name);
      loadModels();
    } else {
      del.dataset.confirm = '1';
      del.textContent = m.cloud ? 'Really remove?' : `Really delete (${fmtSize(m.size)})?`;
      setTimeout(() => { delete del.dataset.confirm; del.textContent = m.cloud ? 'Remove' : 'Delete'; }, 4000);
    }
  };
  return el;
}

function editDescription(card, m) {
  const desc = card.querySelector('.desc');
  const box = document.createElement('div');
  box.innerHTML = `<textarea rows="4">${esc(m.description)}</textarea>
    <div class="actions"><button class="primary" data-a="save">Save</button><button data-a="cancel">Cancel</button>${m.customDescription ? '<button data-a="reset">Reset to default</button>' : ''}</div>`;
  desc.replaceWith(box);
  box.querySelector('textarea').focus();
  box.querySelector('[data-a=save]').onclick = async () => {
    await hub.models.setNote(m.id, box.querySelector('textarea').value.trim());
    loadModels();
  };
  box.querySelector('[data-a=cancel]').onclick = () => renderLibrary();
  box.querySelector('[data-a=reset]')?.addEventListener('click', async () => {
    await hub.models.setNote(m.id, null);
    loadModels();
  });
}

const pullEls = new Map();

function renderPullsUi() {
  const activeCount = [...state.pulls.values()].filter((p) => !p.done).length;
  $('#dlBadge').hidden = !activeCount;
  $('#dlBadge').textContent = activeCount;
  if (typeof renderTitlebarStatus === 'function') renderTitlebarStatus();

  const sb = $('#sidebarPulls');
  if (!sb) return;
  const items = [...state.pulls.values()];
  if (!items.length) {
    sb.hidden = true;
    sb.innerHTML = '';
    return;
  }
  sb.hidden = false;
  sb.innerHTML = `
    <div class="sidebar-pulls-head">
      <span>${icon('download')} Downloads (${activeCount || items.length})</span>
      <button class="link small" id="sbOpenDiscover">Details</button>
    </div>
    ${items
      .map((p) => {
        const pct = p.pct != null ? Math.min(100, Math.max(0, p.pct)) : p.done && !p.error ? 100 : 0;
        const speedStr = fmtSpeed(p.speed);
        const etaStr = fmtEta(p.eta);
        const subRight = [speedStr, etaStr ? `ETA ${etaStr}` : ''].filter(Boolean).join(' · ') || (p.total ? fmtSize(p.total) : '');
        return `<div class="sp-item">
          <div class="sp-top">
            <span class="sp-name" title="${esc(p.name)}">${esc(p.name)}</span>
            ${p.done ? `<span class="small ${p.error ? 'error' : 'muted'}">${p.error ? '✕' : '✓'}</span>` : `<button class="mini cancel-sp" data-cancel="${esc(p.name)}">Cancel</button>`}
          </div>
          <div class="bar"><div style="width:${pct.toFixed(1)}%"></div></div>
          <div class="sp-sub">
            <span>${esc(p.status || 'Downloading…')}${p.pct != null && !p.done ? ` (${p.pct.toFixed(0)}%)` : ''}</span>
            <span>${esc(subRight)}</span>
          </div>
        </div>`;
      })
      .join('')}`;
  sb.querySelector('#sbOpenDiscover')?.addEventListener('click', () => showView('discover'));
  sb.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => hub.models.cancelPull(b.dataset.cancel)));
}

function syncPullButtons() {
  const have = installedNames();
  document.querySelectorAll('[data-pull]').forEach((b) => {
    const name = b.dataset.pull;
    const p = state.pulls.get(name);
    if (p && !p.done) {
      b.disabled = true;
      b.textContent = p.queued ? 'Queued…' : p.pct != null ? `Downloading ${p.pct.toFixed(0)}%…` : 'Downloading…';
    } else if (have.has(name) || have.has(`${name}:latest`) || have.has(name.replace(/:latest$/, ''))) {
      b.disabled = true;
      b.textContent = '✓ installed';
    }
  });
}

// `start` defaults to an Ollama pull; imports pass their own starter.
function startPull(name, start = () => hub.models.pull(name)) {
  name = name.trim();
  if (!name || pullEls.has(name)) return;
  const el = document.createElement('div');
  el.className = 'pull';
  el.innerHTML = `
    <div class="row">
      <b>${esc(name)}</b>
      <span class="st muted">Starting…</span>
      <span class="spacer"></span>
      <span class="pull-meta"></span>
      <button class="mini cancel">Cancel</button>
    </div>
    <div class="bar"><div style="width:0"></div></div>`;
  el.querySelector('.cancel').onclick = () => hub.models.cancelPull(name);
  $('#pulls').appendChild(el);
  pullEls.set(name, el);
  state.pulls.set(name, { name, status: 'Starting…', pct: 0, done: false });
  renderPullsUi();
  syncPullButtons();
  start();
}

hub.models.onPullProgress((p) => {
  const el = pullEls.get(p.name);
  const pct = p.total ? Math.min(100, (100 * (p.completed || 0)) / p.total) : p.percent != null ? p.percent : null;
  const cur = state.pulls.get(p.name) || { name: p.name };
  const merged = {
    ...cur,
    ...p,
    pct: pct != null ? pct : cur.pct,
  };
  state.pulls.set(p.name, merged);

  if (el) {
    const sizeInfo = p.total ? ` — ${fmtSize(p.completed || 0)} / ${fmtSize(p.total)} (${(pct || 0).toFixed(1)}%)` : pct != null ? ` — ${pct.toFixed(1)}%` : '';
    el.querySelector('.st').textContent = (p.status || 'Downloading…') + sizeInfo;
    const metaEl = el.querySelector('.pull-meta');
    if (metaEl) {
      const speedStr = fmtSpeed(p.speed);
      const etaStr = fmtEta(p.eta);
      metaEl.textContent = [speedStr, etaStr ? `ETA ${etaStr}` : ''].filter(Boolean).join(' · ');
    }
    if (merged.pct != null) el.querySelector('.bar > div').style.width = `${merged.pct}%`;
  }

  renderPullsUi();
  syncPullButtons();

  if (p.done) {
    if (el) {
      el.querySelector('.cancel')?.remove();
      if (!p.error) el.querySelector('.bar > div').style.width = '100%';
      setTimeout(() => el.remove(), p.error ? 8000 : 3000);
    }
    pullEls.delete(p.name);
    setTimeout(() => {
      state.pulls.delete(p.name);
      renderPullsUi();
      syncPullButtons();
    }, p.error ? 8000 : 3000);
    loadModels().then(() => {
      syncPullButtons();
      if (state.view === 'discover') renderDiscover();
    });
  }
});
$('#pullForm').onsubmit = (e) => {
  e.preventDefault();
  startPull($('#pullName').value);
  $('#pullName').value = '';
};
$('#gotoDiscover').onclick = () => showView('discover');

// ---------------- discover ----------------

let hw = null;
const installedNames = () => new Set(state.models.filter((m) => m.provider === 'ollama').map((m) => m.name));
const parseSize = (s) => {
  const m = String(s).match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  return m ? Number(m[1]) * { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3 }[m[2].toUpperCase()] : 0;
};
// How well a download of `bytes` will run on this PC.
function fitBadge(bytes) {
  if (!bytes || !hw) return '';
  const need = bytes * 1.15; // weights + KV cache / overhead
  if (hw.vram && need <= hw.vram) return '<span class="fit good" title="Fits entirely in GPU memory: fast">fits GPU</span>';
  if (need <= (hw.vram || 0) + hw.ram * 0.5) return '<span class="fit ok" title="Split between GPU and system RAM: slower (MoE models cope well)">GPU + RAM</span>';
  return '<span class="fit bad" title="Larger than your GPU + available RAM">too big</span>';
}
function downloadBtn(name, bytes, cloud) {
  const have = installedNames();
  if (have.has(name) || have.has(`${name}:latest`) || have.has(name.replace(/:latest$/, ''))) return `<button disabled>✓ ${cloud ? 'added' : 'installed'}</button>`;
  const active = state.pulls.get(name);
  if (active && !active.done) {
    const lbl = active.queued ? 'Queued…' : active.pct != null ? `Downloading ${active.pct.toFixed(0)}%…` : 'Downloading…';
    return `<button class="primary" data-pull="${esc(name)}" disabled>${esc(lbl)}</button>`;
  }
  return cloud
    ? `<button class="primary" data-pull="${esc(name)}" title="Adds the cloud model to your library (no download)">${icon('plus')}Add</button>`
    : `<button class="primary" data-pull="${esc(name)}">${icon('download')}${bytes ? fmtSize(bytes) : 'Download'}</button>`;
}
function wirePulls(root) {
  root.querySelectorAll('[data-pull]').forEach((b) => (b.onclick = () => {
    startPull(b.dataset.pull);
    b.disabled = true;
    b.textContent = 'Downloading…';
  }));
  syncPullButtons();
}

document.querySelectorAll('.subtabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('#view-discover .sub').forEach((el) => (el.hidden = el.id !== `sub-${b.dataset.sub}`));
  if (b.dataset.sub === 'ollama' && !$('#olResults').children.length) ollamaSearch();
}));

async function renderDiscover() {
  hw = hw || (await hub.system.info());
  $('#hwHint').textContent = `Your PC: ${hw.gpu || 'no NVIDIA GPU detected'}${hw.vram ? ` (${Math.round(hw.vram / 2 ** 30)} GB VRAM)` : ''}, ${Math.round(hw.ram / 2 ** 30)} GB RAM. Models that fit in VRAM run fastest.`;
  const cat = await hub.models.catalog();
  $('#catalogGrid').innerHTML = cat
    .filter((c) => c.pull.length)
    .map((c) => `<div class="card">
        <h3>${esc(c.title)}</h3>
        <div class="chips">${c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        <div>${esc(c.description)}</div>
        <div class="actions">${c.pull.map((p) => `<span class="pick"><code>${esc(p)}</code> ${downloadBtn(p)}</span>`).join('')}</div>
      </div>`)
    .join('');
  wirePulls($('#catalogGrid'));
  renderRecJudges();
  renderRecommendations();
}

// ---------- ollama.com parsing (no JSON API, so we read the HTML) ----------

function parseSearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = [...doc.querySelectorAll('li a[href^="/library/"]')].map((a) => {
    const chips = [...a.querySelectorAll('span.rounded-md')].map((c) => c.textContent.trim());
    const sizes = chips.filter((c) => /^(\d|e\d|\d+x\d)/i.test(c));
    const caps = chips.filter((c) => !sizes.includes(c));
    const pullsEl = a.querySelector('[title$="downloads"]');
    return {
      name: a.getAttribute('href').replace('/library/', ''),
      desc: a.querySelector('p')?.textContent.trim() || '',
      caps: caps.filter((c) => c !== 'cloud'),
      sizes,
      cloudOnly: caps.includes('cloud') && !sizes.length,
      pulls: pullsEl?.textContent.trim() || '',
      pullsNum: Number((pullsEl?.getAttribute('title') || '').replace(/[^\d]/g, '')) || 0,
    };
  });
  return { items, hasMore: (page) => !!doc.querySelector(`[hx-get*="page=${page}"]`) };
}

function parseTags(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [];
  for (const row of doc.querySelectorAll('div.group')) {
    const tag = row.querySelector('input.command')?.value;
    if (!tag || rows.some((r) => r.tag === tag)) continue;
    const cols = [...row.querySelectorAll('p.col-span-2')].map((p) => p.textContent.trim());
    const cloud = /cloud/i.test(tag);
    if (/mlx/i.test(tag)) continue; // Apple-silicon only
    if (!cloud && (!cols[0] || cols[0] === '-')) continue;
    const age = (row.textContent.match(/\b(\d+|an?)\s+(minute|hour|day|week|month|year)s?\s+ago/i) || [''])[0];
    rows.push({ tag, size: cloud ? 0 : parseSize(cols[0]), ctx: cols[1] || '', cloud, age });
  }
  return rows;
}

// ---------- Ollama library tab ----------

let olPage = 1;
let hiddenCloud = 0;
async function ollamaSearch(more = false) {
  olPage = more ? olPage + 1 : 1;
  if (!more) $('#olResults').innerHTML = '<div class="muted">Searching…</div>';
  let parsed;
  try {
    parsed = parseSearch(await hub.discover.ollamaSearch({ q: $('#olQuery').value.trim(), c: $('#olCap').value, o: $('#olSort').value, page: olPage }));
  } catch (e) {
    $('#olResults').innerHTML = `<div class="error">Couldn't reach ollama.com: ${esc(e.message)}</div>`;
    return;
  }
  if (!more) {
    $('#olResults').innerHTML = '';
    hiddenCloud = 0;
  }
  for (const m of parsed.items) {
    if (m.cloudOnly && !state.ollamaSignedIn) {
      hiddenCloud++;
      continue; // needs an ollama.com account
    }
    const el = document.createElement('div');
    el.className = 'card result';
    el.innerHTML = `
      <div class="result-head">
        <h3>${esc(m.name)}</h3>
        <span class="muted small dl-count">${m.pulls ? icon('download') + esc(m.pulls) : ''}</span>
      </div>
      <div>${esc(m.desc)}</div>
      <div class="chips">${m.cloudOnly ? '<span class="chip cloud">☁ cloud only</span>' : ''}${m.caps.map((c) => `<span class="chip cap">${esc(c)}</span>`).join('')}${m.sizes.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      <div class="actions"><button data-act="tags">Show versions</button><button class="link" data-act="web">ollama.com ↗</button></div>
      <div class="tags"></div>`;
    el.querySelector('[data-act=web]').onclick = () => hub.discover.open(`https://ollama.com/library/${m.name}`);
    el.querySelector('[data-act=tags]').onclick = (e) => {
      e.target.remove();
      showOllamaTags(m.name, el.querySelector('.tags'));
    };
    $('#olResults').appendChild(el);
  }
  if (!$('#olResults .result')) $('#olResults').innerHTML = '<div class="muted">No models found.</div>';
  $('#olCloudNote').textContent = hiddenCloud
    ? `${hiddenCloud} cloud-only model${hiddenCloud > 1 ? 's' : ''} hidden. Sign in to Ollama.com under Settings → Accounts to use them.`
    : '';
  $('#olMore').hidden = !parsed.hasMore(olPage + 1);
}
$('#olForm').onsubmit = (e) => {
  e.preventDefault();
  ollamaSearch();
};
$('#olMore').onclick = () => ollamaSearch(true);

function optionRow(o, reason, note) {
  const fit = o.cloud ? '<span class="fit cloud" title="Runs on ollama.com with your account">☁ cloud</span>' : fitBadge(o.size);
  return `<tr><td><code>${esc(o.tag)}</code>${note ? ` <span class="muted small">(${esc(note)})</span>` : ''}</td><td>${o.cloud ? '—' : fmtSize(o.size)}</td>${o.ctx !== undefined ? `<td class="muted">${esc(o.ctx || '')}</td>` : ''}<td>${fit}</td><td>${downloadBtn(o.tag, o.cloud ? 0 : o.size, o.cloud)}</td>${reason ? `<td class="reason">${esc(reason)}</td>` : ''}</tr>`;
}

async function showOllamaTags(name, box) {
  box.innerHTML = '<div class="muted">Loading versions…</div>';
  let rows;
  try {
    rows = parseTags(await hub.discover.ollamaTags(name)).filter((r) => !r.cloud || state.ollamaSignedIn);
  } catch (e) {
    box.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    return;
  }
  box.innerHTML = rows.length
    ? `<div class="table-wrap"><table class="tag-table">${rows.map((r) => optionRow(r)).join('')}</table></div>`
    : `<div class="muted">No versions you can run${state.ollamaSignedIn ? '' : ' locally (cloud versions need an ollama.com sign-in)'}.</div>`;
  wirePulls(box);
}

// ---------- Recommendations: rules decide what fits, AI (optionally) decides what's best ----------

const REC_TTL = 6 * 3600e3;
function cacheGet(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v && Date.now() - v.t < REC_TTL) return v.d;
  } catch {}
  return null;
}
function cacheSet(key, d) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), d }));
  } catch {}
}

// Tag "qwen3:30b-a3b-q8_0" -> suffix "30b-a3b-q8_0". Default tags carry no quantization suffix.
const tagSuffix = (tag) => tag.split(':')[1] || '';
const isDefaultTag = (tag) => tagSuffix(tag) !== 'latest' && !/(q\d|fp\d|bf16|f16|int\d|mxfp|nvfp|cloud)/i.test(tagSuffix(tag));
const paramToken = (tag) => (tagSuffix(tag).match(/^(\d+x)?[\d.]+[bm]|^e[\d.]+b/i) || [''])[0].toLowerCase();

function fitOf(size) {
  const need = size * 1.15;
  if (hw.vram && need <= hw.vram) return 'gpu';
  if (need <= (hw.vram || 0) + hw.ram * 0.5) return 'gpu+ram';
  return null;
}

// Picks the versions worth offering for one model on this PC.
function chooseOptions(model, rows) {
  const local = rows.filter((r) => !r.cloud && r.size > 0);
  const defaults = local.filter((r) => isDefaultTag(r.tag));
  const pool = defaults.length ? defaults : local;
  const isMoe = (r) =>
    /^gpt-oss/.test(model.name) ||
    /(^|-)a[\d.]+b/i.test(tagSuffix(r.tag)) ||
    /^\d+x[\d.]+b/i.test(tagSuffix(r.tag)) ||
    local.some((o) => paramToken(o.tag) === paramToken(r.tag) && /(^|-)a[\d.]+b/i.test(tagSuffix(o.tag)));
  const withFit = pool.map((r) => ({ ...r, fit: fitOf(r.size), moe: isMoe(r) }));
  const gpu = withFit.filter((r) => r.fit === 'gpu').sort((a, b) => b.size - a.size);
  const options = [];
  if (gpu[0]) options.push({ ...gpu[0], role: 'best' });
  // A bigger MoE model can still run well split across GPU and RAM.
  const stretch = withFit.filter((r) => r.fit === 'gpu+ram' && r.moe && r.size > (gpu[0]?.size || 0)).sort((a, b) => b.size - a.size)[0];
  if (stretch) options.push({ ...stretch, role: 'stretch' });
  const small = gpu.filter((r) => r.size < 4e9 && r.tag !== gpu[0]?.tag).sort((a, b) => a.size - b.size)[0];
  if (small) options.push({ ...small, role: 'small' });
  if (state.ollamaSignedIn) {
    const cloud = rows.filter((r) => r.cloud).sort((a, b) => (paramToken(b.tag) > paramToken(a.tag) ? 1 : -1))[0];
    if (cloud) options.push({ ...cloud, fit: 'cloud', role: 'cloud' });
  }
  return options;
}

function category(m) {
  const text = `${m.name} ${m.desc}`;
  return {
    coding: /\bcod(e|er|ers|ing)\b|coder|\bdevelop|\bswe\b|programming|starcoder|codestral|devstral/i.test(text) && !/\bocr\b/i.test(text),
    vision: m.caps.includes('vision'),
    research: m.caps.includes('tools') && m.caps.includes('thinking'),
    general: m.caps.includes('tools'),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]).catch(() => null);
    }
  }));
  return out;
}

async function gatherCandidates(force) {
  const key = `rec:candidates:v2:${Math.round(hw.vram / 2 ** 30)}:${Math.round(hw.ram / 2 ** 30)}:${state.ollamaSignedIn ? 'cloud' : 'local'}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const queries = [
    { c: 'tools', o: 'popular' },
    { c: 'tools', o: 'popular', page: 2 },
    { c: 'tools', o: 'newest' },
    { c: 'vision', o: 'popular' },
    { q: 'coder', o: 'popular' },
    { c: 'thinking', o: 'newest' },
  ];
  setRecStatus('Fetching the latest models from ollama.com…');
  const pages = await Promise.all(queries.map((q) => hub.discover.ollamaSearch(q).then((h) => ({ q, items: parseSearch(h).items })).catch(() => ({ q, items: [] }))));
  const byName = new Map();
  for (const { q, items } of pages) {
    items.forEach((m, rank) => {
      if (m.caps.includes('embedding')) return;
      if (m.cloudOnly && !state.ollamaSignedIn) return;
      const prev = byName.get(m.name);
      const isNew = q.o === 'newest' && rank < 8;
      byName.set(m.name, { ...(prev || m), isNew: prev?.isNew || isNew });
    });
  }
  const all = [...byName.values()];
  const popular = all.filter((m) => !m.isNew).sort((a, b) => b.pullsNum - a.pullsNum).slice(0, 30);
  const fresh = all.filter((m) => m.isNew);
  const pool = [...new Map([...popular, ...fresh].map((m) => [m.name, m])).values()];
  if (!pool.length) throw new Error("Couldn't reach ollama.com");

  let done = 0;
  const results = await mapLimit(pool, 6, async (m) => {
    const tagKey = `rec:tags:${m.name}`;
    let rows = cacheGet(tagKey);
    if (!rows) {
      rows = parseTags(await hub.discover.ollamaTags(m.name));
      cacheSet(tagKey, rows);
    }
    setRecStatus(`Checking which versions fit your PC… ${++done}/${pool.length}`);
    const options = chooseOptions(m, rows);
    const updated = (rows.find((r) => r.tag === options[0]?.tag) || rows[0])?.age || '';
    return options.length ? { ...m, options, updated } : null;
  });
  const candidates = results.filter(Boolean);
  cacheSet(key, candidates);
  return candidates;
}

function setRecStatus(text) {
  $('#recStatus').textContent = text || '';
}

const GOAL_SECTIONS = {
  all: ['coding', 'research', 'general', 'vision', 'small', 'cloud'],
  coding: ['coding', 'small', 'cloud'],
  research: ['research', 'general', 'cloud'],
  general: ['general', 'small', 'cloud'],
  vision: ['vision', 'cloud'],
};
const SECTION_TITLES = {
  coding: 'Best for coding',
  research: 'Best for research & web tasks',
  general: 'Good all-rounders',
  vision: 'Images & vision',
  small: 'Fast & small (autocomplete, quick tasks)',
  cloud: 'On Ollama cloud (your account)',
};

// Rule-based sections: models that fit, ranked by popularity.
function ruleSections(candidates, goal) {
  const used = new Set();
  const byPulls = [...candidates].sort((a, b) => b.pullsNum - a.pullsNum);
  return GOAL_SECTIONS[goal]
    .map((sec) => {
      let picks = [];
      if (sec === 'small') {
        picks = byPulls.filter((m) => m.options.some((o) => o.role === 'small' || (o.role === 'best' && o.size < 4e9)))
          .map((m) => ({ m, opt: m.options.find((o) => o.role === 'small') || m.options.find((o) => o.role === 'best') }));
      } else if (sec === 'cloud') {
        picks = byPulls.filter((m) => m.options.some((o) => o.role === 'cloud') && m.caps.includes('tools')).map((m) => ({ m, opt: m.options.find((o) => o.role === 'cloud') }));
      } else {
        picks = byPulls
          .filter((m) => category(m)[sec] && !used.has(m.name) && m.options.some((o) => o.role !== 'cloud'))
          .map((m) => ({ m, opts: m.options.filter((o) => o.role === 'best' || o.role === 'stretch') }))
          .filter((p) => p.opts.length);
      }
      picks = picks.slice(0, 4);
      if (sec !== 'small' && sec !== 'cloud') picks.forEach((p) => used.add(p.m.name));
      return { title: SECTION_TITLES[sec], picks };
    })
    .filter((s) => s.picks.length);
}

function recCard(m, opts, reason) {
  const el = document.createElement('div');
  el.className = 'card rec';
  el.innerHTML = `
    <div class="result-head"><h3>${esc(m.name)}</h3><span class="muted small">${m.isNew ? '<span class="chip new">new</span> ' : ''}${m.pulls ? `<span class="dl-count">${icon('download')}${esc(m.pulls)}</span>` : ''}</span></div>
    ${reason ? `<div class="reason">${icon('sparkle')}<span>${esc(reason)}</span></div>` : ''}
    <div class="muted small">${esc(m.desc)}${m.updated ? ` · updated ${esc(m.updated)}` : ''}</div>
    <div class="chips">${m.caps.map((c) => `<span class="chip cap">${esc(c)}</span>`).join('')}</div>
    <div class="table-wrap"><table class="tag-table">${opts
      .map((o) => optionRow(o, null, o.role === 'stretch' ? 'MoE: runs well split across GPU + RAM' : ''))
      .join('')}</table></div>`;
  wirePulls(el);
  return el;
}

let recCandidates = null;
async function renderRecommendations(force = false) {
  const goal = $('#recGoal').value;
  $('#recSections').innerHTML = '';
  $('#recFallback').hidden = true;
  try {
    recCandidates = await gatherCandidates(force);
  } catch (e) {
    setRecStatus(`Couldn't load live recommendations (${e.message}). Showing the hand-picked list.`);
    $('#recFallback').hidden = false;
    $('#recFallback').open = true;
    return;
  }
  const ai = cacheGet(`rec:ai:${goal}`);
  const box = $('#recSections');
  if (ai) {
    const judge = modelInfo(ai.model);
    setRecStatus('');
    const head = document.createElement('div');
    head.className = 'ai-summary';
    head.innerHTML = `<b class="ai-by">${icon('sparkle')}Picked by ${esc(judge?.title || ai.model)}</b> <span class="muted small">${new Date(ai.at).toLocaleString()}</span><p>${esc(ai.summary)}</p><button class="link" id="recClearAi">Show the rule-based list instead</button>`;
    box.appendChild(head);
    head.querySelector('#recClearAi').onclick = () => {
      localStorage.removeItem(`rec:ai:${goal}`);
      renderRecommendations();
    };
    for (const s of ai.sections) {
      const sec = document.createElement('section');
      sec.innerHTML = `<h2>${esc(s.title)}</h2><div class="grid rec-grid"></div>`;
      for (const p of s.picks) {
        const m = recCandidates.find((c) => c.options.some((o) => o.tag === p.tag));
        if (m) sec.querySelector('.grid').appendChild(recCard(m, m.options.filter((o) => o.tag === p.tag), p.reason));
      }
      box.appendChild(sec);
    }
  } else {
    setRecStatus(`${recCandidates.length} current models fit your PC. Ranked by popularity. Press “Let AI pick” for a judged shortlist.`);
    for (const s of ruleSections(recCandidates, goal)) {
      const sec = document.createElement('section');
      sec.innerHTML = `<h2>${esc(s.title)}</h2><div class="grid rec-grid"></div>`;
      for (const p of s.picks) sec.querySelector('.grid').appendChild(recCard(p.m, p.opts || [p.opt]));
      box.appendChild(sec);
    }
  }
}
$('#recGoal').onchange = () => renderRecommendations();
$('#recRefresh').onclick = () => renderRecommendations(true);

// Which model judges: prefer Claude, then Gemini, then the strongest local tool model.
function renderRecJudges() {
  const sel = $('#recModel');
  const prev = sel.value || localStorage.getItem('rec:judge');
  const judges = state.models.filter((m) => m.provider !== 'ollama' || (m.nativeTools && !/embed/.test(m.name)));
  const rank = (m) =>
    m.provider === 'claudecode' ? (m.name === 'opus' ? -4 : -3)
      : m.provider === 'codexcli' ? -2
      : m.provider === 'antigravity' ? -1.5
      : m.provider === 'geminicli' ? -1
      : m.provider === 'anthropic' ? (/opus-5-5/.test(m.name) ? 0 : 1)
      : m.provider === 'openai' ? 2
      : m.provider === 'gemini' ? (/pro/.test(m.name) ? 3 : 4)
      : m.cloud ? 5 : 6;
  judges.sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0));
  sel.innerHTML = judges.length
    ? judges.map((m) => `<option value="${esc(m.id)}">${esc(m.provider === 'ollama' ? m.name : m.title)}${PROVIDER_SUFFIX[m.provider] || (m.cloud ? '' : ' (local)')}</option>`).join('')
    : '<option value="">(no model available)</option>';
  if (prev && judges.some((m) => m.id === prev)) sel.value = prev;
  updateRecNote();
  $('#recAi').disabled = !judges.length;
}
function updateRecNote() {
  const m = modelInfo($('#recModel').value);
  $('#recNote').textContent = !m
    ? ''
    : PLAN_PROVIDERS.includes(m.provider)
      ? 'Runs on your own plan via the official CLI (counts toward your plan limits, no API billing); no web search in this mode.'
      : m.provider === 'openai'
        ? 'OpenAI can search the web while picking. Billed to your API key: usually a few cents per pick.'
        : m.provider === 'anthropic'
          ? 'Claude can search the web for recent benchmarks while picking. Billed to your API key: roughly $0.05–0.40 per pick depending on the model and how much it searches.'
          : m.provider === 'gemini'
            ? 'Gemini can use Google Search while picking. Usually free within the AI Studio free tier, otherwise a few cents.'
            : m.cloud
              ? 'Runs on Ollama cloud: uses your free-plan quota; no web search.'
              : 'Runs locally: free and private, but small local models know little about recent models and have no web access. Treat their picks as rough.';
}
$('#recModel').onchange = () => {
  localStorage.setItem('rec:judge', $('#recModel').value);
  updateRecNote();
};

$('#recAi').onclick = async () => {
  const modelId = $('#recModel').value;
  if (!modelId || !recCandidates?.length) return;
  const goal = $('#recGoal').value;
  const btn = $('#recAi');
  btn.disabled = true;
  btn.innerHTML = `${icon('sparkle')}Thinking…`;
  setRecStatus(`${modelInfo(modelId)?.title || modelId} is reviewing ${recCandidates.length} models for your PC… (can take a minute)`);
  try {
    const compact = recCandidates.map((m) => ({
      name: m.name,
      description: m.desc,
      capabilities: m.caps,
      downloads: m.pulls,
      recently_added: !!m.isNew,
      last_updated: m.updated,
      options: m.options.map((o) => ({ tag: o.tag, size_gb: o.cloud ? null : +(o.size / 1e9).toFixed(1), fit: o.fit, moe: !!o.moe })),
    }));
    const result = await hub.recommend.ai({ modelId, goal, hw, candidates: compact });
    cacheSet(`rec:ai:${goal}`, { ...result, at: Date.now() });
    await renderRecommendations();
  } catch (e) {
    setRecStatus(`AI pick failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('sparkle')}Let AI pick`;
  }
};

// Hugging Face GGUF repos (pulled by Ollama as hf.co/<repo>:<quant>)
$('#hfForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#hfResults').innerHTML = '<div class="muted">Searching…</div>';
  let list;
  try {
    list = await hub.discover.hfSearch($('#hfQuery').value.trim());
  } catch (err) {
    $('#hfResults').innerHTML = `<div class="error">Couldn't reach Hugging Face: ${esc(err.message)}</div>`;
    return;
  }
  $('#hfResults').innerHTML = list.length ? '' : '<div class="muted">No GGUF repos found.</div>';
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'card result';
    const tags = (m.tags || []).filter((t) => !/^(gguf|region:|endpoints|license:|base_model|arxiv|dataset|autotrain|text-generation-inference|imatrix)/.test(t)).slice(0, 8);
    el.innerHTML = `
      <div class="result-head"><h3>${esc(m.id)}</h3><span class="muted small dl-count">${icon('download')}${Number(m.downloads || 0).toLocaleString()} · ♥ ${m.likes || 0}</span></div>
      <div class="chips">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      <div class="actions"><button data-act="files">Show quantizations</button><button class="link" data-act="web">huggingface.co ↗</button></div>
      <div class="tags"></div>`;
    el.querySelector('[data-act=web]').onclick = () => hub.discover.open(`https://huggingface.co/${m.id}`);
    el.querySelector('[data-act=files]').onclick = async (ev) => {
      ev.target.remove();
      const box = el.querySelector('.tags');
      box.innerHTML = '<div class="muted">Loading files…</div>';
      try {
        const info = await hub.discover.hfFiles(m.id);
        box.innerHTML =
          (info.access === 'needs-approval'
            ? `<div class="notice">Gated repo: accept the license on <a href="#" class="hf-open">its Hugging Face page</a> first, then download.</div>`
            : info.access === 'granted'
              ? '<div class="muted small">✓ You have access to this gated repo. Make sure Ollama\'s key is linked (Settings → Accounts → Hugging Face).</div>'
              : info.gated
                ? '<div class="notice">Gated repo: sign in to Hugging Face under Settings → Accounts and accept its license to download.</div>'
                : '') +
          (info.quants.length
            ? `<div class="table-wrap"><table class="tag-table">${info.quants
                .map((q) => `<tr><td><code>${esc(q.quant)}</code></td><td>${fmtSize(q.size)}</td><td>${fitBadge(q.size)}</td><td>${downloadBtn(`hf.co/${m.id}:${q.quant}`, q.size)}</td></tr>`)
                .join('')}</table></div><p class="muted small">Q4_K_M is the usual sweet spot. Q5/Q6 are a bit better and bigger; Q8/F16 are near-lossless but large.</p>`
            : '<div class="muted">No GGUF files in this repo.</div>');
        wirePulls(box);
        box.querySelector('.hf-open')?.addEventListener('click', (ev) => {
          ev.preventDefault();
          hub.discover.open(`https://huggingface.co/${m.id}`);
        });
      } catch (err) {
        box.innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    };
    $('#hfResults').appendChild(el);
  }
};

// Import a local .gguf file
$('#impBrowse').onclick = async () => {
  const f = await hub.settings.pickFile();
  if (!f) return;
  $('#impFile').value = f;
  if (!$('#impName').value) {
    $('#impName').value = f.split(/[\\/]/).pop().replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  }
};
$('#impGo').onclick = () => {
  const file = $('#impFile').value.trim().replace(/^"|"$/g, '');
  const name = $('#impName').value.trim().toLowerCase();
  if (!file || !name) return;
  if (!/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._-]+)?$/.test(name)) {
    $('#impName').setCustomValidity('Use lowercase letters, numbers, . _ - and an optional :tag');
    $('#impName').reportValidity();
    return;
  }
  $('#impName').setCustomValidity('');
  startPull(name, () => hub.models.importFile(file, name));
};

// ---------------- settings ----------------

async function loadSettings() {
  const s = await hub.settings.get();
  $('#setCtx').value = s.numCtx;
  $('#setSystem').value = s.systemPrompt;
  $('#setWorkspace').value = s.workspaceDir;
  $('#setPerm').value = s.permissionMode;
  $('#permMode').value = s.permissionMode;
  $('#setTheme').value = s.theme;
  $('#setHandoff').value = s.handoff;
  $('#setRepoKnowledge').checked = s.repoKnowledge;
  $('#setTrace').checked = s.tracePlugin;
  $('#setFactModel').innerHTML = '<option value="">No AI summary (facts only)</option>' +
    state.models.filter((m) => !/embed/.test(m.name)).map((m) => `<option value="${esc(m.id)}">${esc(m.provider === 'ollama' ? m.name : m.title)}${PROVIDER_SUFFIX[m.provider] || (m.cloud ? '' : ' (local)')}</option>`).join('');
  $('#setFactModel').value = s.factSheetModel || '';
  refreshTraceStatus();
  $('#setCacheTtl').value = s.claudeCacheTtl;
  state.settings = s;
  $('#setReviewer').checked = s.reviewerEnabled;
  const locals = state.models.filter((m) => m.local);
  $('#setReviewerModel').innerHTML = `<option value="">Automatic (smallest suitable installed model)</option>` +
    locals.map((m) => `<option value="${esc(m.name)}">${esc(m.name)} (${fmtSize(m.size)})</option>`).join('');
  $('#setReviewerModel').value = s.reviewerModel;

  const allModelOpts =
    `<option value="">Use active chat model (default)</option>` +
    state.models
      .filter((m) => !/embed/.test(m.name))
      .map((m) => `<option value="${esc(m.id)}">${esc(m.provider === 'ollama' ? m.name : m.title)}${PROVIDER_SUFFIX[m.provider] || (m.cloud ? '' : ' (local)')}</option>`)
      .join('');
  if ($('#setMerger')) $('#setMerger').checked = !!s.mergerEnabled;
  if ($('#setMergerAutoSend')) $('#setMergerAutoSend').checked = s.mergerAutoSend !== false;
  if ($('#setMergerModel')) {
    $('#setMergerModel').innerHTML = allModelOpts;
    $('#setMergerModel').value = s.mergerModel || '';
  }
  if ($('#setMergerTarget')) $('#setMergerTarget').value = s.mergerTargetBranch || 'main';
  if ($('#setTester')) $('#setTester').checked = !!s.testerEnabled;
  if ($('#setTesterAutoSend')) $('#setTesterAutoSend').checked = s.testerAutoSend !== false;
  if ($('#setTesterModel')) {
    $('#setTesterModel').innerHTML = allModelOpts;
    $('#setTesterModel').value = s.testerModel || '';
  }
  if ($('#setTesterCmd')) $('#setTesterCmd').value = s.testerCommand || '';
  if (typeof syncSpecialistAgentControls === 'function') syncSpecialistAgentControls();

  $('#allowRules').innerHTML = s.allowRules.length
    ? s.allowRules.map((r, i) => `<span class="chip">${esc(r)} <button class="x" data-i="${i}" title="Remove">✕</button></span>`).join('')
    : '<span class="muted">None yet. Choose "Always allow" on an approval prompt to add one.</span>';
  $('#allowRules').querySelectorAll('.x').forEach((b) => (b.onclick = async () => {
    const rules = s.allowRules.filter((_, i) => i !== Number(b.dataset.i));
    await hub.settings.set({ allowRules: rules });
    loadSettings();
  }));
  refreshAccounts();
}
$('#saveSettings').onclick = async () => {
  await hub.settings.set({
    numCtx: Number($('#setCtx').value) || 16384,
    systemPrompt: $('#setSystem').value,
    workspaceDir: $('#setWorkspace').value.trim(),
    permissionMode: $('#setPerm').value,
    reviewerEnabled: $('#setReviewer').checked,
    reviewerModel: $('#setReviewerModel').value,
    mergerEnabled: $('#setMerger')?.checked ?? false,
    mergerAutoSend: $('#setMergerAutoSend')?.checked ?? true,
    mergerModel: $('#setMergerModel')?.value || '',
    mergerTargetBranch: $('#setMergerTarget')?.value.trim() || 'main',
    testerEnabled: $('#setTester')?.checked ?? false,
    testerAutoSend: $('#setTesterAutoSend')?.checked ?? true,
    testerModel: $('#setTesterModel')?.value || '',
    testerCommand: $('#setTesterCmd')?.value.trim() || '',
    handoff: $('#setHandoff').value,
    repoKnowledge: $('#setRepoKnowledge').checked,
    tracePlugin: $('#setTrace').checked,
    factSheetModel: $('#setFactModel').value,
    claudeCacheTtl: $('#setCacheTtl').value,
  });
  $('#permMode').value = $('#setPerm').value;
  state.settings = await hub.settings.get();
  if (typeof syncSpecialistAgentControls === 'function') syncSpecialistAgentControls();
  updateMeter();
  $('#settingsSaved').textContent = ' Saved.';
  setTimeout(() => ($('#settingsSaved').textContent = ''), 1500);
};
$('#setTheme').onchange = () => setTheme($('#setTheme').value);
$('#themeToggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  requestAnimationFrame(() => typeof refreshTermThemes === 'function' && refreshTermThemes());
  $('#themeToggle use').setAttribute('href', theme === 'light' ? '#i-moon' : '#i-sun');
  $('#setTheme').value = theme;
}
function setTheme(theme) {
  applyTheme(theme);
  hub.settings.set({ theme });
}
$('#pickWorkspace').onclick = async () => {
  const dir = await hub.settings.pickFolder();
  if (dir) $('#setWorkspace').value = dir;
};
$('#permMode').onchange = () => hub.settings.set({ permissionMode: $('#permMode').value });

// ---------------- accounts ----------------

async function refreshAccounts() {
  document.querySelectorAll('.acct-status').forEach((el) => (el.textContent = 'checking…'));
  const st = await hub.accounts.status();
  for (const card of document.querySelectorAll('.account')) {
    const s = st[card.dataset.provider];
    const el = card.querySelector('.acct-status');
    el.className = 'acct-status ' + (s.connected ? 'ok' : 'off');
    el.textContent = s.connected
      ? `● connected${s.name ? ` as ${s.name}` : s.source ? ` (${s.source})` : ''}`
      : s.hasKey ? '● key rejected' : '○ not connected';
    el.title = s.error || '';
    card.querySelector('.remove').hidden = !s.hasKey;
  }
  const CLI_NAMES = { claudecode: 'Claude Code', codexcli: 'Codex', geminicli: 'Gemini CLI', antigravity: 'Antigravity' };
  const CLI_INSTALL = { claudecode: 'Install Claude Code first, then sign in here.', codexcli: 'Install it first: npm i -g @openai/codex', geminicli: 'Install it first: npm i -g @google/gemini-cli', antigravity: 'Install it from Settings → Check dependencies (winget: Google.AntigravityCLI).' };
  for (const card of document.querySelectorAll('.account-cli')) {
    const id = card.dataset.cli;
    const c = st[id] || {};
    const el = card.querySelector('.acct-status');
    el.className = 'acct-status ' + (c.blocked ? 'bad' : c.loggedIn ? 'ok' : 'off');
    el.textContent = !c.installed ? '○ not installed' : c.blocked ? '⚠ account not supported' : c.loggedIn ? `● signed in${c.plan ? ` (${c.plan} plan)` : ''}` : '○ not signed in';
    card.querySelector('.signin').hidden = !c.installed || c.loggedIn;
    card.querySelector('.signout').hidden = !c.loggedIn;
    card.querySelector('.cli-hint').textContent = !c.installed
      ? CLI_INSTALL[id]
      : c.blocked
        ? c.error
      : c.loggedIn && c.method && !['claude.ai', 'chatgpt', 'google'].includes(c.method)
        ? `Note: ${CLI_NAMES[id]} is signed in with ${c.method}, not a plan, so usage is billed to that account.`
        : '';
  }
  const o = st.ollama;
  const oc = $('.account-ollama');
  const oel = oc.querySelector('.acct-status');
  oel.className = 'acct-status ' + (o.signedIn ? 'ok' : 'off');
  oel.textContent = o.signedIn ? `● signed in as ${o.name} (${o.plan} plan)` : o.error ? `○ ${o.error}` : '○ not signed in';
  oc.querySelector('.signin').hidden = !!o.signedIn;
  oc.querySelector('.signout').hidden = !o.signedIn;
  setOllamaSignedIn(!!o.signedIn);
}
function setOllamaSignedIn(v) {
  if (state.ollamaSignedIn === v) return;
  state.ollamaSignedIn = v;
  $('#olResults').innerHTML = ''; // re-search with/without cloud models next time
}
{
  const oc = $('.account-ollama');
  oc.querySelector('.signin').onclick = async () => {
    const el = oc.querySelector('.acct-status');
    try {
      await hub.accounts.ollamaSignin();
      el.textContent = 'Finish signing in in your browser…';
      // Poll until the browser flow links this PC.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await hub.accounts.status();
        if (st.ollama.signedIn) break;
      }
    } catch (e) {
      el.textContent = `○ ${e.message}`;
      return;
    }
    await refreshAccounts();
    loadModels();
  };
  oc.querySelector('.signout').onclick = async () => {
    await hub.accounts.ollamaSignout();
    await refreshAccounts();
  };
  oc.querySelector('.link').onclick = (e) => hub.accounts.open(e.target.dataset.url);
  for (const card of document.querySelectorAll('.account-cli')) {
    const id = card.dataset.cli;
    card.querySelector('.signin').onclick = async () => {
      const el = card.querySelector('.acct-status');
      let session;
      try {
        session = await startCliLogin(id);
      } catch (e) {
        el.textContent = `○ ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
        return;
      }
      el.textContent = 'Finish signing in in the Terminal panel →';
      // Check only this CLI, and not too often.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        if ((await hub.accounts.cliStatus(id))?.loggedIn) break;
        if (ptyState.sessions.get(session.id)?.exited !== false) break; // sign-in tab closed or finished
      }
      await refreshAccounts();
      loadModels();
    };
    card.querySelector('.signout').onclick = async () => {
      await hub.accounts.cliLogout(id);
      await refreshAccounts();
      loadModels();
    };
    card.querySelector('.link').onclick = (e) => hub.accounts.open(e.target.dataset.url);
  }
  $('.test-ssh').onclick = async (e) => {
    const btn = e.target;
    const out = $('.ssh-result');
    btn.disabled = true;
    out.className = 'muted small ssh-result';
    out.textContent = 'Connecting to hf.co with Ollama\'s key…';
    try {
      const r = await hub.accounts.testHfSsh();
      if (r.linked) {
        out.className = 'small ssh-result ok';
        out.textContent = `✓ Linked to Hugging Face account "${r.user}". Ollama can download gated and private models this account has access to.` +
          (r.otherAccount ? ` Note: your saved token belongs to "${r.otherAccount}", a different account.` : '');
      } else {
        out.className = 'small ssh-result bad';
        out.textContent = `✕ Not linked. ${r.error || ''}`;
      }
    } catch (err) {
      out.className = 'small ssh-result bad';
      out.textContent = `✕ ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
    }
    btn.disabled = false;
  };
  $('.copy-ssh').onclick = async (e) => {
    try {
      await hub.accounts.copySshKey();
      e.target.textContent = '✓ Key copied. Paste it on the Hugging Face page that just opened.';
    } catch (err) {
      e.target.textContent = err.message;
    }
  };
}
for (const card of document.querySelectorAll('.account')) {
  const provider = card.dataset.provider;
  card.querySelector('.save').onclick = async () => {
    const key = card.querySelector('.key').value.trim();
    if (!key) return;
    card.querySelector('.acct-status').textContent = 'checking…';
    await hub.accounts.setKey(provider, key);
    card.querySelector('.key').value = '';
    await refreshAccounts();
    loadModels();
  };
  card.querySelector('.remove').onclick = async () => {
    await hub.accounts.setKey(provider, null);
    await refreshAccounts();
    loadModels();
  };
  card.querySelector('.link').onclick = (e) => hub.accounts.open(e.target.dataset.url);
}

// ---------------- workspace, titlebar status & live agent visibility ----------------

async function refreshWorkspaceUi() {
  const cwd = await hub.terminal.cwd().catch(() => '');
  state.cwd = cwd || '';
  if ($('#termCwd')) $('#termCwd').textContent = state.cwd;
  const top = state.cwd ? await hub.git.detect(state.cwd).catch(() => null) : null;
  state.repoRoot = top || '';
  let branch = '';
  let dirty = 0;
  if (top) {
    const info = await hub.git.info(top).catch(() => null);
    if (info) {
      branch = info.detached ? 'HEAD' : info.branch || '';
      dirty = info.files?.length || 0;
    }
  }
  state.branch = branch;

  const folderLabel = baseName(state.cwd) || 'workspace';
  const cwdTitle = `Working directory: ${state.cwd || 'workspace'} (click to change folder)`;
  if ($('#cwdPillText')) $('#cwdPillText').textContent = folderLabel;
  if ($('#cwdPill')) $('#cwdPill').title = cwdTitle;
  if ($('#tbWorkspaceLabel')) $('#tbWorkspaceLabel').textContent = folderLabel;
  if ($('#tbWorkspacePill')) $('#tbWorkspacePill').title = cwdTitle;

  const branchLabel = branch ? `${branch}${dirty ? ` · ${dirty}*` : ''}` : '';
  if ($('#branchPill')) {
    $('#branchPill').hidden = !branch;
    $('#branchPill').title = top ? `Git repo: ${top} (${branchLabel}) — click to open Git panel` : '';
  }
  if ($('#branchPillText')) $('#branchPillText').textContent = branchLabel;
  if ($('#tbBranchPill')) {
    $('#tbBranchPill').hidden = !branch;
    $('#tbBranchPill').title = top ? `Git repo: ${top} (${branchLabel}) — click to open Git panel` : '';
  }
  if ($('#tbBranchLabel')) $('#tbBranchLabel').textContent = branchLabel;

  renderTitlebarStatus();
  renderActivityBar();
}

async function pickWorkingFolder() {
  const dir = await hub.settings.pickFolder();
  if (!dir) return;
  await hub.terminal.setCwd(dir);
  if (state.chat) state.chat.cwd = dir;
  await refreshWorkspaceUi();
  renderChatList();
}
$('#cwdPill')?.addEventListener('click', pickWorkingFolder);
$('#tbWorkspacePill')?.addEventListener('click', pickWorkingFolder);

async function openRepoInGitPanel() {
  if (state.repoRoot) {
    await hub.git.add(state.repoRoot).catch(() => {});
  }
  openPanel('git');
  if (typeof gitActivate === 'function') gitActivate();
}
$('#branchPill')?.addEventListener('click', openRepoInGitPanel);
$('#tbBranchPill')?.addEventListener('click', openRepoInGitPanel);

function renderTitlebarStatus() {
  const box = $('#tbStatusCenter');
  if (!box) return;
  const approvals = [...(state.approvals?.values() || [])];
  if (approvals.length > 0) {
    const first = approvals[0];
    box.innerHTML = `<button class="tb-status-pill approval" title="Click to jump to the chat waiting for your decision">${icon('alert')}<span><b>${approvals.length === 1 ? 'Decision needed' : `${approvals.length} decisions needed`}</b> · ${esc(first.chatTitle || 'Chat')} (${esc(first.title)})</span></button>`;
    box.querySelector('button').onclick = () => openChat(first.chatId);
    return;
  }
  const ta = state.agentQueue?.testerActive;
  const tq = state.agentQueue?.testerQueue || [];
  if (ta) {
    const stageStr = ta.stepIndex && ta.stepTotal ? ` (Stage ${ta.stepIndex}/${ta.stepTotal})` : '';
    const qStr = tq.length ? ` · +${tq.length} in queue` : '';
    box.innerHTML = `<button class="tb-status-pill working" title="Tester Agent running CI pipeline — click to view"><span class="busy-dot"></span><span><b>🧪 Testing ${esc(ta.label)}</b>${esc(stageStr)}${esc(qStr)}</span></button>`;
    box.querySelector('button').onclick = () => (ta.chatId ? openChat(ta.chatId) : openPanel('git'));
    return;
  }
  const ma = state.agentQueue?.mergerActive;
  const mq = state.agentQueue?.mergerQueue || [];
  if (ma) {
    const qStr = mq.length ? ` · +${mq.length} in queue` : '';
    box.innerHTML = `<button class="tb-status-pill working" title="Merger Agent checking branches — click to view"><span class="busy-dot"></span><span><b>🔀 Merger: ${esc(ma.label)}</b>${esc(qStr)}</span></button>`;
    box.querySelector('button').onclick = () => (ma.chatId ? openChat(ma.chatId) : openPanel('git'));
    return;
  }
  if (state.busy.size > 0) {
    const firstId = [...state.busy][0];
    const act = state.activities.get(firstId);
    const where = act?.cwd ? ` in ${baseName(act.cwd)}` : '';
    const step = act?.label || 'Working…';
    box.innerHTML = `<button class="tb-status-pill working" title="Click to open the active agent chat"><span class="busy-dot"></span><span><b>${state.busy.size === 1 ? '1 agent working' : `${state.busy.size} agents working`}</b> · ${esc(step)}${esc(where)}</span></button>`;
    box.querySelector('button').onclick = () => openChat(firstId);
    return;
  }
  const activePulls = [...state.pulls.values()].filter((p) => !p.done);
  if (activePulls.length > 0) {
    const p = activePulls[0];
    const pctStr = p.pct != null ? ` ${p.pct.toFixed(0)}%` : '';
    box.innerHTML = `<button class="tb-status-pill working" title="Click to view download progress">${icon('download')}<span>Downloading <b>${esc(p.name)}</b>${esc(pctStr)}${p.speed ? ` · ${esc(fmtSpeed(p.speed))}` : ''}</span></button>`;
    box.querySelector('button').onclick = () => showView('discover');
    return;
  }
  const dotColor = state.ollamaRunning ? 'var(--ok)' : 'var(--warn)';
  const label = state.ollamaRunning ? `Ollama ${state.ollamaVersion || 'ready'}` : 'Ollama offline';
  box.innerHTML = `<div class="tb-status-pill" title="System status"><span class="dot" style="background:${dotColor};width:6px;height:6px;border-radius:50%"></span><span>${esc(label)} · ${esc(baseName(state.cwd) || 'Ready')}</span></div>`;
}

function setActivity(chatId, patch) {
  const prev = state.activities.get(chatId) || { startedAt: Date.now(), cwd: state.cwd };
  const next = { ...prev, ...patch };
  state.activities.set(chatId, next);
  renderActivityBar();
  renderTitlebarStatus();
  renderChatList();
}

function renderActivityBar() {
  const bar = $('#agentActivityBar');
  if (!bar) return;
  const chatId = state.chat?.id;
  if (!chatId) {
    bar.hidden = true;
    return;
  }
  const pendingApp = [...(state.approvals?.values() || [])].find((a) => a.chatId === chatId);
  const busy = state.busy.has(chatId);
  if (!busy && !pendingApp) {
    bar.hidden = true;
    return;
  }
  const act = state.activities.get(chatId) || { label: 'Working…', cwd: state.chat?.cwd || state.cwd, startedAt: Date.now() };
  const elapsedSec = Math.max(0, Math.floor((Date.now() - (act.startedAt || Date.now())) / 1000));
  const elapsedStr = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
  const cwdPath = pendingApp?.cwd || act.cwd || state.chat?.cwd || state.cwd;
  const label = pendingApp ? `Waiting for your decision: ${pendingApp.title}` : act.label || 'Working…';
  const target = pendingApp ? pendingApp.detail : act.target || '';
  const panel = pendingApp ? (pendingApp.tool === 'run_command' ? 'terminal' : null) : act.panel;

  bar.hidden = false;
  bar.classList.toggle('approval', !!pendingApp);
  bar.innerHTML = `
    <span class="act-orb"></span>
    <span class="act-label">${esc(label)}</span>
    ${target ? `<code class="act-target" title="${esc(target)}">${esc(target.slice(0, 90))}</code>` : ''}
    ${cwdPath ? `<span class="act-cwd" title="Working in ${esc(cwdPath)}">${icon('folder')}${esc(baseName(cwdPath))}</span>` : ''}
    <span class="act-timer">${esc(elapsedStr)}</span>
    ${panel ? `<button type="button" class="mini" data-open-panel="${esc(panel)}">Open ${esc(panel)} →</button>` : ''}`;
  bar.querySelector('[data-open-panel]')?.addEventListener('click', (e) => {
    const p = e.currentTarget.dataset.openPanel;
    openPanel(p);
    if (p === 'terminal') selectTerm('ai');
  });
}

setInterval(() => {
  if (state.busy.size > 0 || state.approvals?.size > 0) {
    const timerEl = $('#agentActivityBar .act-timer');
    const act = state.chat && state.activities.get(state.chat.id);
    if (timerEl && act?.startedAt) {
      const s = Math.max(0, Math.floor((Date.now() - act.startedAt) / 1000));
      timerEl.textContent = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    }
  }
}, 1000);

// ---------------- chats ----------------

function shortModelName(modelId) {
  if (!modelId) return '';
  const m = modelInfo(modelId);
  if (m) return m.provider === 'ollama' ? m.name : m.title;
  return String(modelId).split(':').slice(1).join(':') || modelId;
}

async function renderChatList() {
  const chats = await hub.chats.list();
  const ul = $('#chatList');
  if (!ul) return;
  ul.innerHTML = '';

  const approvalCount = state.approvals?.size || 0;
  const tqCount = (state.agentQueue?.testerQueue?.length || 0) + (state.agentQueue?.mergerQueue?.length || 0);
  const busyCount = state.busy.size;
  const summaryEl = $('#chatStatusSummary');
  if (summaryEl) {
    if (approvalCount > 0) {
      summaryEl.className = 'section-meta warn';
      summaryEl.textContent = `${approvalCount} decision${approvalCount > 1 ? 's' : ''} needed`;
    } else if (busyCount > 0 || tqCount > 0) {
      summaryEl.className = 'section-meta';
      summaryEl.textContent = tqCount > 0 ? `${busyCount} working · ${tqCount} queued` : `${busyCount} working`;
    } else {
      summaryEl.className = 'section-meta';
      summaryEl.textContent = '';
    }
  }

  for (const c of chats) {
    const li = document.createElement('li');
    const isActive = state.view === 'chat' && state.chat?.id === c.id;
    const isBusy = state.busy.has(c.id);
    const pendingApp = [...(state.approvals?.values() || [])].find((a) => a.chatId === c.id);
    const act = state.activities.get(c.id);
    const testerActiveHere = state.agentQueue?.testerActive?.chatId === c.id ? state.agentQueue.testerActive : null;
    const testerQueuedHere = (state.agentQueue?.testerQueue || []).find((q) => q.chatId === c.id);
    const mergerActiveHere = state.agentQueue?.mergerActive?.chatId === c.id ? state.agentQueue.mergerActive : null;
    const mergerQueuedHere = (state.agentQueue?.mergerQueue || []).find((q) => q.chatId === c.id);

    const folder = baseName(pendingApp?.cwd || act?.cwd || c.cwd);
    const modelShort = shortModelName(c.model);

    li.classList.toggle('active', isActive);
    li.classList.toggle('needs-approval', !!pendingApp);
    li.classList.toggle('is-working', isBusy || !!testerActiveHere || !!mergerActiveHere);

    let statusHtml = '';
    if (pendingApp) {
      statusHtml = `<div class="chat-status approval ${pendingApp.risk === 'dangerous' ? 'dangerous' : ''}" title="${esc(pendingApp.detail || pendingApp.reason)}">⚠ Decision needed: ${esc(pendingApp.title)}</div>`;
    } else if (testerActiveHere) {
      const stg = (testerActiveHere.stages || []).find((s) => s.status === 'running');
      const stgText = testerActiveHere.stepIndex && testerActiveHere.stepTotal
        ? `Stage ${testerActiveHere.stepIndex}/${testerActiveHere.stepTotal}${stg ? `: ${stg.label}` : ''}`
        : testerActiveHere.stepText || 'Running CI tests…';
      statusHtml = `<div class="chat-status tester-working" title="${esc(testerActiveHere.liveLine || stgText)}">🧪 Tester working · ${esc(stgText)}</div>`;
    } else if (testerQueuedHere) {
      statusHtml = `<div class="chat-status tester-queued" title="Waiting in Tester Agent single-MR queue">⏳ Tester Queue #${testerQueuedHere.position} (waiting)</div>`;
    } else if (mergerActiveHere) {
      statusHtml = `<div class="chat-status tester-working" title="${esc(mergerActiveHere.stepText || 'Checking branch conflicts')}">🔀 Merger working · ${esc(mergerActiveHere.stepText || 'checking main')}</div>`;
    } else if (mergerQueuedHere) {
      statusHtml = `<div class="chat-status tester-queued" title="Waiting in Merger Agent queue">⏳ Merger Queue #${mergerQueuedHere.position}</div>`;
    } else if (isBusy) {
      const stepText = act ? `${act.label}${act.target ? `: ${act.target.slice(0, 26)}` : ''}` : 'Working…';
      statusHtml = `<div class="chat-status working" title="${esc(act?.target || stepText)}">${esc(stepText)}</div>`;
    }

    const dotHtml = pendingApp
      ? '<span class="warn-dot" title="Waiting for your decision"></span>'
      : isBusy || testerActiveHere || mergerActiveHere
        ? '<span class="busy-dot" title="Agent is working"></span>'
        : testerQueuedHere || mergerQueuedHere
          ? '<span class="warn-dot" title="Queued for Tester/Merger"></span>'
          : '';

    li.innerHTML = `
      <div class="chat-item-top">
        ${dotHtml}
        <span class="t">${esc(c.title)}</span>
        <button class="del" title="Delete chat">✕</button>
      </div>
      ${
        modelShort || folder
          ? `<div class="chat-item-meta">
              ${modelShort ? `<span>${esc(modelShort)}</span>` : ''}
              ${folder ? `<span class="folder-tag" title="${esc(pendingApp?.cwd || act?.cwd || c.cwd || '')}">📁 ${esc(folder)}</span>` : ''}
            </div>`
          : ''
      }
      ${statusHtml}`;
    li.onclick = () => openChat(c.id);
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      await hub.chats.remove(c.id);
      if (state.chat?.id === c.id) {
        state.chat = null;
        renderChat();
      }
      renderChatList();
    };
    ul.appendChild(li);
  }
}

async function newChat(model) {
  model = model || $('#modelSelect').value || state.models[0]?.name;
  state.chat = await hub.chats.create(model);
  showView('chat');
  renderChat();
  $('#input').focus();
}
$('#newChatBtn').onclick = () => newChat();
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  }
});

async function openChat(id) {
  closeCompact();
  state.chat = await hub.chats.get(id);
  showView('chat');
  renderChat();
}

function renderModelSelect() {
  const sel = $('#modelSelect');
  const current = state.chat?.model || sel.value;
  sel.innerHTML = state.models.length
    ? Object.entries(PROVIDER_LABEL)
      .map(([p, label]) => {
        const ms = state.models.filter((m) => groupOf(m) === p);
        return ms.length ? `<optgroup label="${esc(label)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.provider === 'ollama' ? m.name : m.title)}${m.local ? ` — ${esc(m.title)}` : ''}</option>`).join('')}</optgroup>` : '';
      })
      .join('')
    : '<option value="">(no models — open the Library)</option>';
  if (current && state.models.some((m) => m.id === current)) sel.value = current;
  updateModelHint();
  if (typeof syncSpecialistAgentControls === 'function') syncSpecialistAgentControls();
}
// ---------- effort ----------
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL = { '': 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra-high effort', max: 'Max effort' };
function clampEffort(effort, supported) {
  if (!effort || !supported?.length) return '';
  if (supported.includes(effort)) return effort;
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= EFFORT_ORDER.indexOf(effort));
  return below.length ? below[below.length - 1] : supported[0];
}
// The chat keeps the level you chose; each model gets the closest level it supports.
function renderEffort() {
  const m = modelInfo($('#modelSelect').value);
  const levels = m?.efforts || [];
  const wanted = state.chat?.effort ?? state.effort ?? '';
  const sel = $('#effortSelect');
  sel.innerHTML = ['', ...levels].map((l) => `<option value="${l}">${EFFORT_LABEL[l]}</option>`).join('');
  sel.value = clampEffort(wanted, levels);
  sel.disabled = !levels.length;
  const extra =
    m?.provider === 'anthropic' ? ' Changing it mid-chat makes Claude re-read the chat without the prompt cache once.'
    : m?.provider === 'ollama' && !levels.includes('medium') ? ' For this model, Low turns thinking off and High turns it on.'
    : '';
  $('#effortPill').title = levels.length
    ? `How hard ${m.name} thinks before answering. Higher = better on hard problems, but slower and (for paid models) more tokens.${extra}`
    : `${m ? m.name : 'This model'} has no effort setting.`;
  $('#effortPill').classList.toggle('disabled', !levels.length);
}
$('#effortSelect').onchange = () => {
  state.effort = $('#effortSelect').value;
  if (state.chat) state.chat.effort = state.effort;
};

function updateModelHint() {
  renderEffort();
  const m = modelInfo($('#modelSelect').value);
  $('#modelHint').textContent = m ? `${m.description || ''}${m.nativeTools ? '' : '  (no native tool calling — tools work through a text protocol, less reliably)'}` : '';
}
$('#modelSelect').onchange = () => {
  // Switching only changes who answers next; history is untouched.
  if (state.chat) state.chat.model = $('#modelSelect').value;
  updateModelHint();
  updateMeter();
};

const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
function statsText(st) {
  if (!st) return '';
  const parts = [];
  if (st.outputTokens && st.ms) parts.push(`${(st.outputTokens / (st.ms / 1000)).toFixed(1)} tok/s`);
  if (st.inputTokens) {
    const pct = st.cacheRead ? Math.round((100 * st.cacheRead) / st.inputTokens) : 0;
    parts.push(`${fmtTok(st.inputTokens)} in${pct ? ` · ${pct}% cached` : ''}`);
  }
  if (st.plan) parts.push(`on your ${st.plan === true ? 'Claude' : st.plan} plan`);
  return parts.join(' · ');
}

function toolArgs(tc) {
  const a = tc.arguments || {};
  if (tc.name === 'run_command') return a.command;
  if (tc.name === 'write_file') return `${a.path} (${(a.content || '').length} chars)`;
  const s = JSON.stringify(a);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function messageEl(m, i, all) {
  const el = document.createElement('div');
  if (m.kind === 'switch') {
    el.className = 'switch';
    el.textContent = `Switched ${m.from} → ${m.to} · conversation carried over`;
    return el;
  }
  if (m.kind === 'compacted') {
    el.className = 'switch compacted';
    el.innerHTML = `<span>Compacted ~${fmtTok(m.before)} → ~${fmtTok(m.after)} tokens</span><button class="link undo-compact">Undo</button>`;
    el.querySelector('.undo-compact').onclick = async () => {
      state.chat = await hub.chats.compactUndo(state.chat.id);
      renderChat();
    };
    return el;
  }
  if (m.kind === 'summary') {
    el.className = 'summary-msg';
    el.innerHTML = `<div class="summary-head">${icon('compress')}<b>Summary</b><span class="muted small">turns ${m.turns?.[0]}–${m.turns?.[1]} · ${esc(m.title || '')}</span></div><div class="body">${markdown(m.content.replace(/^\[Summary[^\]]*\]\n?/, ''))}</div>`;
    return el;
  }
  if (m.kind === 'agent_report') {
    const r = m.report || {};
    const isMerger = r.agent === 'merger';
    const v = r.verdict || r.status || 'warn';
    const cls = v === 'clean' || v === 'merged' || v === 'pass' ? 'pass' : v === 'conflict' || v === 'fail' ? 'fail' : 'warn';
    const badgeLabel = isMerger
      ? v === 'merged'
        ? '✓ Merged cleanly'
        : v === 'clean'
          ? '✓ No conflicts'
          : '⚠ Merge Conflict'
      : v === 'pass'
        ? '✓ Tests Passed'
        : v === 'fail'
          ? '✕ Tests Failed'
          : '⚠ Check Warning';
    const modelName = shortModelName(r.model) || r.model || 'AI';
    const metaInfo = isMerger
      ? `<code>${esc(r.branch || 'branch')}</code> → <code>${esc(r.targetBranch || 'main')}</code>`
      : r.command
        ? `<code>${esc(r.command)}</code> (exit ${esc(r.exitCode ?? 0)})`
        : '';

    let itemsHtml = '';
    if (isMerger && Array.isArray(r.conflicts) && r.conflicts.length) {
      itemsHtml = `<div class="agent-report-items">${r.conflicts
        .map(
          (c) => `<div class="agent-report-item">
            <div><b>Conflict in</b> <code>${esc(c.file)}</code></div>
            ${c.cause ? `<div class="muted">${esc(c.cause)}</div>` : ''}
            ${c.resolution ? `<div><b>Suggested resolution:</b> ${esc(c.resolution)}</div>` : ''}
          </div>`
        )
        .join('')}</div>`;
    } else if (!isMerger && Array.isArray(r.failures) && r.failures.length) {
      itemsHtml = `<div class="agent-report-items">${r.failures
        .map(
          (f) => `<div class="agent-report-item">
            <div><b>${esc(f.test_or_file || f.test || 'Check')}</b> ${f.file ? `in <code>${esc(f.file)}</code>` : ''}</div>
            ${f.root_cause || f.reason ? `<div class="muted">${esc(f.root_cause || f.reason)}</div>` : ''}
            ${f.suggested_fix || f.fix ? `<div><b>Suggested fix:</b> ${esc(f.suggested_fix || f.fix)}</div>` : ''}
          </div>`
        )
        .join('')}</div>`;
    }

    let stepsHtml = '';
    if (!isMerger && Array.isArray(r.steps) && r.steps.length > 0) {
      stepsHtml = `<div class="agent-report-items">${r.steps
        .map(
          (s, idx) => `<div class="branch-check-row">
            <span class="chip ${s.passed ? 'loaded' : ''}" style="${s.passed ? '' : 'color:var(--danger);border-color:var(--danger)'}">${s.passed ? '✓ PASS' : `✕ FAIL (${s.exitCode})`}</span>
            <b>Stage ${idx + 1}/${r.steps.length}:</b> <code>${esc(s.command)}</code>
            <span class="muted small">${esc(s.label || '')} · ${((s.durationMs || 0) / 1000).toFixed(1)}s</span>
          </div>`
        )
        .join('')}</div>`;
    }

    const rawOut = r.rawOutput || r.output || '';
    const needsAction = v === 'conflict' || v === 'fail' || v === 'warn';
    el.className = `agent-report ${cls}`;
    el.innerHTML = `
      <div class="agent-report-head">
        <b>${icon(isMerger ? 'branch' : 'activity')} ${isMerger ? 'Merger Agent' : 'Tester Agent'}</b>
        <span class="agent-report-badge">${esc(badgeLabel)}</span>
        <span class="chip">${esc(modelName)}</span>
        <span class="muted small">${metaInfo}</span>
      </div>
      ${r.summary ? `<div class="body">${markdown(r.summary)}</div>` : ''}
      ${stepsHtml}
      ${itemsHtml}
      ${rawOut ? `<details class="small"><summary class="muted">Raw test / check output</summary><pre class="code" style="max-height:200px;overflow:auto;background:var(--code-bg);padding:8px;border-radius:6px;font-family:var(--mono)">${esc(rawOut)}</pre></details>` : ''}
      ${
        needsAction
          ? m.autoTriggered
            ? `<div class="agent-report-foot"><span class="chip loaded">✓ Sent to agent automatically</span></div>`
            : `<div class="agent-report-foot">
                <button type="button" class="primary mini send-report-btn">${icon('send')} Send report to agent to fix →</button>
                <span class="muted small">Instructs this chat's model to resolve the reported issues</span>
              </div>`
          : ''
      }`;
    el.querySelector('.send-report-btn')?.addEventListener('click', async (ev) => {
      if (!state.chat) return;
      ev.currentTarget.disabled = true;
      ev.currentTarget.textContent = 'Sent to agent…';
      await hub.agents.sendReport({ chatId: state.chat.id, report: r });
    });
    return el;
  }
  if (m.role === 'user') {
    el.className = 'msg user';
    el.textContent = m.content;
    return el;
  }
  if (m.role === 'tool') {
    el.innerHTML = `<details class="tool ${m.is_error ? 'err' : ''}"><summary>${m.is_error ? 'failed: ' : ''}result of ${esc(m.tool_name)} (${m.content.length} chars)</summary><pre>${esc(m.content)}</pre></details>`;
    return el;
  }
  el.className = 'msg assistant';
  const stats = statsText(m.stats);
  let html = `<div class="who">${esc(m.model || 'assistant')}<span class="stats">${stats}</span></div>`;
  if (m.thinking) html += `<details class="thinking"><summary>Thought process</summary><div>${esc(m.thinking)}</div></details>`;
  if (m.content) html += `<div class="body">${markdown(m.content)}</div>`;
  for (const tc of m.tool_calls || []) {
    html += `<div class="tool-call">${icon('tool')}<b>${esc(tc.name)}</b> <code>${esc(toolArgs(tc))}</code></div>`;
  }
  el.innerHTML = html;
  return el;
}

function renderChat() {
  const box = $('#messages');
  box.innerHTML = '';
  state.live = null;
  const c = state.chat;
  $('#chatTitle').value = c?.title || '';
  $('#chatTitle').disabled = !c;
  if (c?.model) renderModelSelect();
  if (!c || !c.messages.length) {
    box.innerHTML = `<div class="empty-chat"><h2>Start chatting</h2><p>Pick a model above. You can switch models mid-conversation — the next model sees everything said so far.</p><p>With Agent tools on, the model can search and browse, use the terminal and edit files; the tools panel opens when it does (or press Ctrl+J). Long chat? Use Compact to summarize and trim it.</p></div>`;
  } else {
    c.messages.forEach((m, i, all) => box.appendChild(messageEl(m, i, all)));
  }
  for (const a of state.approvals.values()) if (a.chatId === c?.id) box.appendChild(approvalEl(a));
  setBusyUi();
  updateMeter();
  renderActivityBar();
  refreshWorkspaceUi();
  box.scrollTop = box.scrollHeight;
}

$('#chatTitle').onchange = async () => {
  if (!state.chat) return;
  state.chat.title = $('#chatTitle').value;
  await hub.chats.rename(state.chat.id, state.chat.title);
  renderChatList();
};

function setBusyUi() {
  const busy = state.chat && state.busy.has(state.chat.id);
  $('#sendBtn').hidden = !!busy;
  $('#stopBtn').hidden = !busy;
  renderActivityBar();
  renderTitlebarStatus();
}

async function send() {
  const text = $('#input').value.trim();
  const model = $('#modelSelect').value;
  if (!text || !model) return;
  if (!state.chat) {
    state.chat = await hub.chats.create(model);
  }
  if (state.busy.has(state.chat.id)) return;
  $('#input').value = '';
  state.busy.add(state.chat.id);
  setActivity(state.chat.id, { phase: 'starting', label: 'Starting agent…', target: '', panel: null, model, cwd: state.cwd, startedAt: Date.now() });
  setBusyUi();
  hub.chats.send({ chatId: state.chat.id, model, text, useTools: $('#toolsToggle').checked, effort: state.chat.effort ?? state.effort ?? '' });
}
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  send();
};
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('#stopBtn').onclick = () => state.chat && hub.chats.stop(state.chat.id);

// Streaming events from the main process.
let renderQueued = false;
function scheduleLiveRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const live = state.live;
    if (!live) return;
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    live.body.innerHTML = markdown(live.text);
    live.body.classList.add('cursor');
    if (live.thinking) {
      live.think.hidden = false;
      live.thinkText.textContent = live.thinking;
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

hub.chats.onEvent((ev) => {
  const current = state.chat?.id === ev.chatId;
  const box = $('#messages');
  if (ev.cwd && ev.cwd !== state.cwd) {
    state.cwd = ev.cwd;
    refreshWorkspaceUi();
  }
  switch (ev.type) {
    case 'saved':
      if (current) {
        state.chat = ev.chat;
        renderChat();
      }
      renderChatList();
      break;
    case 'start':
      state.busy.add(ev.chatId);
      setActivity(ev.chatId, {
        phase: 'thinking',
        label: 'Thinking…',
        target: '',
        panel: null,
        model: ev.model,
        cwd: ev.cwd || state.cwd,
      });
      if (!current) break;
      {
        const el = document.createElement('div');
        el.className = 'msg assistant';
        el.innerHTML = `<div class="who">${esc(ev.model)}</div><details class="thinking" hidden open><summary>Thinking…</summary><div></div></details><div class="body cursor"></div>`;
        box.appendChild(el);
        state.live = { el, body: el.querySelector('.body'), think: el.querySelector('.thinking'), thinkText: el.querySelector('.thinking div'), text: '', thinking: '' };
        box.scrollTop = box.scrollHeight;
      }
      break;
    case 'delta':
      {
        const act = state.activities.get(ev.chatId);
        if (!act || act.phase !== 'writing') {
          setActivity(ev.chatId, { phase: 'writing', label: 'Writing response…', target: '', panel: null });
        }
      }
      if (current && state.live) {
        state.live.text += ev.text;
        scheduleLiveRender();
      }
      break;
    case 'thinking':
      {
        const act = state.activities.get(ev.chatId);
        if (!act || act.phase !== 'thinking') {
          setActivity(ev.chatId, { phase: 'thinking', label: 'Reasoning…', target: '', panel: null });
        }
      }
      if (current && state.live) {
        state.live.thinking += ev.text;
        scheduleLiveRender();
      }
      break;
    case 'message':
      if (!current) break;
      state.chat.messages.push(ev.message);
      updateMeter();
      if (state.live && ev.message.role === 'assistant') {
        state.live.el.replaceWith(messageEl(ev.message));
        state.live = null;
      } else {
        box.appendChild(messageEl(ev.message));
      }
      box.scrollTop = box.scrollHeight;
      break;
    case 'tool_call':
      setActivity(ev.chatId, {
        phase: 'tool',
        label: ev.label || `Using ${ev.name}`,
        target: ev.target || '',
        panel: ev.panel || null,
        cwd: ev.cwd || state.cwd,
      });
      // Show the user what the AI is working on.
      if (['web_search', 'open_url', 'read_page', 'click', 'type_text'].includes(ev.name)) openPanel('browser', { auto: true });
      else if (ev.name === 'run_command') {
        openPanel('terminal', { auto: true });
        selectTerm('ai');
      }
      break;
    case 'review':
      if (ev.state === 'running') {
        setActivity(ev.chatId, {
          phase: 'review',
          label: 'AI reviewer checking command',
          target: ev.command || '',
          panel: 'terminal',
          cwd: ev.cwd || state.cwd,
        });
      }
      if (current) {
        let el = box.querySelector('.review.running');
        if (ev.state === 'running') {
          el = document.createElement('div');
          el.className = 'review running';
          el.innerHTML = `${icon('shield')} AI reviewer is checking: <code>${esc(ev.command)}</code>`;
          box.appendChild(el);
        } else if (el) {
          el.className = `review ${ev.verdict}`;
          el.innerHTML = `${icon('shield')} ` + esc(ev.verdict === 'allow'
            ? `Reviewer (${ev.model}) allowed it: ${ev.reason}`
            : `Reviewer (${ev.model || 'none'}) wants your approval: ${ev.reason}`);
        }
        box.scrollTop = box.scrollHeight;
      }
      break;
    case 'notice':
      if (current) {
        const n = document.createElement('div');
        n.className = 'notice';
        n.textContent = ev.text;
        box.appendChild(n);
      }
      break;
    case 'error':
    case 'done':
      state.busy.delete(ev.chatId);
      state.activities.delete(ev.chatId);
      if (current) {
        if (state.live) {
          state.live.body.classList.remove('cursor');
          state.live = null;
        }
        if (ev.type === 'error') {
          const n = document.createElement('div');
          n.className = 'error';
          n.textContent = `Error: ${ev.text}`;
          box.appendChild(n);
        }
        setBusyUi();
      }
      renderActivityBar();
      renderTitlebarStatus();
      renderChatList();
      refreshWorkspaceUi();
      loadModels(); // refresh "in memory" state
      break;
  }
});

// ---------------- context meter ----------------

// Mirrors the main process: ~3.6 chars per token, and with "answers only"
// hand-back other models' tool traffic isn't sent.
function chatTokens(messages, modelId, handoff = 'compact') {
  const foreign = new Set();
  let chars = 0;
  for (const m of messages) {
    if (m.kind && m.kind !== 'summary') continue;
    if (handoff === 'compact' && m.role === 'assistant' && m.model && m.model !== modelId) {
      (m.tool_calls || []).forEach((tc) => foreign.add(tc.id));
      chars += (m.content || '').length + 80;
      continue;
    }
    if (m.role === 'tool' && foreign.has(m.tool_call_id)) continue;
    chars += (m.content || '').length + 12;
    for (const tc of m.tool_calls || []) chars += JSON.stringify(tc.arguments || {}).length + 30;
  }
  return Math.ceil(chars / 3.6);
}

// The context window a model gets in this app.
function windowOf(m, forCompact) {
  if (!m) return 0;
  if (m.provider === 'ollama' && !m.cloud) {
    // Chat uses the Settings window; compaction raises num_ctx as far as the model allows.
    return forCompact ? m.contextLength || 0 : Math.min(state.settings?.numCtx || 16384, m.contextLength || Infinity);
  }
  return m.contextLength || 128000;
}

function updateMeter() {
  const el = $('#ctxMeter');
  const m = modelInfo($('#modelSelect').value);
  if (!state.chat?.messages.length || !m) {
    el.hidden = true;
    return;
  }
  const used = chatTokens(state.chat.messages, m.id, state.settings?.handoff) + 1500; // + system prompt and tools
  const win = windowOf(m);
  const pct = used / win;
  el.hidden = false;
  el.className = `meter ${pct > 0.9 ? 'bad' : pct > 0.7 ? 'warn' : ''}`;
  el.innerHTML = `<span class="meter-bar"><span style="width:${Math.min(100, pct * 100).toFixed(0)}%"></span></span>~${fmtTok(used)} / ${fmtTok(win)}`;
  el.title =
    `About ${used.toLocaleString()} tokens of this chat are sent to ${m.name} on each message; its window here is ${win.toLocaleString()}.` +
    (pct > 0.9 && m.provider === 'ollama' && !m.cloud ? ' Older turns will be left out. Compact the chat or raise the context window in Settings.' : '') +
    (m.provider === 'anthropic' ? ' Repeated parts are prompt-cached, so they cost far less than new text.' : '');
}

// ---------------- compact ----------------

const compactState = { sections: null, turns: [] };

function renderTurns(messages) {
  const turns = [];
  for (const m of messages) {
    if (m.kind && m.kind !== 'summary') continue;
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(m);
  }
  return turns;
}

function openCompact() {
  if (!state.chat || state.busy.has(state.chat.id)) return;
  const turns = renderTurns(state.chat.messages);
  const tokens = chatTokens(state.chat.messages, null, 'full');
  compactState.sections = null;
  compactState.turns = turns;
  $('#messages').hidden = true;
  $('#composer').hidden = true;
  $('#compactPane').hidden = false;
  $('#compactSections').innerHTML = '';
  $('#compactFoot').hidden = true;
  $('#compactStatus').textContent = turns.length < 2 ? 'This chat is too short to compact.' : '';
  $('#compactAnalyze').disabled = turns.length < 2;
  $('#compactInfo').textContent = `${turns.length} turns · about ${fmtTok(tokens)} tokens. A model reads the whole chat and suggests what to keep, summarize or drop; you decide each section.`;

  // Models that can hold the whole transcript (+ room for the answer).
  const need = tokens + 8000;
  const rank = (m) => ({ claudecode: -3, codexcli: -2, antigravity: -1.5, geminicli: -1, anthropic: 0, openai: 1, gemini: 2 })[m.provider] ?? (m.cloud ? 3 : 4);
  const list = state.models.filter((m) => !/embed/.test(m.name)).sort((a, b) => rank(a) - rank(b) || windowOf(b, true) - windowOf(a, true));
  const prev = localStorage.getItem('compact:model');
  $('#compactModel').innerHTML = list
    .map((m) => {
      const ok = windowOf(m, true) >= need;
      const label = `${m.provider === 'ollama' ? m.name : m.title}${PLAN_PROVIDERS.includes(m.provider) ? '' : PROVIDER_SUFFIX[m.provider] || (m.cloud ? '' : ' (local)')} · ${fmtTok(windowOf(m, true))} window`;
      return `<option value="${esc(m.id)}" ${ok ? '' : 'disabled'}>${esc(label)}${ok ? '' : ' (too small)'}</option>`;
    })
    .join('');
  const firstOk = list.find((m) => windowOf(m, true) >= need);
  $('#compactModel').value = prev && list.some((m) => m.id === prev && windowOf(m, true) >= need) ? prev : firstOk?.id || '';
  if (!firstOk) $('#compactStatus').textContent = 'No available model has a big enough context window for this chat. Connect Claude, OpenAI or Gemini, or add a long-context model.';
  updateCompactNote();
}
function updateCompactNote() {
  const m = modelInfo($('#compactModel').value);
  const tokens = chatTokens(state.chat?.messages || [], null, 'full');
  $('#compactModelNote').textContent = !m
    ? ''
    : m.provider === 'ollama' && !m.cloud
      ? `Runs locally with a ${fmtTok(Math.min(131072, tokens + 6000))} token window. Long chats need a lot of VRAM and can be slow; small models write weaker summaries.`
      : m.provider === 'ollama'
        ? 'Runs on Ollama cloud with your account quota.'
        : PLAN_PROVIDERS.includes(m.provider)
          ? 'Runs on your own plan via the official CLI: counts toward your plan limits, no API billing.'
        : `Billed to your ${({ anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' })[m.provider]} API key: roughly one full read of the chat (~${fmtTok(tokens)} tokens) plus the summaries.`;
}
$('#compactModel').onchange = () => {
  localStorage.setItem('compact:model', $('#compactModel').value);
  updateCompactNote();
};

function closeCompact() {
  $('#compactPane').hidden = true;
  $('#messages').hidden = false;
  $('#composer').hidden = false;
}
$('#compactBtn').onclick = () => ($('#compactPane').hidden ? openCompact() : closeCompact());
$('#compactClose').onclick = closeCompact;
$('#compactCancel').onclick = closeCompact;

$('#compactAnalyze').onclick = async () => {
  const modelId = $('#compactModel').value;
  if (!modelId || !state.chat) return;
  const btn = $('#compactAnalyze');
  btn.disabled = true;
  $('#compactSections').innerHTML = '';
  $('#compactFoot').hidden = true;
  $('#compactStatus').textContent = `${modelInfo(modelId)?.title || modelId} is reading the chat… (long chats can take a minute or two)`;
  try {
    const r = await hub.chats.compactAnalyze(state.chat.id, modelId);
    compactState.sections = r.sections.map((s) => ({ ...s, action: s.recommendation }));
    $('#compactStatus').textContent = 'Review each section, then Apply. You can edit the summaries.';
    renderCompactSections();
  } catch (e) {
    $('#compactStatus').textContent = `Analysis failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  } finally {
    btn.disabled = false;
  }
};

function sectionPreview(s) {
  return compactState.turns
    .slice(s.first - 1, s.last)
    .map((t, i) => {
      const u = t.find((m) => m.role === 'user');
      const text = (u?.content || '').replace(/\s+/g, ' ').slice(0, 140);
      return `<li><span class="muted">${s.first + i}.</span> ${esc(text)}${(u?.content || '').length > 140 ? '…' : ''}</li>`;
    })
    .join('');
}

function renderCompactSections() {
  const box = $('#compactSections');
  box.innerHTML = '';
  compactState.sections.forEach((s, idx) => {
    const el = document.createElement('div');
    el.className = `card compact-sec act-${s.action}`;
    el.innerHTML = `
      <div class="sec-head">
        <div><h3>${esc(s.title)}</h3><span class="muted small">Turns ${s.first}${s.last !== s.first ? `–${s.last}` : ''} · ~${fmtTok(s.tokens)} tokens</span></div>
        <div class="seg">${['keep', 'summary', 'drop']
          .map((a) => `<button data-a="${a}" class="${s.action === a ? 'on' : ''}">${{ keep: 'Keep', summary: 'Summary', drop: 'Drop' }[a]}${s.recommendation === a ? ' <span class="sugg">AI</span>' : ''}</button>`)
          .join('')}</div>
      </div>
      ${s.reason ? `<div class="reason small">${icon('sparkle')}<span>${esc(s.reason)}</span></div>` : ''}
      <textarea rows="3" spellcheck="true" placeholder="Summary">${esc(s.summary)}</textarea>
      <details class="small"><summary class="muted">Show the turns in this section</summary><ol class="turn-list">${sectionPreview(s)}</ol></details>`;
    el.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => {
      s.action = b.dataset.a;
      renderCompactSections();
    }));
    el.querySelector('textarea').oninput = (e) => {
      s.summary = e.target.value;
      updateCompactResult();
    };
    box.appendChild(el);
  });
  $('#compactFoot').hidden = false;
  updateCompactResult();
}

function updateCompactResult() {
  const before = compactState.sections.reduce((n, s) => n + s.tokens, 0);
  const after = compactState.sections.reduce((n, s) => n + (s.action === 'keep' ? s.tokens : s.action === 'summary' ? Math.ceil(s.summary.length / 3.6) + 20 : 0), 0);
  const count = (a) => compactState.sections.filter((s) => s.action === a).length;
  $('#compactResult').innerHTML = `<b>~${fmtTok(before)} → ~${fmtTok(after)} tokens</b> <span class="muted small">· keep ${count('keep')} · summarize ${count('summary')} · drop ${count('drop')}</span>`;
}

$('#compactApply').onclick = async () => {
  if (!compactState.sections) return;
  try {
    const r = await hub.chats.compactApply(
      state.chat.id,
      compactState.sections.map((s) => ({ first: s.first, last: s.last, action: s.action, title: s.title, summary: s.summary }))
    );
    state.chat = r.chat;
    closeCompact();
    renderChat();
  } catch (e) {
    $('#compactStatus').textContent = `Couldn't apply: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
};


// ---------------- setup ----------------

const setupState = { items: [], busy: new Set(), lines: {} };
const RECOMMENDED = ['ollama', 'git', 'node', 'claudecode', 'codex', 'gemini'];

async function renderSetup(recheck = true) {
  if (recheck) setupState.items = await hub.setup.check();
  const box = $('#setupList');
  box.innerHTML = '';
  for (const it of setupState.items) {
    const busy = setupState.busy.has(it.id);
    const blocked = it.needs && !setupState.items.find((x) => x.id === it.needs)?.version;
    const row = document.createElement('div');
    row.className = `card setup-item ${it.version ? 'ok' : ''}`;
    row.innerHTML = `
      <div class="setup-main">
        <div class="setup-title"><b>${esc(it.name)}</b>${it.required ? '<span class="chip">required</span>' : ''}${RECOMMENDED.includes(it.id) || it.required ? '' : '<span class="chip">optional</span>'}</div>
        <div class="muted small">${esc(it.why)}</div>
        ${setupState.lines[it.id] ? `<div class="setup-line small">${esc(setupState.lines[it.id])}</div>` : ''}
        ${it.version && it.note ? `<div class="muted small">${esc(it.note)}</div>` : ''}
      </div>
      <div class="setup-side">
        ${it.version
          ? `<span class="setup-ok">${icon('check')}${esc(String(it.version).slice(0, 40))}</span>`
          : busy
            ? '<span class="muted">Installing…</span>'
            : `<button class="primary" ${blocked ? 'disabled title="Install Node.js first"' : ''}>${icon('download')}Install</button>`}
      </div>`;
    row.querySelector('button')?.addEventListener('click', () => setupInstall(it.id));
    box.appendChild(row);
  }
  const missingRec = setupState.items.filter((i) => !i.version && RECOMMENDED.includes(i.id));
  $('#setupInstallRec').disabled = !missingRec.length || setupState.busy.size > 0;
  $('#setupInstallRec').lastChild.textContent = missingRec.length ? `Install everything recommended (${missingRec.length})` : 'Everything recommended is installed';
}

async function setupInstall(id) {
  setupState.busy.add(id);
  setupState.lines[id] = 'Starting…';
  renderSetup(false);
  try {
    await hub.setup.install(id);
    setupState.lines[id] = '';
  } catch (e) {
    setupState.lines[id] = `Failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
  setupState.busy.delete(id);
  await renderSetup();
  if (id === 'ollama') {
    await hub.ollama.start().catch(() => {});
    refreshStatus();
    loadModels();
  }
}
hub.setup.onProgress(({ id, line }) => {
  setupState.lines[id] = line;
  const it = setupState.items.find((x) => x.id === id);
  if (it && state.view === 'setup') renderSetup(false);
});

$('#setupInstallRec').onclick = async () => {
  // Node.js first: the CLIs install through npm.
  for (const id of RECOMMENDED) {
    const it = setupState.items.find((x) => x.id === id);
    if (it && !it.version) await setupInstall(id);
  }
};
$('#setupRecheck').onclick = () => renderSetup();
$('#setupDone').onclick = async () => {
  await hub.settings.set({ setupDone: true });
  loadModels();
  showView('chat');
};
$('#openSetup').onclick = () => showView('setup');

// ---------------- approvals ----------------

state.approvals = new Map();

function respondToApproval(id, answer) {
  const a = state.approvals.get(id);
  if (!a) return;
  hub.approvals.respond(id, answer);
  state.approvals.delete(id);

  // Update inline approval card if rendered in #messages
  const inlineEl = document.querySelector(`.approval[data-id="${CSS.escape(id)}"]`);
  if (inlineEl) {
    inlineEl.innerHTML = `<span class="muted">${answer === 'deny' ? '✕ Denied' : '✓ Allowed'}: ${esc(a.title.toLowerCase())}</span>`;
    inlineEl.className = 'approval done';
  }
  if (answer === 'always') loadSettings();
  renderGlobalApprovals();
  renderActivityBar();
  renderTitlebarStatus();
  renderChatList();
}

function renderGlobalApprovals() {
  const bar = $('#globalApprovalBar');
  if (!bar) return;
  const list = [...state.approvals.values()];
  if (!list.length) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  const a = list[0];
  const isCurrentChat = state.view === 'chat' && state.chat?.id === a.chatId;
  const canAlways = a.tool === 'run_command' && a.risk !== 'dangerous';
  const alwaysPrefix = a.detail ? a.detail.trim().split(/\s+/).slice(0, 2).join(' ') : '';
  const modelLabel = shortModelName(a.model);

  bar.hidden = false;
  bar.className = `global-approval-bar ${a.risk === 'dangerous' ? 'dangerous' : ''}`;
  bar.innerHTML = `
    <div class="gab-left">
      <span class="gab-badge">${icon('alert')}${list.length > 1 ? `1 of ${list.length} Decisions Needed` : 'Decision Needed'}</span>
      <div class="gab-info">
        <div class="gab-title">
          <b>${esc(a.title)}?</b>
          <span class="chip">${esc(a.risk)}</span>
          <span class="muted small">in chat <b>${esc(a.chatTitle || 'Chat')}</b>${modelLabel ? ` (${esc(modelLabel)})` : ''}${a.cwd ? ` · 📁 ${esc(baseName(a.cwd))}` : ''}</span>
        </div>
        <div class="gab-cmd" title="${esc(a.detail)}">${esc(a.detail)}</div>
      </div>
    </div>
    <div class="gab-actions">
      <button class="primary mini" data-ga="allow">Allow once</button>
      ${canAlways ? `<button class="mini" data-ga="always" title="Always allow commands starting with ${esc(alwaysPrefix)}">Always allow "${esc(alwaysPrefix)}"</button>` : ''}
      <button class="danger mini" data-ga="deny">Deny</button>
      ${!isCurrentChat ? `<button class="mini" data-ga="open">Open chat →</button>` : ''}
    </div>`;
  bar.querySelectorAll('[data-ga]').forEach((b) => (b.onclick = () => {
    const act = b.dataset.ga;
    if (act === 'open') {
      openChat(a.chatId);
      return;
    }
    respondToApproval(a.id, act);
  }));
}

function approvalEl(a) {
  const el = document.createElement('div');
  el.className = `approval risk-${a.risk}`;
  el.dataset.id = a.id;
  const canAlways = a.tool === 'run_command' && a.risk !== 'dangerous';
  el.innerHTML = `
    <div class="approval-head"><b>${esc(a.title)}?</b> <span class="chip">${esc(a.risk)}</span> <span class="muted">${esc(a.reason)}</span></div>
    ${a.cwd ? `<div class="muted small">in ${esc(a.cwd)}</div>` : ''}
    <pre>${esc(a.detail)}</pre>
    <div class="actions">
      <button class="primary" data-a="allow">Allow</button>
      ${canAlways ? `<button data-a="always" title="Don't ask again for commands starting with this">Always allow "${esc(a.detail.trim().split(/\s+/).slice(0, 2).join(' '))}"</button>` : ''}
      <button class="danger" data-a="deny">Deny</button>
    </div>`;
  el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => respondToApproval(a.id, b.dataset.a)));
  return el;
}

hub.approvals.onRequest((a) => {
  state.approvals.set(a.id, a);
  if (state.chat?.id === a.chatId && state.view === 'chat') {
    const box = $('#messages');
    box.appendChild(approvalEl(a));
    box.scrollTop = box.scrollHeight;
  }
  renderGlobalApprovals();
  renderActivityBar();
  renderTitlebarStatus();
  renderChatList();
});

// ---------------- terminal ----------------

const termRuns = new Map();
async function refreshCwd() {
  $('#termCwd').textContent = await hub.terminal.cwd();
  refreshWorkspaceUi();
}
hub.terminal.onStart(({ runId, command, cwd, source }) => {
  const el = document.createElement('div');
  el.className = 'term-run';
  el.innerHTML = `<div class="term-cmd"><span class="chip">${source === 'user' ? 'You' : 'AI'}</span> <span class="muted">${esc(cwd)}&gt;</span> ${esc(command)} <button class="kill" title="Stop">■</button></div><pre></pre><div class="term-exit muted">running…</div>`;
  el.querySelector('.kill').onclick = () => hub.terminal.kill(runId);
  $('#termLog').appendChild(el);
  termRuns.set(runId, el);
  $('#termLog').scrollTop = $('#termLog').scrollHeight;
});
hub.terminal.onData(({ runId, text }) => {
  const el = termRuns.get(runId);
  if (!el) return;
  const log = $('#termLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  el.querySelector('pre').textContent += text;
  if (atBottom) log.scrollTop = log.scrollHeight;
});
hub.terminal.onEnd(({ runId, exitCode, cwd }) => {
  const el = termRuns.get(runId);
  if (!el) return;
  el.querySelector('.kill').remove();
  el.querySelector('.term-exit').textContent = `exit ${exitCode}`;
  el.querySelector('.term-exit').classList.toggle('bad', exitCode !== 0);
  $('#termCwd').textContent = cwd;
  state.cwd = cwd;
  refreshWorkspaceUi();
  termRuns.delete(runId);
});
// ---------------- git ----------------

const gitState = { repo: '', repos: [], info: null, selected: null, sub: 'changes', timer: null, busy: false, newBranch: false };
const STATUS_NAMES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'new file', T: 'type changed' };

function gitVisible() {
  return toolVisible('git') && !document.hidden;
}

async function gitActivate() {
  await gitLoadRepos();
  await gitRefresh();
  clearInterval(gitState.timer);
  gitState.timer = setInterval(() => {
    if (!gitVisible()) return clearInterval(gitState.timer);
    if (!gitState.busy) gitRefresh(true);
  }, 4000);
}

async function gitLoadRepos() {
  const { repos, active } = await hub.git.repos();
  gitState.repos = repos;
  gitState.repo = repos.some((r) => r.path === active) ? active : repos[0]?.path || '';
  $('#gitRepo').innerHTML = repos.length
    ? repos.map((r) => `<option value="${esc(r.path)}" title="${esc(r.path)}">${esc(r.name)}${r.exists ? '' : ' (missing)'}</option>`).join('')
    : '<option value="">No repositories</option>';
  $('#gitRepo').value = gitState.repo;
  $('#gitRepoList').innerHTML = repos.length
    ? repos.map((r) => `<li><span class="repo-name">${esc(r.name)}</span><span class="muted small path">${esc(r.path)}</span><button class="icon-btn" data-remove="${esc(r.path)}" title="Stop tracking (files are not touched)">${icon('x')}</button></li>`).join('')
    : '<li class="muted">Not tracking any repositories yet.</li>';
  $('#gitRepoList').querySelectorAll('[data-remove]').forEach((b) => (b.onclick = async () => {
    await hub.git.remove(b.dataset.remove);
    await gitLoadRepos();
    gitRefresh();
  }));
  const none = !repos.length;
  $('#gitMain').hidden = none;
  if (none) $('#gitManage').hidden = false;
  for (const id of ['#gitFetch', '#gitPull', '#gitPush', '#gitBranch']) $(id).disabled = none;
}

function setGitProgress(text, kind = '') {
  const el = $('#gitProgress');
  el.hidden = !text;
  el.className = `git-progress ${kind}`;
  el.textContent = text || '';
}

async function gitRun(label, fn, { refresh = true } = {}) {
  if (gitState.busy) return;
  gitState.busy = true;
  setGitProgress(`${label}…`);
  try {
    const out = await fn();
    setGitProgress(`${label}: done`, 'ok');
    setTimeout(() => !gitState.busy && $('#gitProgress').classList.contains('ok') && setGitProgress(''), 2500);
    return out;
  } catch (e) {
    setGitProgress(`${label} failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'err');
    throw e;
  } finally {
    gitState.busy = false;
    if (refresh) gitRefresh(true);
  }
}
hub.git.onProgress(({ repo, line }) => {
  if ((repo === gitState.repo || !gitState.repo) && gitState.busy) setGitProgress(line);
});

async function gitRefresh(quiet) {
  if (!gitState.repo) {
    $('#gitTabCount').hidden = true;
    return;
  }
  let info;
  try {
    info = await hub.git.info(gitState.repo);
  } catch (e) {
    if (!quiet) setGitProgress(`Can't read repository: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'err');
    return;
  }
  const changed = JSON.stringify(info) !== JSON.stringify(gitState.info);
  gitState.info = info;
  const count = info.files.length;
  $('#gitTabCount').hidden = !count;
  $('#gitTabCount').textContent = count;
  $('#gitCount').textContent = count || '';
  $('#gitAhead').textContent = info.ahead ? ` ${info.ahead}` : '';
  $('#gitBehind').textContent = info.behind ? ` ${info.behind}` : '';
  $('#gitPush').classList.toggle('primary', info.ahead > 0);
  $('#gitPush').title = info.upstream ? `Push to ${info.upstream}` : info.remotes.length ? 'Push and set upstream (origin)' : 'No remote configured';
  $('#gitPull').title = info.upstream ? `Pull from ${info.upstream}` : 'No upstream branch';
  if (changed || !quiet) {
    renderGitFiles();
    if (!gitState.newBranch) renderGitBranches();
  }
  if (gitState.selected) {
    const still = info.files.find((f) => f.path === gitState.selected.path && (gitState.selected.staged ? f.staged : f.unstaged));
    if (still) {
      if (changed || !quiet) showGitDiff(gitState.selected, true);
    } else {
      gitState.selected = null;
      $('#gitDiff').innerHTML = '<div class="muted center">Select a file to see its changes</div>';
    }
  }
  if (gitState.sub === 'history' && !quiet) renderGitLog();
}

function fileRow(f, staged) {
  const code = staged ? f.x : f.untracked ? '?' : f.y;
  const letter = code === '?' ? 'U' : f.conflict ? '!' : code;
  const name = f.path.split('/').pop();
  const dir = f.path.slice(0, -name.length);
  const li = document.createElement('li');
  li.className = 'git-file' + (gitState.selected?.path === f.path && !!gitState.selected.staged === staged ? ' active' : '');
  li.title = `${f.path} — ${STATUS_NAMES[code] || code}${f.from ? ` (from ${f.from})` : ''}`;
  li.innerHTML = `
    <span class="st st-${code === '?' ? 'new' : f.conflict ? 'conflict' : letter}">${esc(letter)}</span>
    <span class="fname">${esc(name)}</span><span class="fdir">${esc(dir)}</span>
    <span class="factions">
      ${staged ? `<button class="icon-btn" data-a="unstage" title="Unstage">${icon('undo')}</button>`
        : `<button class="icon-btn" data-a="discard" title="Discard changes">${icon('trash')}</button><button class="icon-btn" data-a="stage" title="Stage">${icon('plus')}</button>`}
    </span>`;
  li.onclick = (e) => {
    if (e.target.closest('button')) return;
    gitState.selected = { path: f.path, staged, untracked: !!f.untracked };
    $('#gitStaged').querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
    $('#gitUnstaged').querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
    li.classList.add('active');
    showGitDiff(gitState.selected);
  };
  li.querySelector('[data-a=stage]')?.addEventListener('click', () => gitRun('Stage', () => hub.git.stage(gitState.repo, [f.path])));
  li.querySelector('[data-a=unstage]')?.addEventListener('click', () => gitRun('Unstage', () => hub.git.unstage(gitState.repo, [f.path])));
  const discard = li.querySelector('[data-a=discard]');
  discard?.addEventListener('click', () => {
    if (!discard.classList.contains('confirm')) {
      discard.classList.add('confirm');
      discard.title = f.untracked ? 'Click again to DELETE this new file' : 'Click again to throw away your changes';
      setTimeout(() => discard.classList.remove('confirm'), 3000);
      return;
    }
    gitRun('Discard', () => hub.git.discard(gitState.repo, [f.path]));
  });
  return li;
}

function renderGitFiles() {
  const info = gitState.info;
  const staged = info.files.filter((f) => f.staged);
  const unstaged = info.files.filter((f) => f.unstaged);
  $('#gitStaged').innerHTML = '';
  $('#gitUnstaged').innerHTML = '';
  staged.forEach((f) => $('#gitStaged').appendChild(fileRow(f, true)));
  unstaged.forEach((f) => $('#gitUnstaged').appendChild(fileRow(f, false)));
  $('#gitStagedGroup').hidden = !staged.length;
  if (!unstaged.length) $('#gitUnstaged').innerHTML = `<li class="muted small empty">${staged.length ? 'Nothing else changed' : 'Working tree clean'}</li>`;
  $('#gitStageAll').hidden = !unstaged.length;
  $('#gitCommit').disabled = !staged.length && !$('#gitAmend').checked;
  $('#gitCommitPush').disabled = $('#gitCommit').disabled;
}

async function renderGitBranches() {
  let branches = [];
  try {
    branches = await hub.git.branches(gitState.repo);
  } catch {}
  const local = branches.filter((b) => !b.remote);
  const remote = branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith('/' + l.name)));
  const current = local.find((b) => b.current)?.name || gitState.info?.branch || '';
  $('#gitBranch').innerHTML =
    (gitState.info?.detached ? '<option value="">(detached HEAD)</option>' : '') +
    local.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('') +
    (remote.length ? `<optgroup label="Remote">${remote.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}</optgroup>` : '') +
    '<option value="__new__">+ New branch…</option>';
  $('#gitBranch').value = gitState.info?.detached ? '' : current;
}

// Unified diff -> rows with old/new line numbers.
function renderDiff(text, el) {
  if (!text || !text.trim()) {
    el.innerHTML = '<div class="muted center">No textual changes</div>';
    return;
  }
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  let oldN = 0;
  let newN = 0;
  const rows = [];
  for (const line of lines.slice(0, 6000)) {
    let cls = 'ctx';
    let a = '';
    let b = '';
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      oldN = +h[1];
      newN = +h[2];
      cls = 'hunk';
    } else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line)) cls = 'meta';
    else if (line.startsWith('+')) {
      cls = 'add';
      b = newN++;
    } else if (line.startsWith('-')) {
      cls = 'del';
      a = oldN++;
    } else if (line.startsWith('\\')) cls = 'meta';
    else {
      a = oldN++;
      b = newN++;
    }
    rows.push(`<div class="dl ${cls}"><span class="ln">${a}</span><span class="ln">${b}</span><span class="code">${esc(line) || ' '}</span></div>`);
  }
  if (lines.length > 6000) rows.push(`<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="code">… ${lines.length - 6000} more lines</span></div>`);
  el.innerHTML = `<div class="diff">${rows.join('')}</div>`;
}

async function showGitDiff(sel, keepScroll) {
  const el = $('#gitDiff');
  const scroll = el.scrollTop;
  try {
    const text = await hub.git.diff(gitState.repo, sel.path, { staged: sel.staged, untracked: sel.untracked });
    renderDiff(text, el);
    if (keepScroll) el.scrollTop = scroll;
  } catch (e) {
    el.innerHTML = `<div class="error pad">${esc(e.message)}</div>`;
  }
}

async function renderGitLog() {
  const log = await hub.git.log(gitState.repo).catch(() => []);
  $('#gitLog').innerHTML = log.length
    ? log
        .map((c) => {
          const refs = (c.refs || '').split(',').map((r) => r.trim().replace(/^HEAD -> /, '')).filter((r) => r && r !== 'HEAD');
          return `<li data-hash="${esc(c.hash)}"><div class="subj">${esc(c.subject)}</div><div class="meta muted small"><code>${esc(c.short)}</code> ${esc(c.author)} · ${esc(c.when)} ${refs.map((r) => `<span class="chip ref">${esc(r)}</span>`).join('')}</div></li>`;
        })
        .join('')
    : '<li class="muted small">No commits yet</li>';
  $('#gitLog').querySelectorAll('li[data-hash]').forEach((li) => (li.onclick = async () => {
    $('#gitLog').querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
    li.classList.add('active');
    renderDiff(await hub.git.show(gitState.repo, li.dataset.hash), $('#gitShow'));
  }));
}

document.querySelectorAll('.git-subtabs [data-gsub]').forEach((b) => (b.onclick = () => {
  gitState.sub = b.dataset.gsub;
  document.querySelectorAll('.git-subtabs [data-gsub]').forEach((x) => x.classList.toggle('active', x === b));
  $('#git-changes').hidden = gitState.sub !== 'changes';
  $('#git-history').hidden = gitState.sub !== 'history';
  $('#git-knowledge').hidden = gitState.sub !== 'knowledge';
  if ($('#git-agents')) $('#git-agents').hidden = gitState.sub !== 'agents';
  if (gitState.sub === 'history') renderGitLog();
  if (gitState.sub === 'knowledge') renderKnowledge();
  if (gitState.sub === 'agents') renderGitAgents();
}));

function syncSpecialistAgentControls() {
  const s = state.settings || {};
  const chatModelLabel = shortModelName($('#modelSelect')?.value) || 'chat model';
  const compactOpts =
    `<option value="">Model: ${esc(chatModelLabel)}</option>` +
    state.models
      .filter((m) => !/embed/.test(m.name))
      .map((m) => `<option value="${esc(m.id)}">${esc(m.provider === 'ollama' ? m.name : m.title)}${PROVIDER_SUFFIX[m.provider] || (m.cloud ? '' : ' (local)')}</option>`)
      .join('');

  // Toggles
  const tEnabled = !!s.testerEnabled;
  const mEnabled = !!s.mergerEnabled;
  if ($('#testerToggle')) $('#testerToggle').checked = tEnabled;
  if ($('#gitTesterToggle')) $('#gitTesterToggle').checked = tEnabled;
  if ($('#setTester')) $('#setTester').checked = tEnabled;
  $('#testerHeaderGroup')?.classList.toggle('enabled', tEnabled);

  if ($('#mergerToggle')) $('#mergerToggle').checked = mEnabled;
  if ($('#gitMergerToggle')) $('#gitMergerToggle').checked = mEnabled;
  if ($('#setMerger')) $('#setMerger').checked = mEnabled;
  $('#mergerHeaderGroup')?.classList.toggle('enabled', mEnabled);

  // Model selects
  for (const sel of [$('#headerTesterModel'), $('#gitTesterModel')]) {
    if (!sel) continue;
    sel.innerHTML = compactOpts;
    sel.value = s.testerModel || '';
  }
  for (const sel of [$('#headerMergerModel'), $('#gitMergerModel')]) {
    if (!sel) continue;
    sel.innerHTML = compactOpts;
    sel.value = s.mergerModel || '';
  }
  if ($('#gitMergerTarget') && !$('#gitMergerTarget').dataset.touched) {
    $('#gitMergerTarget').value = s.mergerTargetBranch || 'main';
  }
  if ($('#gitTesterCmd') && !$('#gitTesterCmd').dataset.touched) {
    $('#gitTesterCmd').value = s.testerCommand || '';
  }
}

function renderGitAgents() {
  syncSpecialistAgentControls();
}

async function updateSpecialistSetting(patch) {
  state.settings = { ...(state.settings || {}), ...patch };
  syncSpecialistAgentControls();
  await hub.settings.set(patch);
}

$('#testerToggle')?.addEventListener('change', (e) => updateSpecialistSetting({ testerEnabled: e.target.checked }));
$('#gitTesterToggle')?.addEventListener('change', (e) => updateSpecialistSetting({ testerEnabled: e.target.checked }));
$('#headerTesterModel')?.addEventListener('change', (e) => updateSpecialistSetting({ testerModel: e.target.value }));
$('#gitTesterModel')?.addEventListener('change', (e) => updateSpecialistSetting({ testerModel: e.target.value }));

$('#mergerToggle')?.addEventListener('change', (e) => updateSpecialistSetting({ mergerEnabled: e.target.checked }));
$('#gitMergerToggle')?.addEventListener('change', (e) => updateSpecialistSetting({ mergerEnabled: e.target.checked }));
$('#headerMergerModel')?.addEventListener('change', (e) => updateSpecialistSetting({ mergerModel: e.target.value }));
$('#gitMergerModel')?.addEventListener('change', (e) => updateSpecialistSetting({ mergerModel: e.target.value }));

$('#gitMergerTarget')?.addEventListener('input', (e) => (e.target.dataset.touched = '1'));
$('#gitTesterCmd')?.addEventListener('input', (e) => (e.target.dataset.touched = '1'));

function renderMergerSummaryBox(res, box) {
  if (!box) return;
  if (!res?.ok) {
    box.innerHTML = `<div class="error">${esc(res?.error || 'Merger Agent failed')}</div>`;
    return;
  }
  if (!res.results?.length) {
    box.innerHTML = `<div class="muted">${esc(res.summary || `No task branches other than ${res.targetBranch || 'main'} found.`)}</div>`;
    return;
  }
  box.innerHTML = `
    <div><b>${esc(res.summary)}</b> <span class="muted small">(target: <code>${esc(res.targetBranch)}</code>)</span></div>
    ${res.results
      .map((r) => {
        const badge =
          r.verdict === 'merged'
            ? '<span class="chip loaded">✓ merged</span>'
            : r.verdict === 'clean'
              ? '<span class="chip loaded">✓ clean</span>'
              : '<span class="chip" style="color:var(--danger);border-color:var(--danger)">⚠ conflict</span>';
        return `<div class="branch-check-row">
          ${badge}
          <code>${esc(r.branch)}</code> → <code>${esc(r.targetBranch)}</code>
          ${r.ownerChatTitle ? `<span class="muted small">· chat: <b>${esc(r.ownerChatTitle)}</b></span>` : ''}
          <span class="spacer"></span>
          ${
            r.verdict === 'conflict' && (r.ownerChatId || state.chat?.id)
              ? `<button type="button" class="mini primary" data-send-branch="${esc(r.branch)}">Send to agent →</button>`
              : ''
          }
        </div>`;
      })
      .join('')}`;
  box.querySelectorAll('[data-send-branch]').forEach((btn) => {
    btn.onclick = async () => {
      const br = btn.dataset.sendBranch;
      const r = res.results.find((x) => x.branch === br);
      const targetChat = r?.ownerChatId || state.chat?.id;
      if (!r || !targetChat) return;
      btn.disabled = true;
      btn.textContent = 'Sent ✓';
      await hub.agents.sendReport({ chatId: targetChat, report: r });
      openChat(targetChat);
    };
  });
}

async function triggerMerger({ performMerge = false, fromHeader = false } = {}) {
  const repo = fromHeader ? state.repoRoot || gitState.repo : gitState.repo || state.repoRoot;
  const modelId = (
    (fromHeader ? $('#headerMergerModel')?.value : $('#gitMergerModel')?.value) ||
    state.settings?.mergerModel ||
    $('#modelSelect')?.value ||
    ''
  ).trim();
  const targetBranch = ($('#gitMergerTarget')?.value || state.settings?.mergerTargetBranch || 'main').trim();
  const group = $('#mergerHeaderGroup');
  const btn = $('#runMergerBtn');
  const lbl = $('#mergerBtnLabel');
  if (btn) btn.disabled = true;
  group?.classList.add('running');
  if (lbl) lbl.textContent = performMerge ? 'Merging…' : 'Checking…';
  const box = $('#gitMergerStatus');
  if (box) box.innerHTML = `<div class="muted">Merger Agent is checking branches against <code>${esc(targetBranch)}</code>…</div>`;
  try {
    const res = await hub.agents.runMerger({
      chatId: state.chat?.id,
      repo,
      targetBranch,
      performMerge,
      modelId,
      autoSend: state.settings?.mergerAutoSend ?? false,
    });
    renderMergerSummaryBox(res, box);
    const hasConflict = res?.results?.some((r) => r.verdict === 'conflict');
    group?.classList.remove('running');
    group?.classList.add(!res?.ok || hasConflict ? 'fail' : 'pass');
    if (lbl) lbl.textContent = !res?.ok ? 'Merger ✕' : hasConflict ? 'Conflict ⚠' : performMerge ? 'Merged ✓' : 'Clean ✓';
    if (!res?.ok && state.view === 'chat' && fromHeader) {
      openPanel('git');
      document.querySelector('.git-subtabs [data-gsub="agents"]')?.click();
    }
    gitRefresh(true);
    refreshWorkspaceUi();
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => {
      group?.classList.remove('running', 'pass', 'fail');
      if (lbl) lbl.textContent = 'Merger';
    }, 5000);
  }
}

async function triggerTester({ fromHeader = false } = {}) {
  const cwd = fromHeader ? state.chat?.cwd || state.cwd || gitState.repo : gitState.repo || state.chat?.cwd || state.cwd;
  const modelId = (
    (fromHeader ? $('#headerTesterModel')?.value : $('#gitTesterModel')?.value) ||
    state.settings?.testerModel ||
    $('#modelSelect')?.value ||
    ''
  ).trim();
  const customCommand = ($('#gitTesterCmd')?.value || state.settings?.testerCommand || '').trim();
  const group = $('#testerHeaderGroup');
  const btn = $('#runTesterBtn');
  const lbl = $('#testerBtnLabel');
  if (btn) btn.disabled = true;
  group?.classList.add('running');
  if (lbl) lbl.textContent = 'Testing…';
  const box = $('#gitTesterStatus');
  if (box) box.innerHTML = `<div class="muted">Tester Agent is running CI pipeline checks (1 MR at a time)…</div>`;
  try {
    const res = await hub.agents.runTester({
      chatId: state.chat?.id,
      cwd,
      customCommand,
      modelId,
      autoSend: state.settings?.testerAutoSend ?? false,
    });
    if (box) {
      if (!res?.ok) {
        box.innerHTML = `<div class="error">${esc(res?.error || 'Tester Agent failed')}</div>`;
      } else {
        const badge =
          res.verdict === 'pass'
            ? '<span class="chip loaded">✓ PASS</span>'
            : res.verdict === 'fail'
              ? '<span class="chip" style="color:var(--danger);border-color:var(--danger)">✕ FAIL</span>'
              : '<span class="chip" style="color:var(--warn);border-color:var(--warn)">⚠ WARN</span>';
        const stepsRows = (res.steps || [])
          .map(
            (s, i) => `<div class="branch-check-row">
              <span class="chip ${s.passed ? 'loaded' : ''}" style="${s.passed ? '' : 'color:var(--danger);border-color:var(--danger)'}">${s.passed ? '✓' : '✕'}</span>
              <b>${i + 1}/${res.steps.length}:</b> <code>${esc(s.command)}</code>
              <span class="muted small">${((s.durationMs || 0) / 1000).toFixed(1)}s</span>
            </div>`
          )
          .join('');
        box.innerHTML = `
          <div class="row wrap">${badge} <code>${esc(res.command || '')}</code> <span class="muted small">(exit ${esc(res.exitCode ?? 0)})</span></div>
          <div>${esc(res.summary || '')}</div>
          ${stepsRows}`;
      }
    }
    group?.classList.remove('running');
    group?.classList.add(res?.verdict === 'pass' ? 'pass' : 'fail');
    if (lbl) lbl.textContent = res?.verdict === 'pass' ? 'Tests ✓' : 'Tests ✕';
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => {
      group?.classList.remove('running', 'pass', 'fail');
      if (lbl) lbl.textContent = 'Tester';
    }, 5000);
  }
}

$('#runTesterBtn')?.addEventListener('click', () => triggerTester({ fromHeader: true }));
$('#runMergerBtn')?.addEventListener('click', () => triggerMerger({ performMerge: false, fromHeader: true }));
$('#gitMergerCheck')?.addEventListener('click', () => triggerMerger({ performMerge: false, fromHeader: false }));
$('#gitMergerMerge')?.addEventListener('click', () => triggerMerger({ performMerge: true, fromHeader: false }));
$('#gitTesterRun')?.addEventListener('click', () => triggerTester({ fromHeader: false }));

function renderStageChip(s, cls = 'saq-stage') {
  const sym = s.status === 'pass' ? '✓' : s.status === 'fail' ? '✕' : s.status === 'running' ? '●' : '○';
  const dur = s.durationMs != null ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : '';
  return `<span class="${cls} ${esc(s.status || 'pending')}" title="${esc(s.command || s.label)}">${sym} ${s.index}. ${esc(s.label)}${esc(dur)}</span>`;
}

function renderAgentQueueUi() {
  const { testerActive, testerQueue = [], mergerActive, mergerQueue = [] } = state.agentQueue || {};
  const hasTester = !!testerActive || testerQueue.length > 0;
  const hasMerger = !!mergerActive || mergerQueue.length > 0;

  // 1. Header pill labels & queue badges
  const tGroup = $('#testerHeaderGroup');
  const tLbl = $('#testerBtnLabel');
  if (tLbl && !tGroup?.classList.contains('pass') && !tGroup?.classList.contains('fail')) {
    tGroup?.classList.toggle('running', hasTester);
    if (testerActive) {
      const stagePart = testerActive.stepIndex && testerActive.stepTotal ? ` ${testerActive.stepIndex}/${testerActive.stepTotal}` : '…';
      const qBadge = testerQueue.length ? `<span class="ac-qbadge" title="${testerQueue.length} MR(s) waiting in queue">+${testerQueue.length}</span>` : '';
      tLbl.innerHTML = `Testing${esc(stagePart)}${qBadge}`;
    } else if (testerQueue.length) {
      tLbl.innerHTML = `Tester <span class="ac-qbadge">+${testerQueue.length}</span>`;
    } else {
      tLbl.textContent = 'Tester';
    }
  }
  const mGroup = $('#mergerHeaderGroup');
  const mLbl = $('#mergerBtnLabel');
  if (mLbl && !mGroup?.classList.contains('pass') && !mGroup?.classList.contains('fail')) {
    mGroup?.classList.toggle('running', hasMerger);
    if (mergerActive) {
      const qBadge = mergerQueue.length ? `<span class="ac-qbadge">+${mergerQueue.length}</span>` : '';
      mLbl.innerHTML = `Merging…${qBadge}`;
    } else if (mergerQueue.length) {
      mLbl.innerHTML = `Merger <span class="ac-qbadge">+${mergerQueue.length}</span>`;
    } else {
      mLbl.textContent = 'Merger';
    }
  }

  // 2. Left Sidebar Agent Queue Tray (#sidebarAgentQueue)
  const sb = $('#sidebarAgentQueue');
  if (sb) {
    if (!hasTester && !hasMerger) {
      sb.hidden = true;
      sb.innerHTML = '';
    } else {
      sb.hidden = false;
      const sections = [];
      if (hasTester) {
        const stages = testerActive?.stages || [];
        const pct =
          testerActive?.stepTotal > 0
            ? Math.min(100, Math.round((((testerActive.stepIndex || 1) - 0.5) / testerActive.stepTotal) * 100))
            : 50;
        const modelTag = testerActive?.model ? shortModelName(testerActive.model) : '';
        sections.push(`
          <div class="saq-section">
            <div class="sidebar-pulls-head">
              <span><span class="busy-dot"></span> 🧪 Tester Agent (1 MR at a time)</span>
              <button type="button" class="link small" data-open-git-agents="1">Details</button>
            </div>
            ${
              testerActive
                ? `<div class="saq-active-card" data-jump-chat="${esc(testerActive.chatId || '')}" title="Click to open this MR's chat">
                    <div class="saq-top">
                      <span class="t">Working: ${esc(testerActive.label)}</span>
                      ${testerActive.stepIndex && testerActive.stepTotal ? `<span class="chip">${testerActive.stepIndex}/${testerActive.stepTotal}</span>` : ''}
                    </div>
                    <div class="saq-sub">
                      <span>${testerActive.branch ? `🌿 ${esc(testerActive.branch)}` : esc(baseName(testerActive.repo))}</span>
                      ${modelTag ? `<span>🤖 ${esc(modelTag)}</span>` : ''}
                    </div>
                    <div class="bar"><div style="width:${pct}%"></div></div>
                    ${stages.length ? `<div class="saq-stages">${stages.map((s) => renderStageChip(s, 'saq-stage')).join('')}</div>` : ''}
                    ${testerActive.liveLine ? `<div class="saq-live" title="${esc(testerActive.liveLine)}">▸ ${esc(testerActive.liveLine)}</div>` : ''}
                  </div>`
                : ''
            }
            ${
              testerQueue.length
                ? `<div class="saq-queue-head">
                    <span>Waiting Queue (${testerQueue.length})</span>
                    <span>FIFO</span>
                  </div>
                  <div class="saq-queue-list">
                    ${testerQueue
                      .map(
                        (q) => `
                      <div class="saq-queue-item" data-jump-chat="${esc(q.chatId || '')}" title="Waiting for current MR test to finish — click to open chat">
                        <span class="saq-qpos">#${q.position}</span>
                        <span class="saq-qname">${esc(q.label)}</span>
                        ${q.branch ? `<span class="saq-qbranch">${esc(q.branch)}</span>` : ''}
                      </div>`
                      )
                      .join('')}
                  </div>`
                : `<div class="muted small" style="font-size:10.5px">Queue empty — next MR runs immediately</div>`
            }
          </div>`);
      }
      if (hasMerger) {
        const modelTag = mergerActive?.model ? shortModelName(mergerActive.model) : '';
        sections.push(`
          <div class="saq-section">
            <div class="sidebar-pulls-head">
              <span><span class="busy-dot"></span> 🔀 Merger Agent</span>
              <button type="button" class="link small" data-open-git-agents="1">Details</button>
            </div>
            ${
              mergerActive
                ? `<div class="saq-active-card" data-jump-chat="${esc(mergerActive.chatId || '')}">
                    <div class="saq-top"><span class="t">Checking: ${esc(mergerActive.label)}</span></div>
                    <div class="saq-sub">
                      <span>→ ${esc(mergerActive.targetBranch || 'main')}</span>
                      ${modelTag ? `<span>🤖 ${esc(modelTag)}</span>` : ''}
                    </div>
                    ${mergerActive.stepText ? `<div class="saq-live">▸ ${esc(mergerActive.stepText)}</div>` : ''}
                  </div>`
                : ''
            }
            ${
              mergerQueue.length
                ? `<div class="saq-queue-head"><span>Merger Queue (${mergerQueue.length})</span></div>
                  <div class="saq-queue-list">
                    ${mergerQueue
                      .map(
                        (q) => `<div class="saq-queue-item" data-jump-chat="${esc(q.chatId || '')}">
                          <span class="saq-qpos">#${q.position}</span>
                          <span class="saq-qname">${esc(q.label)}</span>
                        </div>`
                      )
                      .join('')}
                  </div>`
                : ''
            }
          </div>`);
      }
      sb.innerHTML = sections.join('');
      sb.querySelectorAll('[data-jump-chat]').forEach((el) => {
        el.onclick = () => {
          const cid = el.dataset.jumpChat;
          if (cid) openChat(cid);
        };
      });
      sb.querySelectorAll('[data-open-git-agents]').forEach((btn) => {
        btn.onclick = () => {
          openPanel('git');
          document.querySelector('.git-subtabs [data-gsub="agents"]')?.click();
        };
      });
    }
  }

  // 3. Top-of-composer Visual Pipeline & Queue Bar (#specialistAgentBar)
  const sab = $('#specialistAgentBar');
  if (sab) {
    if (!hasTester && !hasMerger) {
      sab.hidden = true;
      sab.innerHTML = '';
    } else {
      sab.hidden = false;
      const rows = [];
      if (hasTester) {
        const stages = testerActive?.stages || [];
        const stepperHtml = stages
          .map((s, idx) => `${idx > 0 ? '<span class="sab-arrow">→</span>' : ''}${renderStageChip(s, 'sab-step')}`)
          .join('');
        const modelName = testerActive?.model ? shortModelName(testerActive.model) : '';
        rows.push(`
          <div class="sab-row">
            <span class="sab-pill"><span class="busy-dot"></span> 🧪 Tester Agent Working</span>
            ${
              testerActive
                ? `<span class="sab-title">${esc(testerActive.label)}</span>
                   ${testerActive.branch ? `<span class="sab-meta">🌿 ${esc(testerActive.branch)}</span>` : ''}
                   ${modelName ? `<span class="sab-meta">· 🤖 ${esc(modelName)}</span>` : ''}`
                : ''
            }
            <span class="spacer"></span>
            <span class="sab-meta">1 MR at a time</span>
          </div>
          ${stepperHtml ? `<div class="sab-stepper">${stepperHtml}</div>` : ''}
          ${testerActive?.liveLine ? `<div class="sab-live">▸ ${esc(testerActive.liveLine)}</div>` : ''}
          <div class="sab-queue-strip">
            <span class="sab-queue-label">Queue (${testerQueue.length} waiting):</span>
            ${
              testerQueue.length
                ? testerQueue
                    .map(
                      (q) =>
                        `<button type="button" class="sab-queue-chip" data-jump-chat="${esc(q.chatId || '')}" title="Click to switch to ${esc(q.label)}"><b>#${q.position}</b> ${esc(q.label)}${q.branch ? ` <code>${esc(q.branch)}</code>` : ''}</button>`
                    )
                    .join('')
                : `<span class="muted small">No other MRs waiting in queue</span>`
            }
          </div>`);
      }
      if (hasMerger) {
        rows.push(`
          <div class="sab-row">
            <span class="sab-pill"><span class="busy-dot"></span> 🔀 Merger Agent Working</span>
            <span class="sab-title">${esc(mergerActive?.label || '')}</span>
            <span class="sab-meta">${esc(mergerActive?.stepText || `Checking against ${mergerActive?.targetBranch || 'main'}…`)}</span>
            ${
              mergerQueue.length
                ? `<span class="spacer"></span><span class="sab-queue-label">Queued: ${mergerQueue.map((q) => `#${q.position} ${esc(q.label)}`).join(', ')}</span>`
                : ''
            }
          </div>`);
      }
      sab.innerHTML = rows.join('');
      sab.querySelectorAll('[data-jump-chat]').forEach((btn) => {
        btn.onclick = () => {
          const cid = btn.dataset.jumpChat;
          if (cid) openChat(cid);
        };
      });
    }
  }

  // 4. Git → Agents tab live queue status (#gitTesterStatus)
  const box = $('#gitTesterStatus');
  if (box && hasTester) {
    const stages = testerActive?.stages || [];
    const qRows = testerQueue
      .map(
        (q) =>
          `<div class="branch-check-row"><span class="saq-qpos">Queued #${q.position}</span> <b>${esc(q.label)}</b> ${q.branch ? `<code>${esc(q.branch)}</code>` : ''}</div>`
      )
      .join('');
    box.innerHTML = `
      ${
        testerActive
          ? `<div class="branch-check-row">
              <span class="busy-dot"></span>
              <b>Testing now:</b> ${esc(testerActive.label)}
              ${testerActive.branch ? `<code>${esc(testerActive.branch)}</code>` : ''}
              <span class="muted small">${esc(testerActive.stepText || '')}</span>
            </div>
            ${stages.length ? `<div class="saq-stages">${stages.map((s) => renderStageChip(s, 'saq-stage')).join('')}</div>` : ''}
            ${testerActive.liveLine ? `<div class="sab-live">▸ ${esc(testerActive.liveLine)}</div>` : ''}`
          : ''
      }
      ${qRows}`;
  }
}

hub.agents?.onEvent((ev) => {
  if (ev.state === 'queue_update') {
    state.agentQueue = {
      testerActive: ev.testerActive || null,
      testerQueue: ev.testerQueue || [],
      mergerActive: ev.mergerActive || null,
      mergerQueue: ev.mergerQueue || [],
    };
    renderAgentQueueUi();
    renderTitlebarStatus();
    renderChatList();
    return;
  }

  const targetChatId = ev.chatId || state.chat?.id;
  if (ev.state === 'done' || ev.state === 'error') {
    if (targetChatId) {
      state.busy.delete(targetChatId);
      state.activities.delete(targetChatId);
      renderActivityBar();
      renderTitlebarStatus();
      renderChatList();
    }
    renderAgentQueueUi();
    return;
  }
  if (targetChatId) {
    state.busy.add(targetChatId);
    setActivity(targetChatId, {
      phase: ev.agent,
      label: ev.label || ev.text || `${ev.agent === 'merger' ? 'Merger' : 'Tester'} Agent working…`,
      target: ev.command || ev.branch || '',
      panel: 'git',
      cwd: ev.cwd || ev.repo || state.cwd,
    });
  }
  renderAgentQueueUi();
});

$('#gitRepo').onchange = async () => {
  gitState.repo = $('#gitRepo').value;
  gitState.selected = null;
  gitState.info = null;
  $('#gitDiff').innerHTML = '<div class="muted center">Select a file to see its changes</div>';
  await hub.git.setActive(gitState.repo);
  gitRefresh();
};
$('#gitBranch').onchange = async () => {
  const name = $('#gitBranch').value;
  if (name === '__new__') {
    gitState.newBranch = true;
    const wrap = document.createElement('form');
    wrap.className = 'row new-branch';
    wrap.innerHTML = `<input placeholder="new-branch-name" spellcheck="false" /><button class="primary">Create</button><button type="button" class="cancel">Cancel</button>`;
    const branchSel = $('#gitBranch');
    branchSel.after(wrap);
    branchSel.hidden = true;
    const sel = $('#gitBranch');
    wrap.querySelector('input').focus();
    wrap.querySelector('.cancel').onclick = () => {
      wrap.remove();
      sel.hidden = false;
      gitState.newBranch = false;
      renderGitBranches();
    };
    wrap.onsubmit = async (e) => {
      e.preventDefault();
      const n = wrap.querySelector('input').value.trim();
      if (!n) return;
      wrap.remove();
      sel.hidden = false;
      gitState.newBranch = false;
      await gitRun(`Create branch ${n}`, () => hub.git.switchBranch(gitState.repo, n, true)).catch(() => {});
      renderGitBranches();
    };
    return;
  }
  if (!name) return;
  await gitRun(`Switch to ${name}`, () => hub.git.switchBranch(gitState.repo, name, false)).catch(() => {});
  renderGitBranches();
};

$('#gitFetch').onclick = () => gitRun('Fetch', () => hub.git.fetch(gitState.repo)).catch(() => {});
$('#gitPull').onclick = () => gitRun('Pull', () => hub.git.pull(gitState.repo)).catch(() => {});
$('#gitPush').onclick = () => gitRun('Push', () => hub.git.push(gitState.repo)).catch(() => {});
$('#gitStageAll').onclick = () => gitRun('Stage all', () => hub.git.stageAll(gitState.repo)).catch(() => {});
$('#gitUnstageAll').onclick = () => gitRun('Unstage all', () => hub.git.unstage(gitState.repo, gitState.info.files.filter((f) => f.staged).map((f) => f.path))).catch(() => {});
$('#gitRefresh').onclick = () => gitRefresh();
$('#gitOpenFolder').onclick = () => gitState.repo && hub.git.openFolder(gitState.repo);
$('#gitAmend').onchange = () => {
  if (gitState.info) renderGitFiles();
};

async function gitCommit(andPush) {
  const msg = $('#gitMsg').value.trim();
  const amend = $('#gitAmend').checked;
  if (!msg && !amend) {
    $('#gitMsg').focus();
    setGitProgress('Write a commit message first', 'err');
    return;
  }
  try {
    await gitRun(amend ? 'Amend commit' : 'Commit', () => hub.git.commit(gitState.repo, msg || undefined, amend));
    $('#gitMsg').value = '';
    $('#gitAmend').checked = false;
    if (andPush) await gitRun('Push', () => hub.git.push(gitState.repo));
  } catch {}
}
$('#gitCommit').onclick = () => gitCommit(false);
$('#gitCommitPush').onclick = () => gitCommit(true);
$('#gitMsg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) gitCommit(false);
});

// Repository management
$('#gitManageBtn').onclick = () => ($('#gitManage').hidden = !$('#gitManage').hidden);
$('#gitManageClose').onclick = () => ($('#gitManage').hidden = !gitState.repos.length ? false : true);
$('#gitAddFolder').onclick = async () => {
  const dir = await hub.git.pickFolder();
  if (!dir) return;
  await gitRun('Add repository', () => hub.git.add(dir), { refresh: false }).catch(() => {});
  await gitLoadRepos();
  gitRefresh();
};
$('#gitScan').onclick = async () => {
  const n = await gitRun('Scanning workspace', () => hub.git.scan(), { refresh: false }).catch(() => null);
  if (n !== null) setGitProgress(`Found ${n} repositor${n === 1 ? 'y' : 'ies'} in your workspace`, 'ok');
  await gitLoadRepos();
  gitRefresh();
};
$('#gitInit').onclick = async () => {
  const dir = await hub.git.pickFolder();
  if (!dir) return;
  await gitRun('Create repository', () => hub.git.init(dir), { refresh: false }).catch(() => {});
  await gitLoadRepos();
  gitRefresh();
};
$('#gitCloneForm').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#gitCloneUrl').value.trim();
  if (!url) return;
  await gitRun('Clone', () => hub.git.clone(url), { refresh: false }).catch(() => {});
  $('#gitCloneUrl').value = '';
  await gitLoadRepos();
  gitRefresh();
};

// When the AI changes files, refresh — and offer to track a repo it's working in.
hub.git.onChanged(async () => {
  if (gitVisible()) gitRefresh(true);
  else if (gitState.repo) {
    hub.git.info(gitState.repo).then((info) => {
      $('#gitTabCount').hidden = !info.files.length;
      $('#gitTabCount').textContent = info.files.length;
    }).catch(() => {});
  }
  const cwd = await hub.terminal.cwd();
  const top = await hub.git.detect(cwd).catch(() => null);
  const box = $('#gitSuggest');
  if (!top || top === gitState.repo) {
    box.hidden = true;
    return;
  }
  const tracked = gitState.repos.some((r) => r.path === top);
  box.hidden = false;
  box.innerHTML = `<span>The AI is working in <b>${esc(top.split(/[\\/]/).pop())}</b>${tracked ? '' : ", a repository you're not tracking"}.</span><button class="primary mini">${tracked ? 'Switch to it' : 'Track it'}</button><button class="icon-btn" title="Dismiss">${icon('x')}</button>`;
  box.querySelector('.primary').onclick = async () => {
    if (tracked) await hub.git.setActive(top);
    else await hub.git.add(top);
    box.hidden = true;
    await gitLoadRepos();
    gitRefresh();
  };
  box.querySelector('.icon-btn').onclick = () => (box.hidden = true);
});

// ---------------- interactive terminal (xterm.js + ConPTY) ----------------

const ptyState = { sessions: new Map(), active: 'ai', opened: false };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function termTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const base = {
    background: cssVar('--term-bg'),
    foreground: cssVar('--term-text'),
    cursor: cssVar('--accent'),
    selectionBackground: dark ? '#3a4a6a' : '#b6cdf5',
  };
  // Light mode: darker ANSI colors so PowerShell's yellow/cyan stay readable on white.
  return dark
    ? base
    : {
        ...base,
        black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#8a5a00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#7d4e00', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#1f6f80', brightWhite: '#8c959f',
      };
}

function termSize() {
  const r = $('#termXterms').getBoundingClientRect();
  return { cols: Math.max(40, Math.floor((r.width - 16) / 7.8)), rows: Math.max(10, Math.floor((r.height - 16) / 17)) };
}

function selectTerm(id) {
  ptyState.active = id;
  document.querySelectorAll('#termTabs .term-tab').forEach((t) => t.classList.toggle('active', t.dataset.session === id));
  $('#termAi').hidden = id !== 'ai';
  $('#termXterms').hidden = id === 'ai';
  for (const [sid, s] of ptyState.sessions) s.el.hidden = sid !== id;
  const s = ptyState.sessions.get(id);
  if (s) {
    requestAnimationFrame(() => {
      try {
        s.fit.fit();
      } catch {}
      s.term.focus();
    });
  }
}

function attachSession(info, hint) {
  const el = document.createElement('div');
  el.className = 'xterm-host';
  $('#termXterms').appendChild(el);
  const term = new Terminal({
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((d) => hub.pty.write(info.id, d));
  term.onResize(({ cols, rows }) => hub.pty.resize(info.id, cols, rows));
  // Ctrl+C copies when text is selected (otherwise it interrupts); Ctrl+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    if (e.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (e.key === 'v') {
      navigator.clipboard.readText().then((t) => t && term.paste(t));
      return false;
    }
    return true;
  });
  if (hint) term.writeln(`\x1b[36m${hint}\x1b[0m\r\n`);

  const tab = document.createElement('button');
  tab.className = `term-tab ${info.kind === 'login' ? 'login' : ''}`;
  tab.dataset.session = info.id;
  tab.innerHTML = `<span class="t">${esc(info.title)}</span><span class="close" title="Close">${icon('x')}</span>`;
  tab.onclick = (e) => {
    if (e.target.closest('.close')) closeSession(info.id);
    else selectTerm(info.id);
  };
  $('#termNew').before(tab);
  ptyState.sessions.set(info.id, { term, fit, el, tab, info, exited: false });
  selectTerm(info.id);
}

function closeSession(id) {
  const s = ptyState.sessions.get(id);
  if (!s) return;
  if (!s.exited) hub.pty.kill(id);
  s.term.dispose();
  s.el.remove();
  s.tab.remove();
  ptyState.sessions.delete(id);
  if (ptyState.active === id) selectTerm([...ptyState.sessions.keys()].pop() || 'ai');
}

async function newShell() {
  $('#termXterms').hidden = false; // so it can be measured
  const info = await hub.pty.create(termSize());
  attachSession(info);
}

hub.pty.onData(({ id, data }) => ptyState.sessions.get(id)?.term.write(data));
hub.pty.onExit(({ id, exitCode, provider }) => {
  const s = ptyState.sessions.get(id);
  if (s) {
    s.exited = true;
    s.tab.classList.add('exited');
    s.term.writeln(`\r\n\x1b[90m[process exited${exitCode ? ` with code ${exitCode}` : ''} — close this tab with ×]\x1b[0m`);
  }
  if (provider) {
    refreshAccounts();
    loadModels();
  }
});

new ResizeObserver(() => {
  const s = ptyState.sessions.get(ptyState.active);
  if (s && !$('#termXterms').hidden) {
    try {
      s.fit.fit();
    } catch {}
  }
}).observe($('#termXterms'));

$('#termNew').onclick = () => newShell();
document.querySelector('#termTabs [data-session="ai"]').onclick = () => selectTerm('ai');

function refreshTermThemes() {
  for (const s of ptyState.sessions.values()) s.term.options.theme = termTheme();
}

// Opening the Terminal panel the first time starts a shell.
function termActivate() {
  refreshCwd();
  if (!ptyState.opened) {
    ptyState.opened = true;
    if (!ptyState.sessions.size) newShell();
  }
}

// Runs a CLI sign-in flow in an in-app terminal tab.
async function startCliLogin(id) {
  openPanel('terminal');
  $('#termXterms').hidden = false;
  const info = await hub.accounts.cliLogin(id, termSize());
  ptyState.opened = true;
  attachSession(info, info.hint);
  return info;
}

// ---------------- repo knowledge ----------------

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

async function renderKnowledge() {
  if (!gitState.repo) return;
  const st = await hub.repo.status(gitState.repo);
  const m = st.meta;
  $('#kReindex').disabled = st.indexing;
  $('#kStatus').textContent = st.indexing
    ? 'Indexing…'
    : m
      ? `Indexed ${ago(m.indexedAt)} at ${m.branch || ''} ${m.head ? m.head.slice(0, 7) : ''} · ${m.files} files · ${m.reason}${m.summarized ? ' · AI summary' : ''}`
      : 'Not indexed yet.';
  const facts = await hub.repo.facts(gitState.repo);
  $('#kFacts').innerHTML = facts ? `<div class="body">${markdown(facts)}</div>` : '<div class="muted center">No fact sheet yet. Press Re-index.</div>';
}
$('#kReindex').onclick = async () => {
  if (!gitState.repo) return;
  $('#kReindex').disabled = true;
  $('#kStatus').textContent = 'Indexing…';
  try {
    await hub.repo.reindex(gitState.repo);
  } catch (e) {
    $('#kStatus').textContent = `Indexing failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
  renderKnowledge();
};
hub.repo.onStatus((st) => {
  if (st.repo?.toLowerCase() !== gitState.repo?.toLowerCase()) return;
  if (st.state === 'indexing') $('#kStatus').textContent = st.line || 'Indexing…';
  else if (gitState.sub === 'knowledge') renderKnowledge();
});

async function refreshTraceStatus() {
  const el = $('#traceStatus');
  el.textContent = 'Checking TRACE…';
  const st = await hub.trace.status().catch(() => ({}));
  const fmt = (name, r) =>
    !r ? '' : r.ok ? `${name}: TRACE installed${r.version ? ` (v${r.version})` : ''}`
      : r.error === 'not installed' ? `${name}: CLI not installed`
      : /installs on first use/.test(r.error) ? `${name}: TRACE installs on first use`
      : `${name}: TRACE not set up (${r.error})`;
  el.textContent = [fmt('Claude Code', st.claudecode), fmt('Codex', st.codexcli), fmt('Antigravity', st.antigravity)].filter(Boolean).join(' · ');
}
$('#traceUpdate').onclick = async () => {
  $('#traceStatus').textContent = 'Installing / updating TRACE…';
  await hub.trace.update().catch(() => {});
  refreshTraceStatus();
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (a) {
    e.preventDefault();
    hub.browser.navigate(a.dataset.ext);
    openPanel('browser');
  }
});

// ---------------- right panel: browser + android ----------------

function syncBrowserView() {
  const visible = toolVisible('browser') && $('#dockMenu').hidden;
  hub.browser.setVisible(visible);
  if (visible) {
    const r = $('#browserHost').getBoundingClientRect();
    hub.browser.setBounds({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  }
}
new ResizeObserver(syncBrowserView).observe($('#browserHost'));
window.addEventListener('resize', syncBrowserView);

// ---------------- layout: tools panel, docking, split, resizing ----------------

const TOOLS_LIST = ['browser', 'terminal', 'git', 'android'];
const LAYOUT_DEFAULT = { dock: 'right', panelSize: 0, sidebarWidth: 248, sidebarCollapsed: false, split: null, splitRatio: 0.5, autoOpen: true };
const layout = (() => {
  try {
    return { ...LAYOUT_DEFAULT, ...JSON.parse(localStorage.getItem('layout') || '{}') };
  } catch {
    return { ...LAYOUT_DEFAULT };
  }
})();
const saveLayout = () => {
  try {
    localStorage.setItem('layout', JSON.stringify(layout));
  } catch {}
};
state.panelOpen = false; // hidden until an agent uses a tool or the user opens it

let shownTools = new Set();
const toolVisible = (name) => state.panelOpen && (state.panelTab === name || (layout.split === name && layout.split !== state.panelTab));

function applyLayout() {
  const app = $('#app');
  app.dataset.dock = layout.dock;
  app.classList.toggle('sidebar-collapsed', layout.sidebarCollapsed);
  $('#sidebar').style.width = layout.sidebarCollapsed ? '' : `${layout.sidebarWidth}px`;
  $('#gutterSidebar').hidden = layout.sidebarCollapsed;
  $('#panel').hidden = !state.panelOpen;
  $('#gutterPanel').hidden = !state.panelOpen;
  const ws = $('#workspace').getBoundingClientRect();
  const horizontal = layout.dock !== 'bottom';
  const total = horizontal ? ws.width : ws.height;
  const fallback = Math.round(total * (horizontal ? 0.45 : 0.4));
  const size = Math.max(horizontal ? 340 : 180, Math.min(layout.panelSize || fallback, total - (horizontal ? 380 : 200)));
  $('#panel').style.width = horizontal ? `${size}px` : '';
  $('#panel').style.height = horizontal ? '' : `${size}px`;

  // Tools into slots: the active tab in A, the split tool (if any) in B.
  const b = layout.split && layout.split !== state.panelTab ? layout.split : null;
  for (const t of TOOLS_LIST) {
    const el = $(`#tab-${t}`);
    if (t === state.panelTab) {
      if (el.parentElement !== $('#slotA')) $('#slotA').appendChild(el);
      el.hidden = false;
    } else if (t === b) {
      if (el.parentElement !== $('#slotBBody')) $('#slotBBody').appendChild(el);
      el.hidden = false;
    } else el.hidden = true;
  }
  $('#slotB').hidden = !b;
  $('#gutterSplit').hidden = !b;
  if (b) {
    $('#slotBSelect').value = b;
    $('#slotA').style.flex = `${layout.splitRatio} 1 0`;
    $('#slotB').style.flex = `${1 - layout.splitRatio} 1 0`;
  } else {
    $('#slotA').style.flex = '';
  }
  document.querySelectorAll('.tab[data-tab]').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === state.panelTab);
    t.classList.toggle('in-split', t.dataset.tab === b);
  });
  $('#toolsToggleBtn').classList.toggle('active', state.panelOpen);
  $('#tbToolsBtn')?.classList.toggle('tb-branch', state.panelOpen);
  $('#autoOpenTools').checked = layout.autoOpen;
  document.querySelectorAll('#dockMenu [data-dock]').forEach((x) => x.classList.toggle('on', x.dataset.dock === layout.dock));

  // Start whatever just became visible (not on every resize).
  const nowVisible = new Set(state.panelOpen ? [state.panelTab, b].filter(Boolean) : []);
  for (const t of nowVisible) {
    if (shownTools.has(t)) continue;
    if (t === 'terminal') termActivate();
    if (t === 'git') gitActivate();
    if (t === 'android') androidActivate();
  }
  shownTools = nowVisible;
  requestAnimationFrame(() => {
    syncBrowserView();
    for (const s of ptyState.sessions.values()) {
      try {
        s.fit.fit();
      } catch {}
    }
  });
}

function openPanel(tab, { auto = false } = {}) {
  if (auto && !layout.autoOpen && !state.panelOpen) return; // user turned auto-open off
  if (auto && state.panelOpen && layout.split === tab) return; // already visible in the split pane
  state.panelOpen = true;
  if (tab) state.panelTab = tab;
  applyLayout();
}
function closePanel() {
  state.panelOpen = false;
  applyLayout();
}
function togglePanel() {
  state.panelOpen ? closePanel() : openPanel(state.panelTab);
}
document.querySelectorAll('.tab[data-tab]').forEach((t) => (t.onclick = () => openPanel(t.dataset.tab)));
$('#collapsePanel').onclick = closePanel;
$('#toolsToggleBtn').onclick = togglePanel;
$('#tbToolsBtn')?.addEventListener('click', togglePanel);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    togglePanel();
  }
});
$('#collapseSidebar').onclick = () => {
  layout.sidebarCollapsed = !layout.sidebarCollapsed;
  saveLayout();
  applyLayout();
};

// Split view
$('#splitBtn').onclick = () => {
  layout.split = layout.split ? null : TOOLS_LIST.find((t) => t !== state.panelTab && t !== 'android') || 'terminal';
  saveLayout();
  applyLayout();
};
$('#slotBSelect').onchange = () => {
  const t = $('#slotBSelect').value;
  if (t === state.panelTab) state.panelTab = layout.split; // swap
  layout.split = t;
  saveLayout();
  applyLayout();
};
$('#closeSplit').onclick = () => {
  layout.split = null;
  saveLayout();
  applyLayout();
};

// Dock menu
$('#dockBtn').onclick = (e) => {
  e.stopPropagation();
  $('#dockMenu').hidden = !$('#dockMenu').hidden;
  // The browser page is drawn above the app: hide it while the menu is open.
  hub.browser.setVisible(!$('#dockMenu').hidden ? false : toolVisible('browser'));
};
document.addEventListener('click', (e) => {
  if (!$('#dockMenu').hidden && !e.target.closest('.dock-wrap')) {
    $('#dockMenu').hidden = true;
    syncBrowserView();
  }
});
document.querySelectorAll('#dockMenu [data-dock]').forEach((b) => (b.onclick = () => {
  layout.dock = b.dataset.dock;
  layout.panelSize = 0; // re-derive a sensible size for the new orientation
  saveLayout();
  $('#dockMenu').hidden = true;
  applyLayout();
}));
$('#autoOpenTools').onchange = () => {
  layout.autoOpen = $('#autoOpenTools').checked;
  saveLayout();
};
$('#dockMenu [data-reset]').onclick = () => {
  Object.assign(layout, LAYOUT_DEFAULT);
  saveLayout();
  $('#dockMenu').hidden = true;
  applyLayout();
};

// Drag-to-resize gutters
function dragGutter(gutter, onMove) {
  gutter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging', gutter.classList.contains('gutter-h') || (gutter.id === 'gutterPanel' && layout.dock === 'bottom') ? 'dragging-row' : 'dragging-col');
    hub.browser.setVisible(false); // the embedded page would swallow the mouse
    const move = (ev) => onMove(ev);
    const up = () => {
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging', 'dragging-row', 'dragging-col');
      saveLayout();
      applyLayout();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  });
}
dragGutter($('#gutterSidebar'), (e) => {
  layout.sidebarWidth = Math.max(180, Math.min(480, e.clientX));
  $('#sidebar').style.width = `${layout.sidebarWidth}px`;
});
dragGutter($('#gutterPanel'), (e) => {
  const ws = $('#workspace').getBoundingClientRect();
  const size = layout.dock === 'right' ? ws.right - e.clientX : layout.dock === 'left' ? e.clientX - ws.left : ws.bottom - e.clientY;
  const total = layout.dock === 'bottom' ? ws.height : ws.width;
  layout.panelSize = Math.max(layout.dock === 'bottom' ? 180 : 340, Math.min(size, total - (layout.dock === 'bottom' ? 200 : 380)));
  $('#panel').style[layout.dock === 'bottom' ? 'height' : 'width'] = `${layout.panelSize}px`;
});
dragGutter($('#gutterSplit'), (e) => {
  const head = $('.panel-tabs').getBoundingClientRect();
  const p = $('#panel').getBoundingClientRect();
  const ratio = (e.clientY - head.bottom) / (p.bottom - head.bottom);
  layout.splitRatio = Math.max(0.15, Math.min(0.85, ratio));
  $('#slotA').style.flex = `${layout.splitRatio} 1 0`;
  $('#slotB').style.flex = `${1 - layout.splitRatio} 1 0`;
});
window.addEventListener('resize', () => applyLayout());

$('#bBack').onclick = () => hub.browser.back();
$('#bFwd').onclick = () => hub.browser.forward();
$('#bReload').onclick = () => hub.browser.reload();
$('#bExt').onclick = () => hub.browser.openExternal();
$('#bUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') hub.browser.navigate($('#bUrl').value);
});
hub.browser.onState((s) => {
  if (document.activeElement !== $('#bUrl')) $('#bUrl').value = s.url;
  $('#bBack').disabled = !s.canGoBack;
  $('#bFwd').disabled = !s.canGoForward;
  $('#bReload use').setAttribute('href', s.loading ? '#i-x' : '#i-refresh');
});

// Android
const android = { serial: null, streaming: false, w: 0, h: 0, pollTimer: null };
const canvas = $('#androidScreen');
const ctx2d = canvas.getContext('2d');

async function androidActivate() {
  const info = await hub.android.info();
  if (!info.emulator) {
    $('#androidMsg').textContent = 'Android SDK emulator not found. Install Android Studio (or the SDK command-line tools + emulator).';
    return;
  }
  const avds = await hub.android.avds();
  const sel = $('#avdSelect');
  const prev = sel.value;
  sel.innerHTML = avds.length ? avds.map((a) => `<option>${esc(a)}</option>`).join('') : '<option value="">(no AVDs — create one in Android Studio)</option>';
  if (prev) sel.value = prev;
  refreshDevices();
  clearInterval(android.pollTimer);
  android.pollTimer = setInterval(() => {
    if (!toolVisible('android')) return clearInterval(android.pollTimer);
    refreshDevices();
  }, 3000);
}

async function refreshDevices() {
  const devices = await hub.android.devices().catch(() => []);
  const sel = $('#deviceSelect');
  const prev = android.serial;
  sel.innerHTML = devices.length
    ? devices.map((d) => `<option value="${esc(d.serial)}">${esc(d.serial)}${d.booted ? '' : ' (booting…)'}</option>`).join('')
    : '<option value="">(no running devices)</option>';
  const pick = devices.find((d) => d.serial === prev) || devices[0];
  if (pick) sel.value = pick.serial;
  const ready = pick?.booted ? pick.serial : null;
  android.serial = ready;
  if (!devices.length) {
    $('#androidMsg').textContent = 'No emulator running. Pick an AVD and press Boot (first boot can take a minute).';
    $('#androidMsg').hidden = false;
    canvas.hidden = true;
  } else if (!ready) {
    $('#androidMsg').textContent = 'Device is booting…';
    $('#androidMsg').hidden = false;
  }
  if (ready && !android.streaming) streamAndroid();
}
$('#deviceSelect').onchange = () => (android.serial = $('#deviceSelect').value || null);

$('#avdStart').onclick = async () => {
  const avd = $('#avdSelect').value;
  if (!avd) return;
  await hub.android.start(avd, $('#headless').checked);
  $('#androidMsg').textContent = `Booting ${avd}…`;
  $('#androidMsg').hidden = false;
};
$('#avdStop').onclick = async () => {
  if (android.serial) await hub.android.stop(android.serial);
  android.serial = null;
  setTimeout(refreshDevices, 1500);
};

async function streamAndroid() {
  android.streaming = true;
  let frames = 0;
  let t0 = performance.now();
  while (android.serial && toolVisible('android')) {
    try {
      const f = await hub.android.frame(android.serial);
      if (canvas.width !== f.width || canvas.height !== f.height) {
        canvas.width = f.width;
        canvas.height = f.height;
      }
      android.w = f.width;
      android.h = f.height;
      const px = new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.data.byteLength);
      ctx2d.putImageData(new ImageData(px, f.width, f.height), 0, 0);
      canvas.hidden = false;
      $('#androidMsg').hidden = true;
      frames++;
      const now = performance.now();
      if (now - t0 > 1000) {
        $('#fps').textContent = `${((frames * 1000) / (now - t0)).toFixed(1)} fps`;
        frames = 0;
        t0 = now;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  android.streaming = false;
}

function toDevice(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
}
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus();
  down = { ...toDevice(e), t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || !android.serial) return;
  const up = toDevice(e);
  const dist = Math.hypot(up.x - down.x, up.y - down.y);
  const ms = performance.now() - down.t;
  if (dist < 15 && ms < 400) hub.android.input(android.serial, { type: 'tap', x: down.x, y: down.y });
  else if (dist < 15) hub.android.input(android.serial, { type: 'swipe', x1: down.x, y1: down.y, x2: down.x, y2: down.y, ms }); // long press
  else hub.android.input(android.serial, { type: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Math.max(100, Math.min(ms, 1500)) });
  down = null;
});
let wheelAcc = 0;
let wheelTimer = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  wheelAcc += e.deltaY;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    if (!android.serial) return;
    const p = toDevice(e);
    const dy = Math.max(-canvas.height * 0.6, Math.min(canvas.height * 0.6, -wheelAcc * 2));
    hub.android.input(android.serial, { type: 'swipe', x1: p.x, y1: p.y, x2: p.x, y2: p.y + dy, ms: 250 });
    wheelAcc = 0;
  }, 80);
}, { passive: false });

// Keyboard → device while the screen is focused. Characters are batched.
let textBuf = '';
let textTimer = null;
canvas.addEventListener('keydown', (e) => {
  if (!android.serial) return;
  const keys = { Backspace: 67, Enter: 66, Escape: 4, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Delete: 112, Home: 3 };
  if (e.ctrlKey && e.key === 'v') {
    e.preventDefault();
    navigator.clipboard.readText().then((t) => t && hub.android.input(android.serial, { type: 'text', text: t }));
    return;
  }
  if (keys[e.key]) {
    e.preventDefault();
    flushText();
    hub.android.input(android.serial, { type: 'key', code: keys[e.key] });
  } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    textBuf += e.key;
    clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 120);
  }
});
function flushText() {
  clearTimeout(textTimer);
  if (textBuf && android.serial) hub.android.input(android.serial, { type: 'text', text: textBuf });
  textBuf = '';
}
document.querySelectorAll('.android-nav [data-key]').forEach((b) => (b.onclick = () => android.serial && hub.android.input(android.serial, { type: 'key', code: Number(b.dataset.key) })));

// ---------------- boot ----------------

(async () => {
  showView('chat');
  hub.settings.get().then((st) => {
    state.settings = st;
    $('#permMode').value = st.permissionMode;
    applyTheme(st.theme);
    syncSpecialistAgentControls();
  });
  applyLayout(); // tools panel starts hidden
  refreshWorkspaceUi();
  let running = await refreshStatus();
  if (!running) {
    // Ollama installed but not started — start it automatically.
    $('#ollamaStatus').textContent = 'Starting Ollama…';
    await hub.ollama.start().catch(() => {});
    running = await refreshStatus();
  }
  await loadModels();
  hub.accounts.status().then((st) => setOllamaSignedIn(!!st.ollama?.signedIn)).catch(() => {});
  const chats = await hub.chats.list();
  if (chats.length) await openChat(chats[0].id);
  else renderChat();
  if (!(await hub.settings.get()).setupDone) showView('setup');
  else if (!state.models.length) showView('library');
  setInterval(refreshStatus, 10000);
})();

// Debug/automation handle (used by smoke tests).
window.__app = { state, openChat, send, showView, openPanel, renderChat, refreshWorkspaceUi };
window.ptyStateDebug = () => ptyState;
