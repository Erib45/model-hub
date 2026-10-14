// OpenAI Codex CLI (official, unmodified) as a provider, signed in with the
// user's own ChatGPT plan through Codex's own `codex login` flow. Runs in its
// own CODEX_HOME so it's separate from any other Codex setup.
// Built-in tools that duplicate Model Hub's (shell, browser) are switched off;
// the app's tools arrive via MCP. Codex keeps its own file editing (apply_patch).

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { npmDir, nodeLaunch, spawnNodeCli, killTree, jsonLines, runToEnd, buildPrompt, mcpServerEntry, stripMcpPrefix } = require('./cli-common');

const home = () => path.join(app.getPath('userData'), 'codex');
const script = () => {
  const p = path.join(npmDir(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(p) ? p : null;
};

function env() {
  const e = { ...process.env, CODEX_HOME: home() };
  delete e.OPENAI_API_KEY; // would take precedence over the ChatGPT sign-in
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

// Codex built-ins that overlap with Model Hub's own tools.
const OVERLAPPING_FEATURES = ['shell_tool', 'unified_exec', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use'];

// TOML literal string (no escapes; Windows paths stay intact).
const tomlStr = (s) => `'${String(s).replace(/'/g, '')}'`;

let statusCache = null;

module.exports = {
  id: 'codexcli',
  agentic: true,
  configDir: home,

  async status() {
    if (!script()) return (statusCache = { connected: false, installed: false, loggedIn: false });
    fs.mkdirSync(home(), { recursive: true });
    // Codex stores its sign-in in CODEX_HOME/auth.json. Only check that the file
    // exists (never read it); this avoids starting Codex just to ask.
    const loggedIn = fs.existsSync(path.join(home(), 'auth.json'));
    statusCache = { installed: true, loggedIn, connected: loggedIn };
    return statusCache;
  },

  async listModels(notes) {
    const s = statusCache || (await this.status());
    if (!s.loggedIn) return [];
    const id = 'codexcli:default';
    return [{
      id,
      provider: 'codexcli',
      name: 'default',
      title: 'Codex',
      tags: ['coding', 'agentic', 'subscription'],
      description: notes[id] ?? "OpenAI's Codex agent on your ChatGPT plan (uses Codex's default model). Counts toward your ChatGPT plan limits instead of API billing.",
      customDescription: id in notes,
      capabilities: ['tools', 'thinking'],
      nativeTools: true,
      contextLength: 200000,
    }];
  },

  // TRACE plugin (github.com/axakon/TRACE) in the app's Codex profile.
  async ensurePlugin({ update = false, checkOnly = false } = {}) {
    if (!script()) return { ok: false, error: 'Codex CLI is not installed' };
    fs.mkdirSync(home(), { recursive: true });
    const run = (args) => runToEnd(spawnNodeCli(script(), args, env()));
    const list = await run(['plugin', 'list']);
    if (!/trace@trace\s+installed/.test(list.out + list.err)) {
      if (checkOnly) return { ok: false, error: 'not installed yet (installs on first use)' };
      const m = await run(['plugin', 'marketplace', 'add', 'axakon/TRACE']);
      if (m.code !== 0 && !/already/i.test(m.out + m.err)) return { ok: false, error: (m.err || m.out).trim().slice(-300) };
      const a = await run(['plugin', 'add', 'trace@trace']);
      if (a.code !== 0) return { ok: false, error: (a.err || a.out).trim().slice(-300) };
      return { ok: true, installed: true };
    }
    if (update) await run(['plugin', 'marketplace', 'upgrade', 'trace']);
    return { ok: true, version: ((list.out + list.err).match(/trace@trace\s+installed[^\n]*?\s([\d.]+)\s/) || [])[1] };
  },

  forget() {
    statusCache = null;
  },

  // Codex's own sign-in flow, run in an in-app terminal session (returns a launch spec).
  login() {
    if (!script()) throw new Error('Codex CLI is not installed. Install it from Settings → Check dependencies.');
    fs.mkdirSync(home(), { recursive: true });
    statusCache = null;
    return { ...nodeLaunch(script(), ['login'], env()), title: 'Sign in: Codex', kind: 'login', provider: 'codexcli' };
  },

  async logout() {
    statusCache = null;
    if (script()) await runToEnd(spawnNodeCli(script(), ['logout'], env()));
  },

  baseArgs({ cwd, mcp }) {
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', cwd, '-c', 'approval_policy="never"'];
    for (const f of OVERLAPPING_FEATURES) args.push('--disable', f);
    if (mcp) {
      const e = mcp;
      args.push('-c', `mcp_servers.modelhub.command=${tomlStr(e.command)}`);
      args.push('-c', `mcp_servers.modelhub.args=[${e.args.map(tomlStr).join(',')}]`);
      args.push('-c', `mcp_servers.modelhub.env={${Object.entries(e.env).map(([k, v]) => `${k}=${tomlStr(v)}`).join(',')}}`);
    }
    return args;
  },

  async complete({ system, prompt }) {
    const args = [...this.baseArgs({ cwd: require('os').tmpdir() }), '--ephemeral', '-'];
    const child = spawnNodeCli(script(), args, env(), { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(`<instructions>\n${system}\n</instructions>\n\n${prompt}`);
    let text = '';
    let error = '';
    for await (const ev of jsonLines(child)) {
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text || text;
      if (ev.type === 'turn.failed' || ev.type === 'error') error = ev.error?.message || ev.message || 'Codex failed';
    }
    if (!text && error) throw new Error(`Codex: ${error}`);
    return text;
  },

  async chatTurn({ system, context, userText, resuming, sessionId, tools, cwd, bridge, chatId, signal, onText, onThinking, emitMessage }) {
    if (!script()) throw new Error('Codex CLI is not installed (npm i -g @openai/codex).');
    const mcp = tools && bridge ? mcpServerEntry({ ...bridge, chatId }) : null;
    const args = this.baseArgs({ cwd, mcp });
    if (resuming) args.push('resume', sessionId, '-');
    else args.push('-');
    const prompt = buildPrompt({
      context,
      userText,
      resuming,
      instructions: system + (mcp ? '\nModel Hub provides your browser, terminal and file-writing tools through the "modelhub" MCP server. Use those for shell commands, web access and writing files.' : ''),
    });

    const child = spawnNodeCli(script(), args, env(), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => killTree(child);
    signal.addEventListener('abort', kill);
    child.stdin.end(prompt);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    const model = 'codexcli:default';
    const result = { content: '', thinking: '', toolCalls: [], stats: null, sessionId };
    let failure = null;
    const finalText = []; // agent messages; all but the last are intermediate
    const pushText = (t) => {
      if (finalText.length) emitMessage({ role: 'assistant', model, content: finalText.pop() });
      finalText.push(t);
    };

    for await (const ev of jsonLines(child)) {
      if (ev.type === 'thread.started' && ev.thread_id) result.sessionId = ev.thread_id;
      else if (ev.type === 'item.completed' && ev.item) {
        const it = ev.item;
        if (it.type === 'agent_message') {
          onText(it.text || '');
          pushText(it.text || '');
        } else if (it.type === 'reasoning') {
          onThinking((it.text || '') + '\n');
          result.thinking += (it.text || '') + '\n';
        } else if (it.type === 'mcp_tool_call' || it.type === 'command_execution' || it.type === 'file_change' || it.type === 'web_search') {
          const name = it.type === 'mcp_tool_call' ? stripMcpPrefix(it.tool) : it.type === 'command_execution' ? 'codex_shell' : it.type === 'file_change' ? 'codex_edit' : 'codex_web_search';
          const args = it.type === 'mcp_tool_call' ? it.arguments || {} : it.type === 'command_execution' ? { command: it.command } : it.type === 'file_change' ? { changes: it.changes } : { query: it.query };
          const callId = it.id || `codex_${Date.now()}`;
          if (finalText.length) emitMessage({ role: 'assistant', model, content: finalText.pop() });
          emitMessage({ role: 'assistant', model, content: '', tool_calls: [{ id: callId, name, arguments: args }] });
          const out =
            it.type === 'mcp_tool_call'
              ? it.error?.message || (it.result?.content || []).map((c) => c.text || '').join('\n') || JSON.stringify(it.result ?? '')
              : it.type === 'command_execution'
                ? `Exit code: ${it.exit_code}\n${it.aggregated_output || ''}`
                : it.type === 'file_change'
                  ? (it.changes || []).map((c) => `${c.kind} ${c.path}`).join('\n') || 'Files changed'
                  : 'Searched the web';
          emitMessage({ role: 'tool', tool_call_id: callId, tool_name: name, content: out, ...(it.status === 'failed' || it.error ? { is_error: true } : {}) });
        }
      } else if (ev.type === 'turn.completed') {
        const u = ev.usage || {};
        result.stats = { inputTokens: u.input_tokens, cacheRead: u.cached_input_tokens || 0, outputTokens: u.output_tokens, plan: 'ChatGPT' };
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        failure = ev.error?.message || ev.message || 'Codex failed';
      }
    }
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('close', r)));
    signal.removeEventListener('abort', kill);
    if (signal.aborted) throw new Error('aborted');
    result.content = finalText.pop() || '';
    if (!result.content && failure) {
      if (/401|unauthorized|not logged in|authentication/i.test(failure)) throw new Error("Codex isn't signed in. Use Settings → Accounts → Codex → Sign in.");
      throw new Error(`Codex: ${failure}`.slice(0, 500));
    }
    if (!result.content && !result.sessionId) {
      const msg = stderr.trim() || 'Codex exited without an answer.';
      if (/login|auth|unauthorized/i.test(msg)) throw new Error("Codex isn't signed in. Use Settings → Accounts → Codex.");
      throw new Error(msg.slice(0, 500));
    }
    return result;
  },
};
