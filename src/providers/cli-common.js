// Shared helpers for the subscription CLI providers (Claude Code, Codex,
// Gemini CLI). Each runs the provider's official, unmodified CLI in its own
// profile folder; sign-in happens in the provider's own flow in a console
// window, and the app never reads or stores credentials.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const npmDir = () => path.join(process.env.APPDATA || '', 'npm');

// Prefer the real node.exe: it's a console program, so with windowsHide it gets
// a hidden console that every process it starts inherits. (Electron's own Node
// has no console, so CLIs that launch helper programs, like Codex's launcher,
// would flash a visible console window.) Falls back to Electron's bundled Node.
function findNode() {
  const candidates = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'node.exe'));
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// How to launch a Node-based CLI script (used for in-app terminal sessions).
function nodeLaunch(script, args, env) {
  const node = findNode();
  return node ? { file: node, args: [script, ...args], env } : { file: process.execPath, args: [script, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

function spawnNodeCli(script, args, env, opts = {}) {
  const node = findNode();
  if (node) return spawn(node, [script, ...args], { env, windowsHide: true, ...opts });
  return spawn(process.execPath, [script, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, ...opts });
}

function killTree(child) {
  if (child?.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

// Yields parsed JSON objects from a child's stdout (one per line).
async function* jsonLines(child) {
  for await (const line of readline.createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

function runToEnd(child) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Plain-text rendering of chat messages, used as context for a CLI agent.
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

function buildPrompt({ context, userText, resuming, instructions }) {
  const ctx = renderContext(context);
  const parts = [];
  if (instructions) parts.push(`<instructions>\n${instructions}\n</instructions>`);
  if (ctx) parts.push(`${resuming ? 'Since your last reply, this happened in the chat (other models or summaries):' : 'Conversation so far in this Model Hub chat:'}\n\n${ctx}\n\n---`);
  parts.push(userText);
  return parts.join('\n\n');
}

// The MCP server entry Claude Code / Codex / Gemini launch to reach the app's tools.
function mcpServerEntry({ port, token, chatId }) {
  return {
    command: process.execPath,
    args: [path.join(__dirname, '..', 'claudecode', 'mcp-server.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)],
    env: { ELECTRON_RUN_AS_NODE: '1', MH_PORT: String(port), MH_TOKEN: token, MH_CHAT: chatId },
  };
}

// Our tool names, as CLIs may prefix MCP tools ("mcp__modelhub__x", "modelhub__x", "mcp_modelhub_x").
const stripMcpPrefix = (name) => String(name || '').replace(/^(mcp__modelhub__|mcp_modelhub_|modelhub__|modelhub\.)/, '');

module.exports = { npmDir, findNode, nodeLaunch, spawnNodeCli, killTree, jsonLines, runToEnd, renderContext, buildPrompt, mcpServerEntry, stripMcpPrefix };
