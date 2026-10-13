// Thin client for the local Ollama HTTP API (http://127.0.0.1:11434).

const BASE = process.env.OLLAMA_HOST
  ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`)
  : 'http://127.0.0.1:11434';

async function json(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Streams newline-delimited JSON, calling onObj for each parsed line.
async function stream(path, body, onObj, signal) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const obj = JSON.parse(line);
        if (obj.error) throw new Error(obj.error);
        onObj(obj);
      }
    }
  }
  if (buf.trim()) onObj(JSON.parse(buf));
}

module.exports = {
  BASE,
  async status() {
    try {
      const v = await json('/api/version');
      return { running: true, version: v.version };
    } catch {
      return { running: false };
    }
  },
  list: () => json('/api/tags').then((r) => r.models || []),
  running: () => json('/api/ps').then((r) => r.models || []),
  show: (model) => json('/api/show', { model }),
  remove: (model) => json('/api/delete', { model }, 'DELETE'),
  pull: (model, onProgress, signal) => stream('/api/pull', { model, stream: true }, onProgress, signal),
  // keep_alive 0 evicts the model from VRAM immediately.
  unload: (model) => json('/api/generate', { model, keep_alive: 0 }).catch(() => {}),
  chat: (body, onChunk, signal) => stream('/api/chat', { ...body, stream: true }, onChunk, signal),
};
