// Google Gemini CLI (official, unmodified) as a provider, signed in with the
// user's own Google account through the CLI's own "Login with Google" flow.
// Runs with its own home folder (GEMINI_CLI_HOME) so it's separate from any
// other Gemini CLI setup. Built-in tools that duplicate Model Hub's (shell,
// web search/fetch, file read/write) are excluded; the app's tools arrive via
// MCP. Gemini keeps its own editing and file-search tools.

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { npmDir, openConsole, psQuote, spawnNodeCli, killTree, jsonLines, runToEnd, buildPrompt, mcpServerEntry, stripMcpPrefix } = require('./cli-common');

const home = () => path.join(app.getPath('userData'), 'gemini-home');
const dotGemini = () => path.join(home(), '.gemini');
const script = () => {
  const p = path.join(npmDir(), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
  return fs.existsSync(p) ? p : null;
};
const cmdShim = () => path.join(npmDir(), 'gemini.cmd');

const OVERLAPPING_TOOLS = ['run_shell_command', 'google_web_search', 'web_fetch', 'read_file', 'write_file'];

function env() {
  const e = { ...process.env, GEMINI_CLI_HOME: home() };
  // API keys would take precedence over the Google sign-in.
  delete e.GEMINI_API_KEY;
  delete e.GOOGLE_API_KEY;
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

// The app owns this profile's settings: Google sign-in, excluded tools, and
// (while a turn runs) the Model Hub MCP server.
function writeSettings(mcp) {
  fs.mkdirSync(dotGemini(), { recursive: true });
  const file = path.join(dotGemini(), 'settings.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const next = {
    ...current,
    security: { ...(current.security || {}), auth: { ...(current.security?.auth || {}), selectedType: 'oauth-personal' } },
    tools: { ...(current.tools || {}), exclude: OVERLAPPING_TOOLS },
    mcpServers: mcp ? { modelhub: { ...mcp, trust: true } } : {},
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

let statusCache = null;

module.exports = {
  id: 'geminicli',
  agentic: true,
  configDir: dotGemini,

  async status() {
    if (!script()) return (statusCache = { connected: false, installed: false, loggedIn: false });
    // Signed in when the CLI has stored its Google sign-in (we only check that the file exists).
    const loggedIn = fs.existsSync(path.join(dotGemini(), 'oauth_creds.json'));
    statusCache = { installed: true, loggedIn, connected: loggedIn, method: 'google' };
    return statusCache;
  },

  async listModels(notes) {
    const s = statusCache || (await this.status());
    if (!s.loggedIn) return [];
    const id = 'geminicli:default';
    return [{
      id,
      provider: 'geminicli',
      name: 'default',
      title: 'Gemini CLI',
      tags: ['coding', 'research', 'subscription'],
      description: notes[id] ?? "Google's Gemini agent on your Google account (Gemini CLI picks the model). Uses your account's free daily allowance or Google AI plan, not API billing.",
      customDescription: id in notes,
      capabilities: ['tools', 'thinking'],
      nativeTools: true,
      contextLength: 1000000,
    }];
  },

  forget() {
    statusCache = null;
  },

  login() {
    if (!script()) throw new Error('Gemini CLI is not installed (npm i -g @google/gemini-cli).');
    writeSettings(null);
    statusCache = null;
    openConsole(
      'Sign in to Gemini CLI (Model Hub)',
      `Write-Host 'Gemini CLI will open your browser to sign in with Google. When it shows its prompt, type /quit and press Enter.'; Write-Host ''; & ${psQuote(cmdShim())}`,
      env()
    );
  },

  async logout() {
    statusCache = null;
    // Gemini CLI has no logout command; removing its stored sign-in signs this profile out.
    for (const f of ['oauth_creds.json', 'google_accounts.json']) fs.rmSync(path.join(dotGemini(), f), { force: true });
  },

  async complete({ system, prompt }) {
    writeSettings(null);
    const child = spawnNodeCli(script(), ['-p', ' ', '-o', 'json', '--skip-trust'], env(), { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(`<instructions>\n${system}\n</instructions>\n\n${prompt}`);
    const r = await runToEnd(child);
    let res;
    try {
      res = JSON.parse(r.out.slice(r.out.indexOf('{')));
    } catch {
      throw new Error((r.err || r.out || 'Gemini CLI returned no output').trim().slice(0, 400));
    }
    if (res.error) throw new Error(`Gemini CLI: ${res.error.message || res.error}`);
    return res.response || '';
  },

  async chatTurn({ system, context, userText, resuming, sessionId, tools, cwd, bridge, chatId, signal, onText, emitMessage }) {
    if (!script()) throw new Error('Gemini CLI is not installed (npm i -g @google/gemini-cli).');
    const mcp = tools && bridge ? mcpServerEntry({ ...bridge, chatId }) : null;
    writeSettings(mcp);
    const args = ['-p', ' ', '-o', 'stream-json', '--skip-trust', '--approval-mode', 'auto_edit'];
    if (mcp) args.push('--allowed-mcp-server-names', 'modelhub');
    if (resuming) args.push('--resume', sessionId);
    const prompt = buildPrompt({
      context,
      userText,
      resuming,
      instructions: system + (mcp ? '\nModel Hub provides your shell, browser, web search and file read/write tools through the "modelhub" MCP server.' : ''),
    });

    const child = spawnNodeCli(script(), args, env(), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => killTree(child);
    signal.addEventListener('abort', kill);
    child.stdin.end(prompt);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    const model = 'geminicli:default';
    const result = { content: '', thinking: '', toolCalls: [], stats: null, sessionId };
    let text = ''; // assistant text since the last tool call
    let failure = null;
    const names = new Map();

    for await (const ev of jsonLines(child)) {
      if (ev.type === 'init' && ev.session_id) result.sessionId = ev.session_id;
      else if (ev.type === 'message' && ev.role === 'assistant') {
        const t = ev.content || '';
        text = ev.delta ? text + t : t;
        onText(ev.delta ? t : '');
      } else if (ev.type === 'tool_use') {
        const name = stripMcpPrefix(ev.tool_name);
        names.set(ev.tool_id, name);
        emitMessage({ role: 'assistant', model, content: text, tool_calls: [{ id: ev.tool_id, name, arguments: ev.parameters || {} }] });
        text = '';
      } else if (ev.type === 'tool_result') {
        emitMessage({
          role: 'tool',
          tool_call_id: ev.tool_id,
          tool_name: names.get(ev.tool_id) || 'tool',
          content: ev.status === 'error' ? ev.error?.message || 'Tool failed' : typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? ''),
          ...(ev.status === 'error' ? { is_error: true } : {}),
        });
      } else if (ev.type === 'error' && ev.severity === 'error') failure = ev.message;
      else if (ev.type === 'result') {
        if (ev.status === 'error') failure = ev.error?.message || 'Gemini CLI failed';
        const s = ev.stats || {};
        result.stats = { inputTokens: s.input_tokens ?? s.input, outputTokens: s.output_tokens ?? s.output, cacheRead: s.cached ?? 0, ms: s.duration_ms, plan: 'Google' };
      }
    }
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('close', r)));
    signal.removeEventListener('abort', kill);
    if (signal.aborted) throw new Error('aborted');
    result.content = text;
    if (!result.content && failure) throw new Error(`Gemini CLI: ${failure}`.slice(0, 500));
    if (!result.content && !result.sessionId) {
      const msg = stderr.trim() || 'Gemini CLI exited without an answer.';
      if (/auth|login|credential/i.test(msg)) throw new Error("Gemini CLI isn't signed in. Use Settings → Accounts → Gemini CLI.");
      throw new Error(msg.slice(0, 500));
    }
    return result;
  },
};
