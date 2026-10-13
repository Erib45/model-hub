// Local HTTP bridge between the MCP server (a child of Claude Code) and the
// app. Listens on 127.0.0.1 only and requires a random per-run token.

const http = require('http');
const crypto = require('crypto');

function startBridge({ tools, getRunner }) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) return reply(403, { error: 'forbidden' });
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 10e6) req.destroy();
    });
    req.on('end', async () => {
      let p;
      try {
        p = JSON.parse(body || '{}');
      } catch {
        return reply(400, { error: 'bad json' });
      }
      if (req.url === '/tools') {
        return reply(200, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
      }
      if (req.url === '/call') {
        const run = getRunner(p.chatId);
        if (!run) return reply(200, { content: 'No active Model Hub chat turn for this tool call.', isError: true });
        try {
          return reply(200, await run(String(p.name || ''), p.arguments || {}));
        } catch (e) {
          return reply(200, { content: `Tool error: ${e.message}`, isError: true });
        }
      }
      reply(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, token, server })));
}

module.exports = { startBridge };
