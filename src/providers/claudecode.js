// Claude Code (the official `claude` CLI, unmodified) as a model provider, using
// whatever Claude plan the user signs in with. Sign-in happens through
// Anthropic's own flow (`claude auth login`); the app never reads or stores
// credentials. Claude Code runs in its own profile folder, separate from the
// user's normal Claude Code setup, and gets Model Hub's tools via MCP.
//
// Unlike the other providers, Claude Code runs its own agent loop: one
// chatTurn() covers a whole answer, including any tool calls it makes.

const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { mcpServerEntry } = require('./cli-common');

// Claude Code built-ins that duplicate Model Hub's tools.
const OVERLAPPING_TOOLS = ['Bash', 'PowerShell', 'Write', 'WebFetch', 'WebSearch'];

const MODELS = [
  ['opus', 'Opus', ['coding', 'agentic', 'research'], 'Most capable Claude for complex coding and long agentic work. Uses your Claude plan instead of API billing.'],
  ['sonnet', 'Sonnet', ['coding', 'general'], 'Fast, highly capable Claude for everyday coding. Uses your Claude plan instead of API billing.'],
  ['haiku', 'Haiku', ['fast'], 'Fastest Claude. Uses your Claude plan instead of API billing.'],
];

const configDir = () => path.join(app.getPath('userData'), 'claude-code');

function findClaude() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd'));
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Environment for the CLI: the app's own profile folder, and no API keys
// (they would take precedence over the signed-in plan).
function cliEnv() {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir() };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function spawnClaude(args, opts = {}) {
  const exe = findClaude();
  if (!exe) throw new Error('Claude Code is not installed. Install it from https://claude.com/claude-code');
  // .cmd shims (npm installs) need a shell on Windows.
  return spawn(exe, args, { env: cliEnv(), windowsHide: true, shell: exe.endsWith('.cmd'), ...opts });
}

let statusCache = null;
async function authStatus(refresh) {
  if (statusCache && !refresh) return statusCache;
  if (!findClaude()) return (statusCache = { installed: false, loggedIn: false });
  statusCache = await new Promise((resolve) => {
    fs.mkdirSync(configDir(), { recursive: true });
    const child = spawnClaude(['auth', 'status']);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ installed: true, loggedIn: false }));
    child.on('close', () => {
      try {
        const s = JSON.parse(out);
        resolve({ installed: true, loggedIn: !!s.loggedIn, method: s.authMethod, plan: s.subscriptionType, org: s.orgName });
      } catch {
        resolve({ installed: true, loggedIn: false });
      }
    });
  });
  return statusCache;
}

