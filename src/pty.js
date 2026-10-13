// Interactive terminal sessions (Windows ConPTY via node-pty), shown with
// xterm.js in the Terminal panel: a real shell, plus CLI sign-in flows.

const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const sessions = new Map(); // id -> { proc, title, kind }
let seq = 0;

function defaultShell() {
  // Prefer PowerShell 7 if installed, else Windows PowerShell.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'pwsh.exe');
    if (dir && fs.existsSync(p)) return { file: p, args: ['-NoLogo'] };
  }
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

/**
 * spec: { title, file, args, cwd, env, kind }  ('shell' | 'login')
 * send(channel, payload) forwards output to the renderer.
 */
function create(spec, send, { cols = 100, rows = 30 } = {}) {
  const id = `pty${++seq}`;
  const shell = spec.file ? spec : { ...spec, ...defaultShell() };
  const proc = pty.spawn(shell.file, shell.args || [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: shell.cwd && fs.existsSync(shell.cwd) ? shell.cwd : process.env.USERPROFILE,
    env: shell.env || process.env,
    useConpty: true,
  });
  const session = { proc, title: spec.title || 'PowerShell', kind: spec.kind || 'shell', provider: spec.provider };
  sessions.set(id, session);
  proc.onData((data) => send('pty:data', { id, data }));
  proc.onExit(({ exitCode }) => {
    sessions.delete(id);
    send('pty:exit', { id, exitCode, provider: session.provider });
  });
  return { id, title: session.title, kind: session.kind, provider: session.provider };
}

module.exports = {
  create,
  write: (id, data) => sessions.get(id)?.proc.write(data),
  resize: (id, cols, rows) => {
    try {
      sessions.get(id)?.proc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
    } catch {}
  },
  kill: (id) => {
    try {
      sessions.get(id)?.proc.kill();
    } catch {}
    sessions.delete(id);
  },
  killAll() {
    for (const id of [...sessions.keys()]) this.kill(id);
  },
};
