// Repo knowledge: a code graph (SQLite) and a fact sheet (Markdown) per
// repository, stored in the app's data folder (nothing is written into the
// repo). Rebuilt when a repo is first seen and whenever its upstream changes
// (push or pull). Models query it through the repo_facts / code_graph tools.

const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { extract, layerOf, normPath, LANG_BY_EXT } = require('./extract');

const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES = 15000;
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|target|bin|obj|\.next|\.nuxt|coverage|__pycache__|\.venv|venv)\//;
const NODE_BUILTINS = new Set(require('module').builtinModules);
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

function git(cwd, args) {
  return new Promise((resolve) =>
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (err, out) => resolve(err ? null : out.toString()))
  );
}

const dirFor = (repo) => path.join(app.getPath('userData'), 'repo-index', crypto.createHash('sha1').update(path.resolve(repo).toLowerCase()).digest('hex').slice(0, 12));
const metaFile = (repo) => path.join(dirFor(repo), 'meta.json');
const readMeta = (repo) => {
  try {
    return JSON.parse(fs.readFileSync(metaFile(repo), 'utf8'));
  } catch {
    return null;
  }
};

// ---------- import resolution ----------

function makeResolver(files, parsed) {
  const set = new Set(files);
  const pyModules = new Map(); // dotted module -> file
  const nsFiles = new Map(); // C#/Java/Go namespace/package -> files
  for (const f of files) {
    if (f.endsWith('.py')) {
      const mod = f.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/');
      // register every suffix so "app.models" matches "src/app/models.py"
      for (let i = 0; i < mod.length; i++) pyModules.set(mod.slice(i).join('.'), f);
    }
    const ns = parsed.get(f)?.namespace;
    if (ns) {
      const key = f.endsWith('.go') ? path.posix.dirname(f) : ns;
      if (!nsFiles.has(key)) nsFiles.set(key, []);
      nsFiles.get(key).push(f);
    }
  }
  const tryJs = (base) => {
    for (const c of [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => base + '/index' + e)]) if (set.has(c)) return c;
    return null;
  };
  return (from, spec, lang) => {
    if (lang === 'js') {
      if (spec.startsWith('.')) return { file: tryJs(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))) };
      if (/^[@~]\//.test(spec)) return { file: tryJs('src/' + spec.slice(2)) || tryJs(spec.slice(2)) };
      const name = spec.replace(/^node:/, '').split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
      return { module: name, builtin: spec.startsWith('node:') || NODE_BUILTINS.has(name) };
    }
    if (lang === 'py') {
      if (typeof spec === 'object') {
        const up = spec.rel.match(/^\.+/)[0].length;
        let dir = path.posix.dirname(from);
        for (let i = 1; i < up; i++) dir = path.posix.dirname(dir);
        const mod = spec.rel.slice(up);
        const base = mod ? path.posix.join(dir, mod.replace(/\./g, '/')) : dir;
        return { file: [base + '.py', base + '/__init__.py'].find((c) => set.has(c)) || null };
      }
      const f = pyModules.get(spec);
      return f ? { file: f } : { module: spec.split('.')[0] };
    }
    if (lang === 'cs' || lang === 'java') {
      const hit = nsFiles.get(spec) || nsFiles.get(spec.split('.').slice(0, -1).join('.'));
      return hit ? { files: hit.slice(0, 20) } : { module: spec.split('.').slice(0, 2).join('.') };
    }
    if (lang === 'go') {
      const dir = [...nsFiles.keys()].find((d) => d && spec.endsWith('/' + d));
      return dir ? { files: nsFiles.get(dir).slice(0, 20) } : { module: spec };
    }
    return {};
  };
}

// ---------- build ----------

const running = new Map();

