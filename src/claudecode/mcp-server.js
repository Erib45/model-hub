// Minimal MCP server (stdio, JSON-RPC 2.0) that Claude Code launches to get
// Model Hub's tools. Each call is forwarded to the app over a local HTTP
// bridge, so the app's approvals, AI reviewer, browser and terminal apply.
// Runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1).

const http = require('http');
const readline = require('readline');

const PORT = Number(process.env.MH_PORT);
const TOKEN = process.env.MH_TOKEN;
const CHAT = process.env.MH_CHAT;

function bridge(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Bad response from Model Hub: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'modelhub', version: '0.1.0' },
        },
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      const { tools } = await bridge('/tools', { chatId: CHAT });
      return send({ jsonrpc: '2.0', id, result: { tools } });
    }
    if (method === 'tools/call') {
      const r = await bridge('/call', { chatId: CHAT, name: params.name, arguments: params.arguments || {} });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.content || '' }], isError: !!r.isError } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg);
});
