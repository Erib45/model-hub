// Google Antigravity CLI (`agy`, official, unmodified) as a provider: Gemini on
// the user's own Google AI plan (Gemini CLI's successor for personal accounts).
// Runs with its own home folder so it's separate from any other Antigravity
// setup; sign-in is Antigravity's own browser flow in an in-app terminal tab.
// The app's tools are offered through MCP (written to the profile's mcp_config.json).
//
// agy keeps its sign-in in Windows Credential Manager (target
// "gemini:antigravity"), shared by every agy on this Windows account.
// stream-json events (observed with agy 1.3.5):
//   {event:"init", conversation_id}
//   {event:"step_update", step_update:{step_index, state: ACTIVE|DONE|ERROR,
//     step_type: user_input|agent_response|tool, text_delta?, tool_name?, tool_info?}}
//   {event:"result", result:{conversation_id, status, response, usage, denied_actions?}}

const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { buildPrompt, mcpServerEntry, stripMcpPrefix } = require('./cli-common');

const home = () => path.join(app.getPath('userData'), 'antigravity-home');

function findAgy() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [path.join(local, 'Antigravity', 'agy.exe'), path.join(local, 'Microsoft', 'WinGet', 'Links', 'agy.exe')];
  try {
    for (const d of fs.readdirSync(path.join(local, 'Microsoft', 'WinGet', 'Packages'))) {
      if (/^Google\.AntigravityCLI/i.test(d)) candidates.push(path.join(local, 'Microsoft', 'WinGet', 'Packages', d, 'agy.exe'));
    }
  } catch {}
  for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, 'agy.exe'));
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function env() {
  const e = { ...process.env, USERPROFILE: home(), HOME: home(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete e.GEMINI_API_KEY; // would take precedence over the Google sign-in
  delete e.GOOGLE_API_KEY;
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

const CRED_TARGET = 'gemini:antigravity';
// Signed in = Credential Manager has Antigravity's entry (checked by name only).
function hasCredential() {
  return new Promise((resolve) =>
    execFile('cmdkey', [`/list:${CRED_TARGET}`], { windowsHide: true }, (err, out) => resolve(!err && /target[:=]\s*gemini:antigravity\b/i.test(String(out))))
  );
}

// The app's tools via MCP, and headless allow-rules: Model Hub's tools (approvals
// happen in the app) and reading files. agy's own shell stays denied in headless
// mode, so commands go through Model Hub's approved terminal.
function writeProfileConfig(mcp) {
  const cfgDir = path.join(home(), '.gemini', 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({ mcpServers: mcp ? { modelhub: mcp } : {} }, null, 2));
  const settingsFile = path.join(home(), '.gemini', 'antigravity-cli', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {}
  const allow = new Set([...(settings.permissions?.allow || []), 'mcp(modelhub/*)', 'read_file(*)']);
  settings.permissions = { ...(settings.permissions || {}), allow: [...allow] };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(findAgy(), args, { env: env(), windowsHide: true, timeout: 30000, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code ?? 1 : 0, out: `${stdout || ''}${stderr || ''}` })
    );
  });
}

let statusCache = null;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b.text || '')).join('') : '');

