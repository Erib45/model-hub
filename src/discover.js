// Model discovery and import:
//  - Ollama library search (ollama.com has no JSON API; we return the HTML and
//    the renderer parses it with DOMParser)
//  - Hugging Face GGUF search (JSON API); Ollama pulls these as hf.co/<repo>:<quant>
//  - Importing a local .gguf file into Ollama (blob upload + /api/create)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const api = require('./providers/ollama-api');
const { hfAccount } = require('./accounts');

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ModelHub/0.1', ...headers } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

async function ollamaSearch({ q = '', c = '', o = 'popular', page = 1 }) {
  const params = new URLSearchParams({ q, o });
  if (c) params.set('c', c);
  if (page > 1) params.set('page', String(page));
  // Later pages are only served to htmx requests.
  return getText(`https://ollama.com/search?${params}`, page > 1 ? { 'HX-Request': 'true' } : {});
}

async function ollamaTags(name) {
  if (!/^[\w.\-/]+$/.test(name)) throw new Error('Invalid model name');
  return getText(`https://ollama.com/library/${name}/tags`);
}

async function hfSearch(q) {
  const params = new URLSearchParams({ search: q || '', filter: 'gguf', sort: 'downloads', direction: '-1', limit: '40' });
  return JSON.parse(await getText(`https://huggingface.co/api/models?${params}`, hfAccount.authHeaders()));
}

// Lists the GGUF quantizations in a repo with their sizes.
async function hfFiles(repo) {
  if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) throw new Error('Invalid repo');
  const info = JSON.parse(await getText(`https://huggingface.co/api/models/${repo}?blobs=true`, hfAccount.authHeaders()));
  const byQuant = new Map();
  for (const f of info.siblings || []) {
    const name = f.rfilename;
    if (!/\.gguf$/i.test(name) || /mmproj/i.test(name)) continue;
    const m = name.match(/[-_.]((?:IQ|Q|BF|F)\d[\w]*?)(?:-\d{5}-of-\d{5})?\.gguf$/i);
    const quant = m ? m[1].toUpperCase() : name.replace(/\.gguf$/i, '');
    const prev = byQuant.get(quant) || { quant, size: 0, files: 0 };
    prev.size += f.size || f.lfs?.size || 0;
    prev.files++;
    byQuant.set(quant, prev);
  }
  // For gated repos, check whether this account has accepted the license.
  let access = info.gated ? 'unknown' : 'open';
  const firstFile = (info.siblings || []).find((f) => /\.gguf$/i.test(f.rfilename));
  if (info.gated && firstFile && hfAccount.token()) {
    const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(firstFile.rfilename)}`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: hfAccount.authHeaders(),
    }).catch(() => null);
    access = res && (res.status < 400) ? 'granted' : 'needs-approval';
  }
  return { repo, gated: !!info.gated, access, quants: [...byQuant.values()].sort((a, b) => a.size - b.size) };
}

function sha256File(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const total = fs.statSync(file).size;
    let done = 0;
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    const onAbort = () => stream.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    stream
      .on('data', (chunk) => {
        hash.update(chunk);
        done += chunk.length;
        onProgress(done, total);
      })
      .on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(hash.digest('hex'));
      })
      .on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

// Imports a local GGUF file as an Ollama model named `name`.
async function importGguf(file, name, onProgress, signal) {
  if (!/\.gguf$/i.test(file)) throw new Error('Only .gguf files can be imported');
  const total = fs.statSync(file).size;
  const fullWork = total * 2; // step 1: hash (0..50%), step 2: upload (50..100%)
  const digest =
    'sha256:' +
    (await sha256File(
      file,
      (d) => onProgress({ status: 'verifying GGUF file (step 1/2)', completed: Math.round(d * 0.5), total }),
      signal
    ));

  const head = await fetch(`${api.BASE}/api/blobs/${digest}`, { method: 'HEAD', signal });
  if (head.status !== 200) {
    let sent = 0;
    const nodeStream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    // Consume via async iterator so the stream isn't put into flowing mode before Readable.toWeb reads it.
    const tracked = Readable.from(
      (async function* () {
        for await (const chunk of nodeStream) {
          if (signal?.aborted) throw new Error('aborted');
          sent += chunk.length;
          onProgress({
            status: 'copying into Ollama (step 2/2)',
            completed: Math.round(total * 0.5 + sent * 0.5),
            total,
          });
          yield chunk;
        }
      })()
    );
    const res = await fetch(`${api.BASE}/api/blobs/${digest}`, {
      method: 'POST',
      headers: { 'Content-Length': String(total) },
      body: Readable.toWeb(tracked),
      duplex: 'half',
      signal,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  } else {
    onProgress({ status: 'blob already in Ollama store', completed: total, total });
  }

  await api.stream(
    '/api/create',
    { model: name, files: { [path.basename(file)]: digest }, stream: true },
    (obj) => onProgress({ status: obj.status || 'creating model…', completed: total, total }),
    signal
  );
}

let sysInfo = null;
function systemInfo() {
  if (sysInfo) return Promise.resolve(sysInfo);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true }, (err, out) => {
      let gpu = null;
      let vram = 0;
      if (!err) {
        const [n, mem] = out.toString().trim().split('\n')[0].split(',').map((s) => s.trim());
        gpu = n;
        vram = Number(mem) * 1024 * 1024;
      }
      sysInfo = { gpu, vram, ram: os.totalmem() };
      resolve(sysInfo);
    });
  });
}

module.exports = { ollamaSearch, ollamaTags, hfSearch, hfFiles, importGguf, systemInfo };
