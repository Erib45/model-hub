// Per-language extraction of imports, symbols, endpoints (HTTP routes, IPC
// channels) and endpoint calls. Regex-based: fast and dependency-free, good
// enough to map how files and layers connect. Results feed the code graph.

const path = require('path');

const LANG_BY_EXT = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.vue': 'js', '.svelte': 'js',
  '.py': 'py',
  '.cs': 'cs',
  '.java': 'java', '.kt': 'java',
  '.go': 'go',
};

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// "/api/users/${id}?x=1" -> "/api/users/:param"; route params (:id, {id}, <id>) too.
function normPath(p) {
  let s = String(p || '').trim();
  s = s.replace(/^https?:\/\/[^/]+/i, ''); // drop host
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/\$\{[^}]*\}|\{[^}]*\}|<[^>]*>|:[A-Za-z_]\w*|\[[^\]]*\]/g, ':param');
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s.toLowerCase();
}

function all(re, text, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) fn(m);
}

// ---------- JavaScript / TypeScript ----------
function extractJs(text, rel) {
  const r = { imports: [], symbols: [], endpoints: [], calls: [] };
  all(/(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|export\s+[\w*{}\s,]+\s+from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g, text, (m) => r.imports.push(m[1]));
  all(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g, text, (m) => r.symbols.push({ name: m[1], kind: 'function', line: lineAt(text, m.index + m[0].length) }));
  all(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, text, (m) => r.symbols.push({ name: m[1], kind: 'class', line: lineAt(text, m.index + m[0].length) }));
  all(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, text, (m) => r.symbols.push({ name: m[1], kind: 'function', line: lineAt(text, m.index + m[0].length) }));
  // HTTP routes: Express/Koa/Fastify/Hono style
  all(/\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|options|head|all)\(\s*['"`](\/[^'"`]*)['"`]/g, text, (m) => {
    if (/^(axios|http|https|client|api|request|fetch|\$http|superagent|ky|got|this\.http)$/i.test(m[1])) return; // those are calls, below
    r.endpoints.push({ kind: 'http', method: m[2].toUpperCase(), path: m[3], line: lineAt(text, m.index) });
  });
  // NestJS
  const ctrl = text.match(/@Controller\(\s*['"`]([^'"`]*)['"`]/);
  all(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g, text, (m) =>
    r.endpoints.push({ kind: 'http', method: m[1].toUpperCase(), path: `/${ctrl ? ctrl[1] : ''}/${m[2] || ''}`, line: lineAt(text, m.index) })
  );
  // Next.js file-based API routes
  const nextPages = rel.match(/(?:^|\/)pages\/(api\/.+?)\.(?:js|ts)x?$/);
  if (nextPages) r.endpoints.push({ kind: 'http', method: 'ANY', path: '/' + nextPages[1].replace(/\/index$/, ''), line: 1 });
  const nextApp = rel.match(/(?:^|\/)app\/(.*?)\/?route\.(?:js|ts)$/);
  if (nextApp) {
    const methods = [...text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((x) => x[1]);
    for (const meth of methods.length ? methods : ['ANY']) r.endpoints.push({ kind: 'http', method: meth, path: '/' + nextApp[1].replace(/\([^)]*\)\/?/g, ''), line: 1 });
  }
  // Electron IPC / message channels
  all(/\bipcMain\.(?:handle|handleOnce|on|once)\(\s*['"`]([^'"`]+)['"`]/g, text, (m) => r.endpoints.push({ kind: 'ipc', method: 'IPC', path: m[1], line: lineAt(text, m.index) }));
  all(/\bipcRenderer\.(?:invoke|send|sendSync)\(\s*['"`]([^'"`]+)['"`]/g, text, (m) => r.calls.push({ kind: 'ipc', path: m[1], line: lineAt(text, m.index) }));
  all(/\binvoke\(\s*['"`]([\w.-]+:[\w.:-]+)['"`]\s*\)/g, text, (m) => r.calls.push({ kind: 'ipc', path: m[1], line: lineAt(text, m.index) }));
  // HTTP calls
  all(/\bfetch\(\s*['"`]((?:https?:\/\/[^'"`]*)?\/[^'"`]*)['"`]/g, text, (m) => r.calls.push({ kind: 'http', method: 'ANY', path: m[1], line: lineAt(text, m.index) }));
  all(/\b(?:axios|http|client|api|\$http|ky|got)\.(get|post|put|patch|delete)\(\s*['"`]((?:https?:\/\/[^'"`]*)?\/[^'"`]*)['"`]/g, text, (m) =>
    r.calls.push({ kind: 'http', method: m[1].toUpperCase(), path: m[2], line: lineAt(text, m.index) })
  );
  return r;
}

// ---------- Python ----------
function extractPy(text) {
  const r = { imports: [], symbols: [], endpoints: [], calls: [] };
  all(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([\w*, \t()]+)/gm, text, (m) => r.imports.push(m[1].startsWith('.') ? { rel: m[1], names: m[2] } : m[1]));
  all(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm, text, (m) => m[1].split(',').forEach((x) => r.imports.push(x.trim().split(/\s+as\s+/)[0])));
  all(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, text, (m) => r.symbols.push({ name: m[1], kind: 'function', line: lineAt(text, m.index) }));
  all(/^class\s+([A-Za-z_]\w*)/gm, text, (m) => r.symbols.push({ name: m[1], kind: 'class', line: lineAt(text, m.index) }));
  all(/@\w+\.(get|post|put|patch|delete|route|api_route)\(\s*['"]([^'"]*)['"]([^)]*)\)/g, text, (m) => {
    let method = m[1].toUpperCase();
    if (method === 'ROUTE' || method === 'API_ROUTE') method = (m[3].match(/methods\s*=\s*\[\s*['"](\w+)/) || [0, 'ANY'])[1].toUpperCase();
    r.endpoints.push({ kind: 'http', method, path: m[2].startsWith('/') ? m[2] : '/' + m[2], line: lineAt(text, m.index) });
  });
  all(/\b(?:re_)?path\(\s*r?['"]\^?([^'"]*)['"]\s*,/g, text, (m) => r.endpoints.push({ kind: 'http', method: 'ANY', path: '/' + m[1].replace(/\$$/, ''), line: lineAt(text, m.index) }));
  all(/\brequests\.(get|post|put|patch|delete)\(\s*f?['"]((?:https?:\/\/[^'"]*)?\/[^'"]*)['"]/g, text, (m) => r.calls.push({ kind: 'http', method: m[1].toUpperCase(), path: m[2], line: lineAt(text, m.index) }));
  return r;
}

// ---------- C# ----------
function extractCs(text) {
  const r = { imports: [], symbols: [], endpoints: [], calls: [], namespace: (text.match(/\bnamespace\s+([\w.]+)/) || [])[1] };
  all(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm, text, (m) => r.imports.push(m[1]));
  all(/\b(?:class|interface|record|struct)\s+([A-Z]\w*)/g, text, (m) => r.symbols.push({ name: m[1], kind: 'class', line: lineAt(text, m.index) }));
  const route = (text.match(/\[Route\(\s*"([^"]*)"\s*\)\]\s*(?:\[[^\]]*\]\s*)*(?:public\s+)?(?:sealed\s+)?(?:partial\s+)?class\s+(\w+?)(?:Controller)?\b/) || []);
  const prefix = route[1] ? route[1].replace('[controller]', (route[2] || '').toLowerCase()) : '';
  all(/\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\]/g, text, (m) =>
    r.endpoints.push({ kind: 'http', method: m[1].toUpperCase(), path: `/${prefix}/${m[2] || ''}`, line: lineAt(text, m.index) })
  );
  all(/\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"/g, text, (m) => r.endpoints.push({ kind: 'http', method: m[1].toUpperCase(), path: m[2], line: lineAt(text, m.index) }));
  all(/\.(Get|Post|Put|Patch|Delete)(?:FromJson)?Async\(\s*\$?"((?:https?:\/\/[^"]*)?\/[^"]*)"/g, text, (m) => r.calls.push({ kind: 'http', method: m[1].toUpperCase(), path: m[2], line: lineAt(text, m.index) }));
  return r;
}

// ---------- Java / Kotlin ----------
function extractJava(text) {
  const r = { imports: [], symbols: [], endpoints: [], calls: [], namespace: (text.match(/^\s*package\s+([\w.]+)/m) || [])[1] };
  all(/^\s*import\s+(?:static\s+)?([\w.]+)/gm, text, (m) => r.imports.push(m[1]));
  all(/\b(?:class|interface|enum|record|object)\s+([A-Z]\w*)/g, text, (m) => r.symbols.push({ name: m[1], kind: 'class', line: lineAt(text, m.index) }));
  const base = (text.match(/@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:class|interface)/) || [])[1] || '';
  all(/@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?"?([^")]*)"?[^)]*\))?/g, text, (m) =>
    r.endpoints.push({ kind: 'http', method: m[1].toUpperCase(), path: `/${base}/${m[2] || ''}`, line: lineAt(text, m.index) })
  );
  return r;
}

// ---------- Go ----------
function extractGo(text) {
  const r = { imports: [], symbols: [], endpoints: [], calls: [], namespace: (text.match(/^\s*package\s+(\w+)/m) || [])[1] };
  const block = text.match(/import\s*\(([\s\S]*?)\)/);
  if (block) all(/"([^"]+)"/g, block[1], (m) => r.imports.push(m[1]));
  all(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm, text, (m) => r.imports.push(m[1]));
  all(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, text, (m) => r.symbols.push({ name: m[1], kind: 'function', line: lineAt(text, m.index) }));
  all(/^type\s+([A-Z]\w*)\s+(?:struct|interface)/gm, text, (m) => r.symbols.push({ name: m[1], kind: 'class', line: lineAt(text, m.index) }));
  all(/\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/g, text, (m) => {
    const parts = m[1].split(' ');
    r.endpoints.push({ kind: 'http', method: parts.length > 1 ? parts[0] : 'ANY', path: parts.pop(), line: lineAt(text, m.index) });
  });
  all(/\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/g, text, (m) => r.endpoints.push({ kind: 'http', method: m[1], path: m[2], line: lineAt(text, m.index) }));
  all(/\bhttp\.(Get|Post)\(\s*"((?:https?:\/\/[^"]*)?\/[^"]*)"/g, text, (m) => r.calls.push({ kind: 'http', method: m[1].toUpperCase(), path: m[2], line: lineAt(text, m.index) }));
  return r;
}

const EXTRACTORS = { js: extractJs, py: extractPy, cs: extractCs, java: extractJava, go: extractGo };

// Blanks out comments (keeping newlines, so line numbers stay right). Simple:
// whole-line comments and /* */ blocks; good enough to avoid matching examples
// written in comments.
function stripComments(text, lang) {
  const keepNl = (s) => s.replace(/[^\n]/g, ' ');
  if (lang === 'py') return text.replace(/^[ \t]*#.*$/gm, keepNl);
  return text.replace(/\/\*[\s\S]*?\*\//g, keepNl).replace(/^[ \t]*\/\/.*$/gm, keepNl);
}

function extract(rel, text) {
  const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()];
  if (!lang) return null;
  text = stripComments(text, lang);
  const r = EXTRACTORS[lang](text, rel);
  r.lang = lang;
  r.lines = text.split('\n').length;
  for (const e of r.endpoints) e.norm = e.kind === 'http' ? normPath(e.path) : e.path;
  for (const c of r.calls) c.norm = c.kind === 'http' ? normPath(c.path) : c.path;
  return r;
}

// Architectural layer guessed from the path.
function layerOf(rel) {
  const p = '/' + rel.toLowerCase();
  if (/\/(tests?|__tests__|spec|specs|e2e|cypress)\//.test(p) || /\.(test|spec)\.\w+$/.test(p)) return 'tests';
  if (/\/(components|pages|views|screens|renderer|frontend|client|ui|web|public|static|templates|widgets|layouts)\//.test(p) || /\.(vue|svelte|jsx|tsx)$/.test(p)) return 'ui';
  if (/\/(routes?|controllers?|handlers?|api|endpoints|resolvers|graphql|ipc)\//.test(p) || /(controller|router|routes|handler)s?\.\w+$/.test(p)) return 'api';
  if (/\/(models?|entities|repositories|repository|db|database|dal|data|migrations|schema|prisma|orm|store|storage)\//.test(p) || /(model|repository|schema|migration)s?\.\w+$/.test(p)) return 'data';
  if (/\/(services?|domain|core|logic|usecases|business|providers?|tools?|lib|utils?|helpers?|common|shared)\//.test(p)) return 'service';
  if (/\/(config|infra|infrastructure|scripts|build|deploy|ci|\.github)\//.test(p)) return 'infra';
  return 'other';
}

module.exports = { extract, layerOf, normPath, LANG_BY_EXT };
