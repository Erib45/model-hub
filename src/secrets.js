// API keys, encrypted at rest with the OS keychain (DPAPI on Windows).

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'secrets.json');
let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      try {
        cache[k] = safeStorage.decryptString(Buffer.from(v, 'base64'));
      } catch {}
    }
  } catch {}
  return cache;
}

function persist() {
  const out = {};
  for (const [k, v] of Object.entries(cache)) out[k] = safeStorage.encryptString(v).toString('base64');
  fs.writeFileSync(file(), JSON.stringify(out, null, 2));
}

module.exports = {
  get: (name) => load()[name] || null,
  has: (name) => !!load()[name],
  set(name, value) {
    load();
    if (value) cache[name] = value;
    else delete cache[name];
    persist();
  },
};
