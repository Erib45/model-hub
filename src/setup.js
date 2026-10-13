// First-run / on-demand dependency setup. Checks what's installed and installs
// missing pieces from official sources (winget packages, npm packages).

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Installers change PATH in the registry; pick that up without restarting the app.
function refreshPath() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { windowsHide: true },
      (err, out) => {
        if (!err && out.trim()) process.env.PATH = out.trim();
        resolve();
      }
    );
  });
}

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of ['.exe', '.cmd', '']) {
      const p = path.join(dir, cmd + ext);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

function version(exe, args = ['--version']) {
  return new Promise((resolve) => {
    if (!exe) return resolve(null);
    execFile(exe, args, { windowsHide: true, timeout: 15000, shell: exe.endsWith('.cmd') }, (err, out) => resolve(err ? null : String(out).trim().split('\n')[0]));
  });
}

const npmGlobal = () => path.join(process.env.APPDATA || '', 'npm');
const exists = (p) => fs.existsSync(p);

// Each item: how to detect it, and how to install it.
const ITEMS = [
  {
    id: 'ollama',
    name: 'Ollama',
    why: 'Runs local models on your GPU. Needed for the Library, Discover and local chat.',
    required: true,
    detect: async () => {
      const exe = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), which('ollama')].find((p) => p && exists(p));
      return exe ? version(exe) : null;
    },
    install: { cmd: 'winget', args: ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'] },
  },
  {
    id: 'git',
    name: 'Git',
    why: 'Used by the Git panel to show changes, commit, push and pull.',
    required: true,
    detect: () => version(which('git')),
    install: { cmd: 'winget', args: ['install', '--id', 'Git.Git', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'] },
  },
  {
    id: 'node',
    name: 'Node.js',
    why: 'Needed to install and run the Codex and Gemini CLIs (and Claude Code via npm).',
    detect: () => version(which('node')),
    install: { cmd: 'winget', args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'] },
  },
  {
    id: 'claudecode',
    name: 'Claude Code',
    why: 'Lets you chat on your own Claude plan (sign in under Settings → Accounts).',
    needs: 'node',
    detect: () => version([path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(npmGlobal(), 'claude.cmd'), which('claude')].find((p) => p && exists(p))),
    install: { npm: '@anthropic-ai/claude-code' },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    why: 'Lets you chat on your ChatGPT plan (sign in under Settings → Accounts).',
    needs: 'node',
    detect: () => (exists(path.join(npmGlobal(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')) ? version(path.join(npmGlobal(), 'codex.cmd')) : null),
    install: { npm: '@openai/codex' },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    why: 'Lets you chat with your Google account (sign in under Settings → Accounts).',
    needs: 'node',
    detect: () => (exists(path.join(npmGlobal(), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')) ? version(path.join(npmGlobal(), 'gemini.cmd')) : null),
    install: { npm: '@google/gemini-cli' },
  },
  {
    id: 'android',
    name: 'Android SDK (emulator)',
    why: 'Optional: runs Android emulators in the side panel. Installed with Android Studio.',
    detect: async () => {
      const root = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')].find((p) => p && exists(p));
      return root && exists(path.join(root, 'emulator', 'emulator.exe')) ? 'installed' : null;
    },
    install: { cmd: 'winget', args: ['install', '--id', 'Google.AndroidStudio', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'] },
    note: 'After installing Android Studio, open it once and create a virtual device (Device Manager).',
  },
];

async function check() {
  await refreshPath();
  return Promise.all(
    ITEMS.map(async (it) => ({
      id: it.id,
      name: it.name,
      why: it.why,
      note: it.note,
      required: !!it.required,
      needs: it.needs,
      version: await it.detect().catch(() => null),
    }))
  );
}

const running = new Map();

function install(id, onLine) {
  const it = ITEMS.find((x) => x.id === id);
  if (!it) throw new Error('Unknown item');
  if (running.has(id)) throw new Error('Already installing');
  let cmd;
  let args;
  if (it.install.npm) {
    const npm = which('npm') || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npm.cmd');
    if (!exists(npm)) throw new Error('Install Node.js first.');
    cmd = npm;
    args = ['install', '-g', it.install.npm];
  } else {
    cmd = which('winget');
    if (!cmd) throw new Error('winget is not available on this PC (install "App Installer" from the Microsoft Store).');
    args = it.install.args;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: cmd.endsWith('.cmd') });
    running.set(id, child);
    let tail = '';
    const handle = (d) => {
      const text = d.toString();
      tail = (tail + text).slice(-4000);
      // winget draws progress bars with \r; report the latest meaningful line.
      text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^[-\\|/█▒ ]+$/.test(l)).forEach((l) => onLine(l));
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (e) => {
      running.delete(id);
      reject(e);
    });
    child.on('close', async (code) => {
      running.delete(id);
      await refreshPath();
      // winget: "already installed" and "no newer version" are fine outcomes too.
      if (code === 0 || /already installed|no (available )?upgrade|No newer package/i.test(tail)) resolve();
      else reject(new Error(tail.trim().split('\n').slice(-3).join(' ') || `Installer exited with code ${code}`));
    });
  });
}

module.exports = { check, install, refreshPath };
