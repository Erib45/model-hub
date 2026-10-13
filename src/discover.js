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

function sha256File(file, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const total = fs.statSync(file).size;
    let done = 0;
    fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (chunk) => {
        hash.update(chunk);
        done += chunk.length;
        onProgress(done, total);
      })
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// Imports a local GGUF file as an Ollama model named `name`.
async function importGguf(file, name, onProgress) {
  if (!/\.gguf$/i.test(file)) throw new Error('Only .gguf files can be imported');
  const total = fs.statSync(file).size;
  const digest = 'sha256:' + (await sha256File(file, (d, t) => onProgress({ status: 'hashing file', completed: d, total: t })));

  const head = await fetch(`${api.BASE}/api/blobs/${digest}`, { method: 'HEAD' });
  if (head.status !== 200) {
    let sent = 0;
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (c) => {
      sent += c.length;
      onProgress({ status: 'copying into Ollama', completed: sent, total });
    });
    const res = await fetch(`${api.BASE}/api/blobs/${digest}`, { method: 'POST', body: Readable.toWeb(stream), duplex: 'half' });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  }

  const res = await fetch(`${api.BASE}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, files: { [path.basename(file)]: digest }, stream: true }),
  });
  if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  for (const line of text.split('\n').filter(Boolean)) {
    const obj = JSON.parse(line);
    if (obj.error) throw new Error(obj.error);
    onProgress({ status: obj.status });
  }
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
