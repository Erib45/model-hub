// Ollama.com and Hugging Face accounts.
//
// Ollama: signing in links this PC's Ollama key to an ollama.com account, which
// unlocks cloud models (run on Ollama's servers, used through the local API).
// Hugging Face: an access token for browsing gated/private repos, plus linking
// Ollama's SSH key to HF so Ollama can download gated/private GGUFs.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./providers/ollama-api');
const secrets = require('./secrets');

function ollamaExe() {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
  return fs.existsSync(p) ? p : 'ollama';
}

function runCli(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(ollamaExe(), args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', () => {
      clearTimeout(t);
      resolve(out);
    });
    child.on('error', (e) => resolve(String(e.message)));
  });
}

const ollamaAccount = {
  async status() {
    try {
      const res = await fetch(`${api.BASE}/api/me`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.name) return { signedIn: true, name: body.name, plan: body.plan || 'free' };
      return { signedIn: false, signinUrl: body.signin_url || null };
    } catch (e) {
      return { signedIn: false, error: 'Ollama is not running' };
    }
  },

  // Returns the ollama.com URL that links this PC to the user's account.
  async signinUrl() {
    const st = await this.status();
    if (st.signinUrl) return st.signinUrl;
    const out = await runCli(['signin'], 8000);
    const m = out.match(/https:\/\/ollama\.com\/connect\S+/);
    if (!m) throw new Error(out.trim() || 'Could not get a sign-in link from Ollama');
    return m[0];
  },

  signout: () => runCli(['signout']),
};

const HF = 'https://huggingface.co';

const hfAccount = {
  token: () => secrets.get('huggingface'),

  async status() {
    const token = this.token();
    if (!token) return { connected: false, sshKey: this.sshKey() };
    try {
      const res = await fetch(`${HF}/api/whoami-v2`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return { connected: false, hasToken: true, error: `Token rejected (${res.status})`, sshKey: this.sshKey() };
      const me = await res.json();
      return { connected: true, hasToken: true, name: me.name, sshKey: this.sshKey() };
    } catch (e) {
      return { connected: false, hasToken: true, error: e.message, sshKey: this.sshKey() };
    }
  },

  // Checks whether Ollama's SSH key is linked to a Hugging Face account, the
  // way Hugging Face documents: `ssh -T git@hf.co` answers "Hi <user>" for a
  // linked key and "Hi anonymous" otherwise. ssh reads the key; the app doesn't.
  testSshKey() {
    const keyFile = path.join(os.homedir(), '.ollama', 'id_ed25519');
    if (!fs.existsSync(keyFile)) return Promise.resolve({ linked: false, error: "Ollama's key wasn't found. Start Ollama once to create it." });
    const { app } = require('electron');
    const knownHosts = path.join(app.getPath('userData'), 'hf_known_hosts'); // keeps the user's own known_hosts untouched
    const args = ['-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=15', '-T', 'git@hf.co'];
    return new Promise((resolve) => {
      const child = spawn('ssh', args, { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => child.kill(), 25000);
      child.on('error', () => resolve({ linked: false, error: "Windows' SSH client (ssh.exe) isn't available. Enable \"OpenSSH Client\" in Windows optional features." }));
      child.on('close', () => {
        clearTimeout(t);
        const user = (out.match(/Hi ([^,\s]+), welcome to Hugging Face/) || [])[1];
        if (!user) resolve({ linked: false, error: out.trim().split('\n').pop() || 'No answer from hf.co' });
        else if (user === 'anonymous') resolve({ linked: false, user, error: "The key isn't linked to a Hugging Face account yet." });
        else resolve({ linked: true, user });
      });
    });
  },

  // Ollama downloads hf.co models with its own SSH identity; adding this public
  // key to the HF account lets it fetch gated and private repos.
  sshKey() {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.ollama', 'id_ed25519.pub'), 'utf8').trim();
    } catch {
      return null;
    }
  },

  authHeaders() {
    const t = this.token();
    return t ? { Authorization: `Bearer ${t}` } : {};
  },
};

module.exports = { ollamaAccount, hfAccount };