// Renders chat messages as plain text context for Claude Code.
function renderContext(messages) {
  return messages
    .map((m) => {
      if (m.role === 'user') return m.kind === 'summary' ? m.content : `[user] ${m.content}`;
      if (m.role === 'assistant' && m.content) return m.handedBack ? m.content : `[assistant${m.model ? ` (${m.model})` : ''}] ${m.content}`;
      if (m.role === 'tool') return `[tool result: ${m.tool_name}] ${(m.content || '').slice(0, 4000)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const stripPrefix = (name) => name.replace(/^mcp__modelhub__/, '');

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content ?? '');
}

module.exports = {
  id: 'claudecode',
  agentic: true,
  label: 'Claude Code',
  configDir,
  authStatus,

  async status() {
    const s = await authStatus(true);
    return { connected: s.loggedIn, ...s };
  },

  async listModels(notes) {
    const s = await authStatus();
    if (!s.loggedIn) return [];
    return MODELS.map(([alias, title, tags, desc]) => {
      const id = `claudecode:${alias}`;
      return {
        id,
        provider: 'claudecode',
        name: alias,
        title: `Claude Code · ${title}`,
        tags: [...tags, 'subscription'],
        description: notes[id] ?? desc,
        customDescription: id in notes,
        capabilities: ['tools', 'thinking'],
        nativeTools: true,
        contextLength: 200000,
      };
    });
  },

  forget() {
    statusCache = null;
  },

  // One-shot request without tools (used by Compact and the AI model picker).
  async complete({ model, system, prompt }) {
    const args = ['-p', '--output-format', 'json', '--model', model, '--append-system-prompt', system, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none'];
    const child = spawnClaude(args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(prompt);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    await new Promise((r) => child.on('close', r));
    let res;
    try {
      res = JSON.parse(out);
    } catch {
      throw new Error((err || out || 'Claude Code returned no output').trim().slice(0, 400));
    }
    if (res.is_error) throw new Error(`Claude Code: ${res.result || res.subtype}`.slice(0, 400));
    return res.result || '';
  },

  // Anthropic's own sign-in flow, run in an in-app terminal session (returns a launch spec).
  login() {
    const exe = findClaude();
    if (!exe) throw new Error('Claude Code is not installed. Install it from Settings → Check dependencies.');
    fs.mkdirSync(configDir(), { recursive: true });
    statusCache = null;
    const launch = exe.endsWith('.cmd') ? { file: 'cmd.exe', args: ['/c', exe, 'auth', 'login'] } : { file: exe, args: ['auth', 'login'] };
    return { ...launch, env: cliEnv(), title: 'Sign in: Claude Code', kind: 'login', provider: 'claudecode' };
  },

  logout() {
    statusCache = null;
    return new Promise((resolve) => {
      const child = spawnClaude(['auth', 'logout']);
      child.on('close', resolve);
      child.on('error', resolve);
    });
  },

  /**
   * One full Claude Code answer. `session` = { sessionId, cwd, upTo } from the
   * previous Claude Code turn in this chat, or null. Intermediate steps (tool
   * calls and results) are reported through emitMessage as they happen.
   */
  async chatTurn({ model, system, context, userText, resuming, sessionId, tools, cwd, bridge, chatId, signal, onText, onThinking, emitMessage }) {
    let mcpConfigPath = null;
    if (tools && bridge) {
      mcpConfigPath = path.join(configDir(), `mcp-${chatId.replace(/[^\w-]/g, '')}.json`);
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { modelhub: { type: 'stdio', ...mcpServerEntry({ ...bridge, chatId }) } } }, null, 2));
    }
    // New session: the conversation so far as context. Resumed session: only
    // what happened in this chat since Claude Code last answered.
    const ctx = renderContext(context);
    const prompt = ctx
      ? `${resuming ? 'Since your last reply, this happened in the chat (other models or summaries):' : 'Conversation so far in this Model Hub chat:'}

${ctx}

---

${userText}`
      : userText;

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model];
    if (resuming) args.push('--resume', sessionId);
    args.push(
      '--append-system-prompt',
      system + (mcpConfigPath ? '\nModel Hub provides your shell, browser, web search and file-writing tools as mcp__modelhub__<tool>; use those for running commands, web access and creating files.' : '')
    );
    if (mcpConfigPath) {
      // Keep Claude Code's own tools, except the ones Model Hub provides (so they go
      // through the app's approvals, AI reviewer, terminal and browser). Read stays:
      // Claude Code's Edit tool requires it.
      args.push('--disallowedTools', ...OVERLAPPING_TOOLS);
      args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', 'mcp__modelhub');
      args.push('--permission-mode', 'acceptEdits');
    } else {
      args.push('--tools', '', '--strict-mcp-config'); // Tools switched off in the chat: plain conversation
    }
    args.push('--permission-prompts', 'none');

    const child = spawnClaude(args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    signal.addEventListener('abort', kill);
    child.stdin.end(prompt);

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const result = { content: '', thinking: '', toolCalls: [], stats: null, sessionId };
    let pending = null; // assistant message being assembled (one API message may arrive in several events)
    const toolNames = new Map(); // tool_use id -> tool name

    const flush = () => {
      if (!pending) return;
      const msg = { role: 'assistant', model: `claudecode:${model}`, content: pending.text };
      if (pending.thinking) msg.thinking = pending.thinking;
      if (pending.calls.length) msg.tool_calls = pending.calls;
      pending = null;
      if (msg.tool_calls) emitMessage(msg); // intermediate step
      else {
        // Text-only: could be the final answer; keep the latest one.
        if (result.content) emitMessage({ role: 'assistant', model: msg.model, content: result.content, ...(result.thinking ? { thinking: result.thinking } : {}) });
        result.content = msg.content;
        result.thinking = msg.thinking || '';
      }
    };

    const lines = readline.createInterface({ input: child.stdout });
    let resultEvent = null;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.session_id) result.sessionId = ev.session_id;
      if (ev.type === 'stream_event') {
        const d = ev.event?.delta;
        if (ev.event?.type === 'content_block_delta' && d) {
          if (d.type === 'text_delta') onText(d.text);
          else if (d.type === 'thinking_delta') onThinking(d.thinking);
        }
      } else if (ev.type === 'assistant') {
        const id = ev.message?.id;
        if (pending && pending.id !== id) flush();
        pending ||= { id, text: '', thinking: '', calls: [] };
        for (const b of ev.message?.content || []) {
          if (b.type === 'text') pending.text += b.text;
          else if (b.type === 'thinking') pending.thinking += b.thinking || '';
          else if (b.type === 'tool_use') {
            toolNames.set(b.id, stripPrefix(b.name));
            pending.calls.push({ id: b.id, name: stripPrefix(b.name), arguments: b.input || {} });
          }
        }
      } else if (ev.type === 'user') {
        flush();
        for (const b of ev.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          emitMessage({ role: 'tool', tool_call_id: b.tool_use_id, tool_name: toolNames.get(b.tool_use_id) || 'tool', content: toolResultText(b.content), ...(b.is_error ? { is_error: true } : {}) });
        }
      } else if (ev.type === 'result') {
        flush();
        resultEvent = ev;
      }
    }
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('close', r)));
    signal.removeEventListener('abort', kill);
    if (signal.aborted) throw new Error('aborted');

    if (!resultEvent) {
      const msg = stderr.trim() || 'Claude Code exited without an answer.';
      if (/not logged in|login|auth/i.test(msg)) throw new Error(`Claude Code isn't signed in. Use Settings → Accounts → Claude Code. (${msg.slice(0, 200)})`);
      throw new Error(msg.slice(0, 500));
    }
    if (resultEvent.is_error) {
      const msg = String(resultEvent.result || result.content || resultEvent.subtype || 'error');
      if (/not logged in|\/login/i.test(msg)) throw new Error("Claude Code isn't signed in. Use Settings → Accounts → Claude Code → Sign in.");
      throw new Error(`Claude Code: ${msg}`.slice(0, 500));
    }
    if (!result.content && resultEvent.result) result.content = resultEvent.result;
    const u = resultEvent.usage || {};
    result.stats = {
      outputTokens: u.output_tokens,
      inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cacheRead: u.cache_read_input_tokens || 0,
      ms: resultEvent.duration_ms,
      plan: true,
    };
    return result;
  },
};