module.exports = {
  id: 'antigravity',
  agentic: true,
  configDir: home,

  async status() {
    if (!findAgy()) return (statusCache = { installed: false, loggedIn: false, connected: false });
    const loggedIn = await hasCredential();
    statusCache = { installed: true, loggedIn, connected: loggedIn, method: 'google' };
    return statusCache;
  },

  async listModels(notes) {
    const s = statusCache || (await this.status());
    if (!s.loggedIn) return [];
    const id = 'antigravity:default';
    return [{
      id,
      provider: 'antigravity',
      name: 'default',
      title: 'Antigravity',
      tags: ['coding', 'agentic', 'research', 'subscription'],
      description: notes[id] ?? "Google's Antigravity agent (Gemini) on your Google AI plan (Pro/Ultra). Gemini CLI's successor for personal accounts; counts toward your plan's limits, not API billing.",
      customDescription: id in notes,
      capabilities: ['tools', 'thinking'],
      nativeTools: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextLength: 1000000,
    }];
  },

  forget() {
    statusCache = null;
  },

  // TRACE (github.com/axakon/TRACE) for Antigravity: agy installs Claude Code
  // format plugins from a folder, so keep a checkout of TRACE and install from it.
  async ensurePlugin({ update = false, checkOnly = false } = {}) {
    if (!findAgy()) return { ok: false, error: 'not installed' };
    const list = await run(['plugin', 'list']);
    const installed = /^- trace \(enabled, ([\d.]+)\)/m.exec(list.out);
    if (installed && !update) return { ok: true, version: installed[1] };
    if (!installed && checkOnly) return { ok: false, error: 'not installed yet (installs on first use)' };
    const src = path.join(app.getPath('userData'), 'trace-src');
    const git = (args, cwd) =>
      new Promise((resolve) => execFile('git', args, { cwd, windowsHide: true, timeout: 120000 }, (err, out, errOut) => resolve({ ok: !err, out: `${out}${errOut}` })));
    const r = fs.existsSync(path.join(src, '.git'))
      ? await git(['pull', '--ff-only', '--depth', '1'], src)
      : await git(['clone', '--depth', '1', 'https://github.com/axakon/TRACE.git', src], app.getPath('userData'));
    if (!r.ok && !fs.existsSync(path.join(src, 'deliverable', 'plugins', 'trace'))) return { ok: false, error: `couldn't download TRACE: ${r.out.trim().slice(-200)}` };
    const inst = await run(['plugin', 'install', path.join(src, 'deliverable', 'plugins', 'trace')], { timeout: 120000 });
    if (!/\[ok\][\s\S]*trace|ok.*trace/i.test(inst.out.replace(/\x1b\[[0-9;]*m/g, ''))) return { ok: false, error: inst.out.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-300) };
    return { ok: true, installed: !installed, version: (/^- trace \(enabled, ([\d.]+)\)/m.exec((await run(['plugin', 'list'])).out) || [])[1] };
  },

  // Antigravity's own sign-in (browser + paste the code), in an in-app terminal tab.
  login() {
    const exe = findAgy();
    if (!exe) throw new Error('Antigravity CLI is not installed. Install it from Settings → Check dependencies.');
    const cwd = path.join(home(), 'signin');
    fs.mkdirSync(cwd, { recursive: true });
    statusCache = null;
    return {
      file: exe,
      args: [],
      env: env(),
      cwd,
      title: 'Sign in: Antigravity',
      kind: 'login',
      provider: 'antigravity',
      hint: 'Antigravity opens your browser to sign in with Google. Copy the code it shows, paste it here (Ctrl+V) and press Enter. When Antigravity shows its prompt, you are done: close this tab with ×.',
    };
  },

  // Note: this signs out every agy on this Windows account (shared credential).
  async logout() {
    statusCache = null;
    await new Promise((r) => execFile('cmdkey', [`/delete:${CRED_TARGET}`], { windowsHide: true }, () => r()));
  },

  async complete({ system, prompt, model }) {
    const args = ['-p', `<instructions>\n${system}\n</instructions>\n\n${prompt}`.slice(0, 28000), '--output-format', 'json', '--print-timeout', '5m'];
    writeProfileConfig(null);
    const r = await run(args, { cwd: os.tmpdir(), timeout: 330000 });
    try {
      const res = JSON.parse(r.out.slice(r.out.indexOf('{')));
      const body = res.result && typeof res.result === 'object' ? res.result : res;
      if (body.status && body.status !== 'SUCCESS' && !body.response) throw new Error(`Antigravity: ${body.status}`);
      return body.response || (typeof res.result === 'string' ? res.result : '') || res.text || textOf(res.content) || '';
    } catch {
      if (r.code !== 0) throw new Error(`Antigravity: ${r.out.trim().slice(-400)}`);
      return r.out.trim();
    }
  },

  async chatTurn({ system, context, userText, resuming, sessionId, tools, cwd, bridge, chatId, effort, signal, onText, onThinking, emitMessage }) {
    const exe = findAgy();
    if (!exe) throw new Error('Antigravity CLI is not installed.');
    writeProfileConfig(tools && bridge ? mcpServerEntry({ ...bridge, chatId }) : null);
    const prompt = buildPrompt({
      context,
      userText,
      resuming,
      instructions: system + (tools && bridge ? '\nModel Hub provides a browser, terminal (with the user\'s approvals), file tools and a code graph through the "modelhub" MCP server. Prefer those tools for shell commands and web access.' : ''),
    });
    // Windows command lines max out around 32k characters: keep the newest part.
    const p = prompt.length > 28000 ? `[earlier context truncated]\n…${prompt.slice(-27900)}` : prompt;
    const args = ['-p', p, '--output-format', 'stream-json', '--mode', 'accept-edits'];
    if (effort) args.push('--effort', effort);
    if (resuming && sessionId) args.push('--conversation', sessionId);

    const child = spawn(exe, args, { env: env(), cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    signal.addEventListener('abort', kill);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    const model = 'antigravity:default';
    const result = { content: '', thinking: '', toolCalls: [], stats: null, sessionId };
    const tools_ = new Map(); // step_index -> { id, name, emitted, done }
    let text = '';
    let failure = null;
    let denied = [];
    const toolOutput = (info) => {
      if (!info) return '';
      if (info.error) return info.error.message || JSON.stringify(info.error);
      const { name, parameters, ...rest } = info;
      const v = rest.output ?? rest.result ?? rest.response ?? rest.content ?? rest;
      return typeof v === 'string' ? v : JSON.stringify(v);
    };
    for await (const line of readline.createInterface({ input: child.stdout })) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.event === 'init') {
        result.sessionId = ev.conversation_id || result.sessionId;
      } else if (ev.event === 'step_update') {
        const st = ev.step_update || {};
        result.sessionId = st.conversation_id || result.sessionId;
        if (st.step_type === 'agent_response') {
          if (st.thinking_delta) {
            result.thinking += st.thinking_delta;
            onThinking(st.thinking_delta);
          }
          if (st.text_delta) {
            text += st.text_delta;
            onText(st.text_delta);
          }
        } else if (st.step_type === 'tool') {
          let t = tools_.get(st.step_index);
          if (!t) {
            t = { id: `agy_${result.sessionId || 'x'}_${st.step_index}`, name: stripMcpPrefix(st.tool_name || st.tool_info?.name || 'tool') };
            tools_.set(st.step_index, t);
          }
          if (!t.emitted) {
            t.emitted = true;
            let args = st.tool_info?.parameters || {};
            // MCP calls arrive wrapped: call_mcp_tool { ServerName, ToolName, Arguments }.
            if (t.name === 'call_mcp_tool' && args.ToolName) {
              t.name = args.ServerName === 'modelhub' ? args.ToolName : `${args.ServerName}/${args.ToolName}`;
              args = args.Arguments || {};
            }
            emitMessage({ role: 'assistant', model, content: text, tool_calls: [{ id: t.id, name: t.name, arguments: args }] });
            text = '';
          }
          if (!t.done && (st.state === 'DONE' || st.state === 'ERROR')) {
            t.done = true;
            emitMessage({ role: 'tool', tool_call_id: t.id, tool_name: t.name, content: toolOutput(st.tool_info) || (st.state === 'ERROR' ? 'Failed' : 'Done'), ...(st.state === 'ERROR' ? { is_error: true } : {}) });
          }
        }
      } else if (ev.event === 'result') {
        const r = ev.result || {};
        result.sessionId = r.conversation_id || result.sessionId;
        if (r.status && r.status !== 'SUCCESS') failure = r.error?.message || r.status;
        if (!text.trim() && r.response) text = r.response;
        denied = r.denied_actions || [];
        const u = r.usage || {};
        result.stats = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheRead: u.cache_read_tokens || 0, ms: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : undefined, plan: 'Google AI' };
      } else if (ev.event === 'error') {
        failure = ev.error?.message || ev.message || 'Antigravity failed';
      }
    }
    if (denied.length) {
      result.notice = `Antigravity's own ${[...new Set(denied.map((d) => d.display_name || d.action))].join(', ')} tool isn't allowed in the app; it should use Model Hub's tools (with your approvals) instead.`;
    }
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('close', r)));
    signal.removeEventListener('abort', kill);
    if (signal.aborted) throw new Error('aborted');
    result.content = text;
    if (!result.content && failure) throw new Error(`Antigravity: ${failure}`.slice(0, 500));
    if (!result.content && !result.sessionId) {
      const msg = stderr.trim().split('\n').filter((l) => !/^\s*Warning/i.test(l)).join(' ').slice(0, 400) || 'Antigravity exited without an answer.';
      if (/sign in|login|auth|credential/i.test(msg)) throw new Error("Antigravity isn't signed in. Use Settings → Accounts → Antigravity → Sign in.");
      throw new Error(msg);
    }
    return result;
  },
};