async function build(repo, onProgress = () => {}) {
  const listed = await git(repo, ['ls-files', '-co', '--exclude-standard', '-z']);
  if (listed === null) throw new Error(`${repo} is not a git repository`);
  const all = listed.split('\0').filter(Boolean);
  const files = all.filter((f) => LANG_BY_EXT[path.extname(f).toLowerCase()] && !SKIP_DIR.test(f) && !/\.min\.\w+$/.test(f)).slice(0, MAX_FILES);

  const parsed = new Map();
  for (let i = 0; i < files.length; i++) {
    const abs = path.join(repo, files[i]);
    try {
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const r = extract(files[i], fs.readFileSync(abs, 'utf8'));
      if (r) parsed.set(files[i], r);
    } catch {}
    if (i % 200 === 199) {
      onProgress(`Reading files ${i + 1}/${files.length}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  const dir = dirFor(repo);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `graph-${process.pid}-${Date.now()}.db`);
  const db = new DatabaseSync(tmp);
  db.exec(`
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, key TEXT UNIQUE, name TEXT, file TEXT, line INTEGER, layer TEXT, lang TEXT, data TEXT);
    CREATE TABLE edges (src INTEGER, dst INTEGER, kind TEXT, line INTEGER);
    CREATE INDEX edges_src ON edges(src); CREATE INDEX edges_dst ON edges(dst); CREATE INDEX nodes_name ON nodes(name);
  `);
  const insNode = db.prepare('INSERT OR IGNORE INTO nodes (kind, key, name, file, line, layer, lang, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const getId = db.prepare('SELECT id, data FROM nodes WHERE key = ?');
  const setData = db.prepare('UPDATE nodes SET data = ? WHERE id = ?');
  const insEdge = db.prepare('INSERT INTO edges (src, dst, kind, line) VALUES (?, ?, ?, ?)');
  const node = (kind, key, name, file = null, line = null, layer = null, lang = null, data = null) => {
    insNode.run(kind, key, name, file, line, layer, lang, data ? JSON.stringify(data) : null);
    return getId.get(key).id;
  };

  const resolve = makeResolver([...parsed.keys()], parsed);
  db.exec('BEGIN');
  const fileId = new Map();
  for (const [f, r] of parsed) fileId.set(f, node('file', `file:${f}`, f, f, 1, layerOf(f), r.lang, { lines: r.lines }));
  const epId = (kind, norm, raw) => node('endpoint', `ep:${kind}:${norm}`, kind === 'ipc' ? norm : norm || '/', null, null, null, null, { kind, raw });
  for (const [f, r] of parsed) {
    const src = fileId.get(f);
    for (const imp of r.imports) {
      const res = resolve(f, imp, r.lang);
      for (const target of res.files || (res.file ? [res.file] : [])) if (fileId.has(target) && target !== f) insEdge.run(src, fileId.get(target), 'imports', null);
      if (res.module && !res.builtin) insEdge.run(src, node('module', `mod:${res.module}`, res.module), 'imports', null);
    }
    for (const s of r.symbols) insEdge.run(src, node('symbol', `sym:${f}#${s.name}:${s.line}`, s.name, f, s.line, layerOf(f), r.lang, { kind: s.kind }), 'defines', s.line);
    for (const e of r.endpoints) {
      const id = epId(e.kind, e.norm, e.path);
      const row = getId.get(e.kind === 'http' ? `ep:http:${e.norm}` : `ep:${e.kind}:${e.norm}`);
      const data = JSON.parse(row.data || '{}');
      data.methods = [...new Set([...(data.methods || []), e.method])];
      data.handled = true;
      setData.run(JSON.stringify(data), id);
      insEdge.run(src, id, 'handles', e.line);
    }
    for (const c of r.calls) insEdge.run(src, epId(c.kind, c.norm, c.path), 'calls', c.line);
  }
  // Handlers registered with a template (e.g. ipcMain.handle(`git:${op}`)) match
  // any concrete endpoint of that shape: point those at the template's handler.
  const templated = db.prepare(`SELECT id, name, data FROM nodes WHERE kind = 'endpoint' AND name LIKE '%\${%'`).all();
  for (const t of templated) {
    const re = new RegExp('^' + t.name.split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
    const handlers = db.prepare(`SELECT src, line FROM edges WHERE dst = ? AND kind = 'handles'`).all(t.id);
    for (const ep of db.prepare(`SELECT id, name, data FROM nodes WHERE kind = 'endpoint' AND name NOT LIKE '%\${%'`).all()) {
      const d = JSON.parse(ep.data || '{}');
      if (d.handled || !re.test(ep.name)) continue;
      d.handled = true;
      d.methods = JSON.parse(t.data || '{}').methods;
      setData.run(JSON.stringify(d), ep.id);
      for (const h of handlers) insEdge.run(h.src, ep.id, 'handles', h.line);
    }
  }
  db.exec('COMMIT');
  db.close();

  const finalDb = path.join(dir, 'graph.db');
  for (const f of fs.readdirSync(dir)) if (/^graph.*\.db$/.test(f) && path.join(dir, f) !== tmp) fs.rmSync(path.join(dir, f), { force: true });
  fs.renameSync(tmp, finalDb);

  const head = (await git(repo, ['rev-parse', 'HEAD']))?.trim() || null;
  const upstream = (await git(repo, ['rev-parse', '@{u}']))?.trim() || null;
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
  const meta = { repo: path.resolve(repo), head, upstream, branch, indexedAt: Date.now(), files: parsed.size, totalFiles: all.length };
  fs.writeFileSync(metaFile(repo), JSON.stringify(meta, null, 2));
  return meta;
}

// ---------- queries ----------

function openDb(repo) {
  const file = path.join(dirFor(repo), 'graph.db');
  if (!fs.existsSync(file)) throw new Error('This repository has not been indexed yet.');
  return new DatabaseSync(file, { readOnly: true });
}

const fmtEp = (n) => {
  const d = JSON.parse(n.data || '{}');
  return d.kind === 'ipc' ? `IPC ${n.name}` : `${(d.methods || ['?']).join('|')} ${n.name}`;
};

function query(repo, action, arg = '', limit = 40) {
  const db = openDb(repo);
  try {
    const like = `%${String(arg).replace(/[%_]/g, '')}%`;
    if (action === 'search') {
      const rows = db.prepare(`SELECT kind, name, file, line, layer, data FROM nodes WHERE kind != 'module' AND (name LIKE ? OR file LIKE ?) ORDER BY kind = 'file' DESC, length(name) LIMIT ?`).all(like, like, limit);
      if (!rows.length) return `Nothing matching "${arg}".`;
      return rows.map((r) => (r.kind === 'endpoint' ? `endpoint  ${fmtEp(r)}` : r.kind === 'file' ? `file      ${r.file} [${r.layer}]` : `${JSON.parse(r.data || '{}').kind || 'symbol'}  ${r.name}  (${r.file}:${r.line})`)).join('\n');
    }
    if (action === 'file') {
      const f = db.prepare(`SELECT id, file, layer, lang, data FROM nodes WHERE kind = 'file' AND (file = ? OR file LIKE ?) ORDER BY length(file) LIMIT 1`).get(arg, `%${arg}`);
      if (!f) return `No indexed file matching "${arg}".`;
      const out = [`${f.file}  [layer: ${f.layer}, ${f.lang}, ${JSON.parse(f.data).lines} lines]`];
      const list = (sql, title, fmt) => {
        const rows = db.prepare(sql).all(f.id);
        if (rows.length) out.push(`\n${title} (${rows.length}):`, ...rows.slice(0, limit).map(fmt));
      };
      list(`SELECT n.name, n.line, n.data FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'defines' ORDER BY n.line`, 'Defines', (r) => `  ${JSON.parse(r.data || '{}').kind} ${r.name} :${r.line}`);
      list(`SELECT n.kind, n.name FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'imports'`, 'Imports', (r) => `  ${r.kind === 'module' ? 'pkg ' : ''}${r.name}`);
      list(`SELECT n.name FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? AND e.kind = 'imports'`, 'Imported by', (r) => `  ${r.name}`);
      list(`SELECT n.name, n.data, e.line FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'handles'`, 'Handles endpoints', (r) => `  ${fmtEp(r)} :${r.line}`);
      list(`SELECT n.name, n.data, e.line FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'calls'`, 'Calls endpoints', (r) => `  ${fmtEp(r)} :${r.line}`);
      return out.join('\n');
    }
    if (action === 'endpoints') {
      const eps = db.prepare(`SELECT id, name, data FROM nodes WHERE kind = 'endpoint' AND name LIKE ? ORDER BY name LIMIT ?`).all(like, limit * 3);
      if (!eps.length) return 'No endpoints found.';
      const via = db.prepare(`SELECT n.file, e.line, e.kind FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ?`);
      return eps
        .map((ep) => {
          const links = via.all(ep.id);
          const h = links.filter((l) => l.kind === 'handles').map((l) => `${l.file}:${l.line}`);
          const c = links.filter((l) => l.kind === 'calls').map((l) => `${l.file}:${l.line}`);
          return `${fmtEp(ep)}\n  handler: ${h.join(', ') || '(not in this repo)'}${c.length ? `\n  called from: ${c.slice(0, 8).join(', ')}${c.length > 8 ? ` +${c.length - 8} more` : ''}` : ''}`;
        })
        .join('\n');
    }
    if (action === 'dependents') {
      const f = db.prepare(`SELECT id, file FROM nodes WHERE kind = 'file' AND (file = ? OR file LIKE ?) ORDER BY length(file) LIMIT 1`).get(arg, `%${arg}`);
      if (!f) return `No indexed file matching "${arg}".`;
      const step = db.prepare(`SELECT n.id, n.file FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? AND e.kind = 'imports'`);
      const seen = new Map();
      let frontier = [f.id];
      for (let depth = 1; depth <= 3 && frontier.length; depth++) {
        const next = [];
        for (const id of frontier) for (const r of step.all(id)) if (!seen.has(r.id) && r.id !== f.id) (seen.set(r.id, { file: r.file, depth }), next.push(r.id));
        frontier = next;
      }
      if (!seen.size) return `Nothing in the repo imports ${f.file}.`;
      return `Files that depend on ${f.file} (depth = import hops):\n` + [...seen.values()].sort((a, b) => a.depth - b.depth).slice(0, limit).map((v) => `  ${v.depth}  ${v.file}`).join('\n');
    }
    if (action === 'layers') {
      const rows = db.prepare(`SELECT a.layer AS from_layer, b.layer AS to_layer, count(*) AS n FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.kind = 'imports' AND b.kind = 'file' AND a.layer != b.layer GROUP BY 1, 2 ORDER BY n DESC`).all();
      return rows.length ? 'Imports between layers:\n' + rows.map((r) => `  ${r.from_layer} -> ${r.to_layer}: ${r.n}`).join('\n') : 'No cross-layer imports found.';
    }
    return `Unknown action "${action}". Use search, file, endpoints, dependents or layers.`;
  } finally {
    db.close();
  }
}

// ---------- fact sheet ----------

async function factSheet(repo, meta) {
  const db = openDb(repo);
  const L = [];
  try {
    const name = path.basename(repo);
    L.push(`# Fact sheet: ${name}`, '', `Indexed ${new Date(meta.indexedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC at ${meta.branch || '?'} ${meta.head ? meta.head.slice(0, 8) : ''} · ${meta.files} source files analysed (of ${meta.totalFiles} in the repo).`, '');

    // Project
    const pkg = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
      } catch {
        return null;
      }
    })();
    L.push('## Project');
    if (pkg) {
      if (pkg.description) L.push(`- ${pkg.description}`);
      if (pkg.main) L.push(`- Entry point: \`${pkg.main}\``);
      if (pkg.scripts) L.push(`- Scripts: ${Object.entries(pkg.scripts).slice(0, 10).map(([k, v]) => `\`${k}\` (${v})`).join(', ')}`);
    }
    const markers = ['requirements.txt', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Cargo.toml', 'Dockerfile', 'docker-compose.yml'].filter((m) => fs.existsSync(path.join(repo, m)));
    const csproj = fs.readdirSync(repo).filter((f) => /\.(csproj|sln)$/.test(f));
    if (markers.length || csproj.length) L.push(`- Build/config files: ${[...markers, ...csproj].map((m) => `\`${m}\``).join(', ')}`);
    const langs = db.prepare(`SELECT lang, count(*) n, sum(json_extract(data, '$.lines')) lines FROM nodes WHERE kind = 'file' GROUP BY lang ORDER BY lines DESC`).all();
    L.push(`- Languages: ${langs.map((l) => `${{ js: 'JavaScript/TypeScript', py: 'Python', cs: 'C#', java: 'Java/Kotlin', go: 'Go' }[l.lang] || l.lang} (${l.n} files, ${l.lines} lines)`).join(', ')}`);
    const docs = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs'].filter((d) => fs.existsSync(path.join(repo, d)));
    if (docs.length) L.push(`- Docs: ${docs.map((d) => `\`${d}\``).join(', ')}${docs.includes('AGENTS.md') ? ' (read AGENTS.md for project conventions)' : ''}`);
    L.push('');

    // Layers
    const layers = db.prepare(`SELECT layer, count(*) n FROM nodes WHERE kind = 'file' GROUP BY layer ORDER BY n DESC`).all();
    L.push('## Layers', '');
    for (const l of layers) {
      const dirs = db.prepare(`SELECT file FROM nodes WHERE kind = 'file' AND layer = ?`).all(l.layer).map((r) => path.posix.dirname(r.file));
      const top = Object.entries(dirs.reduce((a, d) => ((a[d] = (a[d] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 4);
      L.push(`- **${l.layer}** (${l.n} files): ${top.map(([d, n]) => `\`${d}/\` (${n})`).join(', ')}`);
    }
    const cross = db.prepare(`SELECT a.layer f, b.layer t, count(*) n FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.kind = 'imports' AND b.kind = 'file' AND a.layer != b.layer GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`).all();
    if (cross.length) L.push('', `Imports between layers: ${cross.map((c) => `${c.f}→${c.t} (${c.n})`).join(', ')}`);
    L.push('');

    // Endpoints
    const eps = db.prepare(`SELECT id, name, data FROM nodes WHERE kind = 'endpoint' ORDER BY name`).all();
    const via = db.prepare(`SELECT n.file, e.line, e.kind FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ?`);
    const handled = eps.filter((e) => JSON.parse(e.data || '{}').handled);
    const external = eps.filter((e) => !JSON.parse(e.data || '{}').handled);
    if (handled.length) {
      L.push(`## Endpoints (${handled.length})`, '', '| Endpoint | Handler | Called from |', '|---|---|---|');
      for (const ep of handled.slice(0, 120)) {
        const links = via.all(ep.id);
        const h = links.filter((l) => l.kind === 'handles').map((l) => `${l.file}:${l.line}`);
        const c = [...new Set(links.filter((l) => l.kind === 'calls').map((l) => l.file))];
        L.push(`| \`${fmtEp(ep)}\` | ${h.slice(0, 2).join(', ')} | ${c.slice(0, 3).join(', ')}${c.length > 3 ? ` +${c.length - 3}` : ''} |`);
      }
      if (handled.length > 120) L.push(`| … ${handled.length - 120} more (use code_graph endpoints) | | |`);
      L.push('');
    }
    if (external.length) L.push(`Calls to endpoints not handled in this repo (external APIs or unmatched routes): ${external.slice(0, 15).map((e) => `\`${fmtEp(e)}\``).join(', ')}${external.length > 15 ? ' …' : ''}`, '');

    // Hubs
    const hubs = db.prepare(`SELECT n.file, count(*) c FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.kind = 'imports' AND n.kind = 'file' GROUP BY n.id ORDER BY c DESC LIMIT 12`).all();
    if (hubs.length) L.push('## Most depended-on files', '', ...hubs.map((h) => `- \`${h.file}\` (imported by ${h.c})`), '');
    const big = db.prepare(`SELECT file, json_extract(data, '$.lines') lines FROM nodes WHERE kind = 'file' ORDER BY lines DESC LIMIT 6`).all();
    L.push('## Largest files', '', ...big.map((b) => `- \`${b.file}\` (${b.lines} lines)`), '');
    const mods = db.prepare(`SELECT n.name, count(*) c FROM edges e JOIN nodes n ON n.id = e.dst WHERE n.kind = 'module' GROUP BY n.id ORDER BY c DESC LIMIT 15`).all();
    if (mods.length) L.push('## External packages used most', '', mods.map((m) => `\`${m.name}\` (${m.c})`).join(', '), '');
  } finally {
    db.close();
  }

  const log = await git(repo, ['log', '-n12', '--pretty=format:%h %ad %s', '--date=short']);
  if (log) L.push('## Recent commits', '', ...log.split('\n').map((l) => `- ${l}`), '');
  L.push('## How to dig deeper', '', 'Use the `code_graph` tool: `search` (find files/symbols/endpoints by name), `file` (a file\'s symbols, imports, importers and endpoints), `endpoints` (handlers and callers), `dependents` (what breaks if a file changes), `layers` (imports between layers). Read source files only once you know which ones matter.');
  return L.join('\n');
}

