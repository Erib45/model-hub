// Shared helpers for the subscription CLI providers (Claude Code, Codex,
// Gemini CLI). Each runs the provider's official, unmodified CLI in its own
// profile folder; sign-in happens in the provider's own flow in a console
// window, and the app never reads or stores credentials.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const npmDir = () => path.join(process.env.APPDATA || '', 'npm');

// Opens a visible PowerShell window (sign-in flows may need typing/pasting).
function openConsole(title, command, env) {
  const script = `$host.UI.RawUI.WindowTitle = '${title.replace(/'/g, "''")}'; ${command}; Write-Host ''; Write-Host 'You can close this window.'; Read-Host 'Press Enter to close'`;
  spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoProfile', '-Command', script], { env, detached: true, stdio: 'ignore' }).unref();
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Runs a Node-based CLI script with Electron's bundled Node, so it works even
// if Node isn't on PATH.
function spawnNodeCli(script, args, env, opts = {}) {
  return spawn(process.execPath, [script, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, ...opts });
}

function killTree(child) {
  if (child?.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
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

module.exports = { npmDir, openConsole, psQuote, spawnNodeCli, killTree, jsonLines, runToEnd, renderContext, buildPrompt, mcpServerEntry, stripMcpPrefix };
