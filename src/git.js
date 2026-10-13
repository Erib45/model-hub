// Git integration: everything runs through the git CLI with argument arrays
// (no shell), so paths and messages can't inject commands.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never hang waiting for a password in a hidden console
  GIT_EDITOR: 'true', // merges from pull never open an editor
  LC_ALL: 'C',
};

function git(repo, args, { allowCodes = [0], input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: repo, env: ENV, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (!allowCodes.includes(code)) reject(new Error((stderr || stdout || err?.message || '').toString().trim() || `git ${args[0]} failed`));
      else resolve(stdout.toString());
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// Long-running network commands, streamed line by line for progress.
function gitStream(repo, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repo, env: ENV, windowsHide: true });
    let all = '';
    const handle = (d) => {
      const text = d.toString();
      all += text;
      text.split(/[\r\n]+/).filter(Boolean).forEach((l) => onLine?.(l));
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(all.trim()) : reject(new Error(all.trim() || `git ${args[0]} failed (${code})`))));
  });
}

async function toplevel(dir) {
  try {
    return path.normalize((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

// Parses `git status --porcelain=v2 --branch -z`.
async function status(repo) {
  const out = await git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const st = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      st.branch = line.slice(14);
      st.detached = st.branch === '(detached)';
    } else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (line[0] === '1') {
      const f = line.split(' ');
      st.files.push({ path: f.slice(8).join(' '), x: f[1][0], y: f[1][1] });
    } else if (line[0] === '2') {
      const f = line.split(' ');
      st.files.push({ path: f.slice(9).join(' '), x: f[1][0], y: f[1][1], from: parts[++i] });
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      st.files.push({ path: f.slice(10).join(' '), x: 'U', y: 'U', conflict: true });
    } else if (line[0] === '?') {
      st.files.push({ path: line.slice(2), x: '?', y: '?', untracked: true });
    }
  }
  for (const f of st.files) {
    f.staged = !f.untracked && !f.conflict && f.x !== '.';
    f.unstaged = f.untracked || f.conflict || f.y !== '.';
  }
  return st;
}

function inRepo(repo, file) {
  const abs = path.resolve(repo, file);
  const rel = path.relative(repo, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the repository');
  return rel;
}

async function diff(repo, file, { staged, untracked } = {}) {
  const rel = inRepo(repo, file);
  if (untracked) {
    const abs = path.join(repo, rel);
    if (fs.statSync(abs).size > 2e6) return '(file too large to show)';
    return git(repo, ['diff', '--no-color', '--no-index', '--', '/dev/null', rel], { allowCodes: [0, 1] });
  }
  return git(repo, ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', rel], { allowCodes: [0, 1] });
}

const LOG_FMT = ['%H', '%h', '%an', '%ar', '%s', '%D'].join('%x1f') + '%x1e';

module.exports = {
  toplevel,
  status,
  diff,

  async info(repo) {
    const [st, remotes] = await Promise.all([status(repo), git(repo, ['remote']).catch(() => '')]);
    return { ...st, remotes: remotes.split('\n').filter(Boolean) };
  },

  stage: (repo, files) => git(repo, ['add', '--', ...files.map((f) => inRepo(repo, f))]),
  stageAll: (repo) => git(repo, ['add', '-A']),
  unstage: (repo, files) => git(repo, ['restore', '--staged', '--', ...files.map((f) => inRepo(repo, f))]),

  // Throws away local changes to the given files (untracked files are deleted).
  async discard(repo, files) {
    const st = await status(repo);
    for (const f of files) {
      const rel = inRepo(repo, f);
      const entry = st.files.find((x) => x.path === rel.replace(/\\/g, '/'));
      if (entry?.untracked) fs.rmSync(path.join(repo, rel), { force: true });
      else if (entry?.x === 'A') await git(repo, ['rm', '-f', '--', rel]); // newly added: not in HEAD
      else await git(repo, ['restore', '--staged', '--worktree', '--source=HEAD', '--', rel]);
    }
  },

  commit: (repo, message, amend) =>
    message
      ? git(repo, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message })
      : git(repo, ['commit', '--amend', '--no-edit']), // amend keeping the old message

  async log(repo, n = 150) {
    const out = await git(repo, ['log', `-n${n}`, `--pretty=format:${LOG_FMT}`]).catch(() => '');
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, short, author, when, subject, refs] = r.split('\x1f');
        return { hash, short, author, when, subject, refs };
      });
  },
  show: (repo, hash) => {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Bad commit id');
    return git(repo, ['show', '--no-color', '--stat', '--patch', '--format=%H%n%an <%ae>%n%ad%n%n%B', hash]);
  },

  async branches(repo) {
    const out = await git(repo, ['branch', '--all', '--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, name, head, upstream] = l.split('\x1f');
        return { name, current: head === '*', upstream, remote: ref.startsWith('refs/remotes/') };
      })
      .filter((b) => !/\/HEAD$/.test(b.name) && b.name !== 'origin');
  },
  async switchBranch(repo, name, create) {
    if (!/^[\w./-]+$/.test(name) || name.startsWith('-')) throw new Error('Invalid branch name');
    if (create) return git(repo, ['switch', '-c', name]);
    // Remote branch "origin/x" -> local tracking branch "x".
    const remote = name.match(/^[^/]+\/(.+)$/);
    if (remote) {
      const local = await git(repo, ['branch', '--list', remote[1]]);
      return local.trim() ? git(repo, ['switch', remote[1]]) : git(repo, ['switch', '--track', name]);
    }
    return git(repo, ['switch', name]);
  },

  fetch: (repo, onLine) => gitStream(repo, ['fetch', '--all', '--prune', '--progress'], onLine),
  async pull(repo, onLine) {
    const st = await status(repo);
    if (!st.upstream) throw new Error(`"${st.branch}" isn't linked to a remote branch yet. Push it first (that links it), then pull works.`);
    return gitStream(repo, ['pull', '--no-edit', '--progress'], onLine);
  },
  async push(repo, onLine) {
    const st = await status(repo);
    if (!st.upstream) return gitStream(repo, ['push', '--progress', '-u', 'origin', 'HEAD'], onLine);
    return gitStream(repo, ['push', '--progress'], onLine);
  },

  async clone(url, parentDir, onLine) {
    if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url)) throw new Error('Use an https:// or SSH git URL');
    const name = url.replace(/\.git$/, '').split(/[/:]/).pop();
    const dest = path.join(parentDir, name);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
    fs.mkdirSync(parentDir, { recursive: true });
    await gitStream(parentDir, ['clone', '--progress', url, dest], onLine);
    return dest;
  },
  async init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, ['init']);
    return dir;
  },

  // Finds repositories up to two levels below `root` (e.g. the workspace folder).
  async scan(root, depth = 2) {
    const found = [];
    const walk = (dir, d) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.name === '.git')) {
        found.push(dir);
        return;
      }
      if (d >= depth) return;
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), d + 1);
      }
    };
    walk(root, 0);
    return found;
  },
};
