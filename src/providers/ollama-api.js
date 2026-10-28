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
  if (buf.trim()) {
    const obj = JSON.parse(buf);
    if (obj.error) throw new Error(obj.error);
    onObj(obj);
  }
}

// Resilient model pull with speed/ETA tracking and automatic stall recovery.
// Ollama's multi-part downloader can stall on individual CDN range requests and
// stop advancing `completed` (often around ~50%). Aborting and re-requesting
// /api/pull resumes from the partial blob on disk with a fresh CDN connection.
async function pull(model, onProgress, signal) {
  const STALL_MS = 18000; // reconnect if bytes don't advance for 18s during a blob download
  const SILENT_MS = 25000; // or if the stream sends nothing at all for 25s
  const MAX_STALL_RETRIES = 10;

  let stallRetries = 0;
  const digestMax = new Map(); // digest -> highest completed byte count seen
  let currentDigest = '';
  let bestCompleted = 0;
  let bestTotal = 0;
  let lastStatus = 'starting…';
  let samples = []; // [{ t, bytes }] for rolling speed calculation

  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    const attemptCtrl = new AbortController();
    let stalled = false;
    const onUserAbort = () => attemptCtrl.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });

    let lastByteAdvanceAt = Date.now();
    let lastChunkAt = Date.now();
    let bytesAtAttemptStart = bestCompleted;

    const watchdog = setInterval(() => {
      const now = Date.now();
      const isTransferring = bestTotal > 0 && bestCompleted < bestTotal && /^pulling\b/i.test(lastStatus);
      const isFinalizing = /verifying|writing|success/i.test(lastStatus);
      if (isTransferring && now - lastByteAdvanceAt > STALL_MS) {
        stalled = true;
        attemptCtrl.abort();
      } else if (!isFinalizing && now - lastChunkAt > SILENT_MS) {
        stalled = true;
        attemptCtrl.abort();
      }
    }, 2000);

    try {
      await stream(
        '/api/pull',
        { model, stream: true },
        (obj) => {
          const now = Date.now();
          lastChunkAt = now;
          if (obj.status) lastStatus = obj.status;

          const key = obj.digest || obj.status || '';
          if (key && key !== currentDigest && typeof obj.total === 'number' && obj.total > 0) {
            currentDigest = key;
            bestTotal = obj.total;
            bestCompleted = digestMax.get(key) || 0;
            samples = [];
          }

          if (typeof obj.total === 'number' && obj.total > 0) {
            bestTotal = obj.total;
          }

          if (typeof obj.completed === 'number') {
            const prev = digestMax.get(key) || 0;
            if (obj.completed > prev) {
              digestMax.set(key, obj.completed);
              bestCompleted = obj.completed;
              lastByteAdvanceAt = now;
              samples.push({ t: now, b: obj.completed });
              const cutoff = now - 4500;
              while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
              if (bestCompleted - bytesAtAttemptStart >= 4 * 1024 * 1024) {
                stallRetries = 0; // reset retry counter once real progress is made
              }
            } else {
              bestCompleted = prev;
            }
          }

          let speed = 0;
          let eta = null;
          if (samples.length >= 2) {
            const dt = (now - samples[0].t) / 1000;
            const db = bestCompleted - samples[0].b;
            if (dt > 0.25 && db >= 0) {
              speed = db / dt;
              if (speed > 0 && bestTotal > bestCompleted) {
                eta = Math.round((bestTotal - bestCompleted) / speed);
              }
            }
          }

          onProgress({
            status: obj.status || lastStatus,
            digest: obj.digest,
            completed: bestTotal ? bestCompleted : obj.completed,
            total: bestTotal || obj.total,
            speed,
            eta,
            retrying: false,
          });
        },
        attemptCtrl.signal
      );
      return; // completed cleanly
    } catch (err) {
      if (signal?.aborted) throw err;
      const isTransient = stalled || attemptCtrl.signal.aborted || /fetch failed|ECONNRESET|UND_ERR|socket|EOF|network/i.test(err.message);
      if (!isTransient || ++stallRetries > MAX_STALL_RETRIES) {
        throw new Error(stalled ? `Download stalled repeatedly at ${bestTotal ? Math.round((100 * bestCompleted) / bestTotal) + '%' : lastStatus}. Check your connection or click Retry.` : err.message);
      }
      samples = [];
      onProgress({
        status: `Connection stalled — reconnecting (${stallRetries}/${MAX_STALL_RETRIES})…`,
        completed: bestCompleted || undefined,
        total: bestTotal || undefined,
        speed: 0,
        eta: null,
        retrying: true,
      });
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      clearInterval(watchdog);
      signal?.removeEventListener('abort', onUserAbort);
    }
  }
}

module.exports = {
  BASE,
  stream,
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
  pull,
  // keep_alive 0 evicts the model from VRAM immediately.
  unload: (model) => json('/api/generate', { model, keep_alive: 0 }).catch(() => {}),
  chat: (body, onChunk, signal) => stream('/api/chat', { ...body, stream: true }, onChunk, signal),
};
