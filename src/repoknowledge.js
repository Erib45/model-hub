// Orchestrates repo knowledge: which repos to index, when to re-index (first
// sight, push/pull, new commits without an upstream), the optional AI summary,
// and the context handed to models working inside a repo.

const fs = require('fs');
const path = require('path');
const codegraph = require('./codegraph');
const gitOps = require('./git');

const toplevelCache = new Map(); // dir -> repo root | null
const seen = new Set(); // repos the AI has worked in (indexed even if untracked)

function create({ getSettings, parseModel, notify }) {
  let timer = null;

  async function repoFor(dir) {
    if (!dir) return null;
    if (!toplevelCache.has(dir)) toplevelCache.set(dir, await gitOps.toplevel(dir));
    return toplevelCache.get(dir);
  }

  // Optional AI overview written at the top of the fact sheet.
  function summarizer() {
    const modelId = getSettings().factSheetModel;
    if (!modelId) return null;
    return async (factSheet) => {
      const { provider, name } = parseModel(modelId);
      if (!provider.complete) return null;
      const repoRoot = factSheet.match(/^# Fact sheet: (.*)$/m)?.[1] || 'this repository';
      const text = await provider.complete({
        model: name,
        system:
          'You write the summary section of a code fact sheet that AI coding agents read to orient themselves in a repository. ' +
          'Based only on the fact sheet you are given, write 5-10 bullet points: what the project is, how it is structured (layers and how they talk to each other: endpoints, IPC, imports), where the main entry points and hot spots are, and anything an agent should know before changing code. Be concrete; use file paths. No preamble, no headings.',
        prompt: `Fact sheet for ${repoRoot}:\n\n${factSheet.slice(0, 30000)}`,
        numCtx: 16384,
      });
      return text && text.trim().length > 20 ? text.trim() : null;
    };
  }

  async function reindex(repo, reason) {
    if (!getSettings().repoKnowledge) return null;
    notify({ repo, state: 'indexing', reason });
    try {
      const meta = await codegraph.reindex(repo, { reason, summarize: summarizer(), onProgress: (line) => notify({ repo, state: 'indexing', line }) });
      notify({ repo, state: 'done', meta });
      return meta;
    } catch (e) {
      notify({ repo, state: 'error', error: e.message });
      throw e;
    }
  }

  async function check(repo) {
    if (!repo || !fs.existsSync(repo)) return;
    const reason = await codegraph.needsReindex(repo);
    if (reason) await reindex(repo, reason).catch(() => {});
  }

  async function tick() {
    const s = getSettings();
    if (!s.repoKnowledge) return;
    const repos = [...new Set([...(s.gitRepos || []), ...seen])];
    for (const r of repos) await check(r);
  }

  return {
    repoFor,
    reindex,
    check,
    start() {
      clearInterval(timer);
      timer = setInterval(() => tick().catch(() => {}), 30000);
      setTimeout(() => tick().catch(() => {}), 5000);
    },
    stop: () => clearInterval(timer),

    // Repo + fact sheet for a directory; indexes on first sight.
    async ensureFor(dir) {
      const repo = await repoFor(dir);
      if (!repo) return null;
      seen.add(repo);
      if (!codegraph.status(repo).meta) await reindex(repo, 'first index').catch(() => {});
      return repo;
    },

    facts: (repo) => codegraph.facts(repo),
    query: (repo, action, arg) => codegraph.query(repo, action, arg),
    status: (repo) => codegraph.status(repo),

    // System-prompt context for a model whose working directory is `dir`.
    async promptContext(dir, { includeAgentsMd }) {
      if (!getSettings().repoKnowledge) return '';
      const repo = await repoFor(dir);
      if (!repo) return '';
      seen.add(repo);
      const status = codegraph.status(repo);
      if (!status.meta && !status.indexing) reindex(repo, 'first index').catch(() => {}); // ready by the time the model asks
      let s =
        `\n\nYou are working in the git repository ${repo}. Model Hub keeps a fact sheet and a code graph of it (files, layers, imports, endpoints and who calls them), updated on every push. ` +
        'Before reading lots of code, call repo_facts for an overview and code_graph to find the files that matter (search, file, endpoints, dependents, layers); then read only those files.';
      if (includeAgentsMd === 'unless-claude-md' && fs.existsSync(path.join(repo, 'CLAUDE.md'))) includeAgentsMd = false; // Claude Code reads CLAUDE.md itself
      if (includeAgentsMd) {
        // TRACE conventions: AGENTS.md holds the project's context for agents.
        try {
          const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
          s += `\n\nThe repository's AGENTS.md (project context and conventions; follow it):\n<agents_md>\n${agents.slice(0, 8000)}${agents.length > 8000 ? '\n…(truncated; read AGENTS.md for the rest)' : ''}\n</agents_md>`;
        } catch {}
      }
      return s;
    },
  };
}

module.exports = { create };