// ---------- public API ----------

function factsFile(repo) {
  return path.join(dirFor(repo), 'facts.md');
}

/**
 * Re-indexes a repo and rewrites its fact sheet. `summarize(markdown)` may
 * return an AI-written overview to put at the top (or null).
 */
function reindex(repo, { reason = 'manual', summarize, onProgress } = {}) {
  repo = path.resolve(repo);
  if (running.has(repo)) return running.get(repo);
  const job = (async () => {
    const t0 = Date.now();
    onProgress?.('Indexing…');
    const meta = await build(repo, onProgress);
    let md = await factSheet(repo, meta);
    if (summarize) {
      onProgress?.('Writing summary…');
      const summary = await summarize(md).catch(() => null);
      if (summary) md = md.replace(/\n## Project/, `\n## Summary\n\n${summary.trim()}\n\n## Project`);
    }
    fs.writeFileSync(factsFile(repo), md);
    const done = { ...meta, reason, ms: Date.now() - t0, summarized: !!summarize };
    fs.writeFileSync(metaFile(repo), JSON.stringify(done, null, 2));
    return done;
  })().finally(() => running.delete(repo));
  running.set(repo, job);
  return job;
}

module.exports = {
  reindex,
  query,
  status(repo) {
    repo = path.resolve(repo);
    return { indexing: running.has(repo), meta: readMeta(repo) };
  },
  facts(repo) {
    try {
      return fs.readFileSync(factsFile(path.resolve(repo)), 'utf8');
    } catch {
      return null;
    }
  },
  // Has the upstream (or HEAD, without an upstream) moved since the last index?
  async needsReindex(repo) {
    const meta = readMeta(repo);
    if (!meta) return 'first index';
    const upstream = (await git(repo, ['rev-parse', '@{u}']))?.trim() || null;
    if (upstream && upstream !== meta.upstream) return 'push/pull';
    if (!upstream) {
      const head = (await git(repo, ['rev-parse', 'HEAD']))?.trim() || null;
      if (head && head !== meta.head) return 'new commit';
    }
    return null;
  },
  normPath,
};
