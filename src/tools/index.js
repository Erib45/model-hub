// Tool definitions offered to every model (provider-neutral JSON Schema) and
// the dispatcher that runs them, including the permission gate.

const fs = require('fs');
const path = require('path');
const permissions = require('./permissions');
const { formatForModel } = require('./terminal');
const reviewer = require('./reviewer');

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and snippets. The user watches the search in the browser panel.',
    parameters: obj({ query: { type: 'string', description: 'Search query' } }, ['query']),
  },
  {
    name: 'open_url',
    description: 'Open a URL in the shared browser and return the page text and numbered interactive elements.',
    parameters: obj({ url: { type: 'string' } }, ['url']),
  },
  {
    name: 'read_page',
    description: 'Read the page currently shown in the shared browser (the user may have navigated it themselves).',
    parameters: obj({}),
  },
  {
    name: 'click',
    description: 'Click an interactive element by its number from the latest read_page/open_url output.',
    parameters: obj({ element: { type: 'integer' } }, ['element']),
  },
  {
    name: 'type_text',
    description: 'Type into an input element by number; set submit=true to submit its form.',
    parameters: obj({ element: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['element', 'text']),
  },
  {
    name: 'repo_facts',
    description:
      "Get the fact sheet of a git repository: purpose, layers, entry points, endpoints with their handlers and callers, most-depended-on files, recent commits. Call this first when working in a repo instead of reading lots of code. Defaults to the repo of the current terminal directory.",
    parameters: obj({ path: { type: 'string', description: 'Any path inside the repo (optional)' } }),
  },
  {
    name: 'code_graph',
    description:
      "Query the repository's code graph. action: 'search' (files, functions, classes, endpoints matching query), 'file' (a file's symbols, imports, importers and endpoints; query = file path), 'endpoints' (HTTP routes / IPC channels with handler and callers; query filters), 'dependents' (files that import a file, up to 3 hops; query = file path), 'layers' (imports between layers).",
    parameters: obj(
      {
        action: { type: 'string', enum: ['search', 'file', 'endpoints', 'dependents', 'layers'] },
        query: { type: 'string' },
        path: { type: 'string', description: 'Any path inside the repo (optional)' },
      },
      ['action']
    ),
  },
  {
    name: 'run_command',
    description:
      'Run a PowerShell command on the user\'s Windows PC. The working directory persists between calls (use Set-Location to move). Output and exit code are returned. The user sees it in the Terminal panel and may need to approve it.',
    parameters: obj({ command: { type: 'string' } }, ['command']),
  },
  {
    name: 'read_file',
    description: 'Read a text file. Relative paths are resolved from the current terminal directory.',
    parameters: obj({ path: { type: 'string' } }, ['path']),
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file with the given content. Creates parent folders. Relative paths resolve from the current terminal directory.',
    parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// Model output is untrusted: check required fields and basic types before running.
function validate(name, args) {
  const def = byName[name];
  if (!def) return `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`;
  if (!args || typeof args !== 'object') return 'Arguments must be a JSON object.';
  for (const key of def.parameters.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `Missing required argument "${key}".`;
  }
  for (const [key, schema] of Object.entries(def.parameters.properties)) {
    if (args[key] === undefined) continue;
    const t = schema.type;
    const v = args[key];
    if (t === 'integer' && !Number.isInteger(Number(v))) return `"${key}" must be an integer.`;
    if (t === 'string' && typeof v !== 'string') return `"${key}" must be a string.`;
  }
  return null;
}

const MAX_READ = 60000;

/**
 * ctx: { browser, terminal, settings, approve(request) -> Promise<'allow'|'always'|'deny'> }
 * Returns { content, isError }.
 */
async function runTool(ctx, name, args) {
  const err = validate(name, args);
  if (err) return { content: err, isError: true };
  const { browser, terminal, settings } = ctx;
  const resolve = (p) => path.resolve(terminal.workingDir, p);

  try {
    switch (name) {
      case 'web_search':
        return { content: await browser.search(args.query) };
      case 'open_url':
        await browser.navigate(args.url);
        return { content: await browser.read() };
      case 'read_page':
        return { content: await browser.read() };
      case 'click':
        return { content: await browser.click(Number(args.element)) };
      case 'type_text':
        return { content: await browser.type(Number(args.element), args.text, !!args.submit) };

      case 'repo_facts':
      case 'code_graph': {
        const rk = ctx.repoKnowledge;
        // Models pass all sorts of things as `path` (repo name, a file path): use it only
        // if it points into a repo, otherwise the terminal's current directory.
        let repo = null;
        if (args.path) {
          let p = resolve(args.path);
          while (p && !fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
          repo = await rk.ensureFor(p);
        }
        repo ||= await rk.ensureFor(terminal.workingDir);
        if (!repo) return { content: 'Not inside a git repository. Pass a path inside a repo, or cd into one with run_command.', isError: true };
        if (name === 'repo_facts') return { content: rk.facts(repo) || 'The repository is still being indexed; try again in a moment.' };
        // A file path given as `path` instead of `query` (file / dependents).
        const q = args.query || (['file', 'dependents'].includes(args.action) && args.path ? path.relative(repo, resolve(args.path)).split(path.sep).join('/') : '');
        return { content: `Repository: ${repo}

` + rk.query(repo, args.action, q) };
      }

      case 'run_command': {
        const check = permissions.checkCommand(args.command, settings);
        // In Auto mode, a local AI reviewer may wave through routine "normal" commands.
        if (check.decision === 'ask' && check.risk === 'normal' && settings.permissionMode === 'auto' && settings.reviewerEnabled) {
          ctx.onReview({ state: 'running', command: args.command });
          const r = await reviewer.review({
            command: args.command,
            cwd: terminal.workingDir,
            workspace: settings.workspaceDir,
            userRequest: ctx.userRequest,
            settings,
          });
          ctx.onReview({ state: 'done', command: args.command, ...r });
          if (r.verdict === 'allow') check.decision = 'allow';
          else check.reason = `AI reviewer: ${r.reason}`;
        }
        if (check.decision === 'ask') {
          const answer = await ctx.approve({ tool: name, title: 'Run command', detail: args.command, cwd: terminal.workingDir, ...check });
          if (answer === 'deny') return { content: 'The user denied running this command.', isError: true };
          if (answer === 'always' && check.risk !== 'dangerous') ctx.addAllowRule(permissions.rulePrefix(args.command));
        }
        return { content: formatForModel(await terminal.run(args.command)) };
      }

      case 'read_file': {
        const p = resolve(args.path);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) return { content: fs.readdirSync(p).join('\n') || '(empty directory)' };
        let text = fs.readFileSync(p, 'utf8');
        if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + `\n…[truncated, ${text.length} chars total]`;
        return { content: text };
      }

      case 'write_file': {
        const p = resolve(args.path);
        const check = permissions.checkWrite(p, settings);
        if (check.decision === 'ask') {
          const exists = fs.existsSync(p);
          const answer = await ctx.approve({
            tool: name,
            title: `${exists ? 'Overwrite' : 'Create'} file`,
            detail: `${p}\n\n${args.content.length > 4000 ? args.content.slice(0, 4000) + '\n…' : args.content}`,
            ...check,
          });
          if (answer === 'deny') return { content: 'The user denied writing this file.', isError: true };
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, args.content, 'utf8');
        return { content: `Wrote ${args.content.length} chars to ${p}` };
      }
    }
  } catch (e) {
    return { content: `Tool error: ${e.message}`, isError: true };
  }
}

module.exports = { TOOLS, runTool };
