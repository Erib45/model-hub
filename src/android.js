// Android emulator bridge: boots AVDs from the local Android SDK and mirrors
// the screen into the app via adb, forwarding taps, swipes and keys.

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function sdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const exe = (sub, name) => {
  const root = sdkRoot();
  if (!root) return null;
  const p = path.join(root, sub, process.platform === 'win32' ? `${name}.exe` : name);
  return fs.existsSync(p) ? p : null;
};

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString() || err.message));
      else resolve(stdout);
    });
  });
}

const shells = new Map(); // serial -> persistent `adb shell` process for low-latency input

function shellFor(serial) {
  let sh = shells.get(serial);
  if (!sh || sh.exitCode !== null) {
    sh = spawn(exe('platform-tools', 'adb'), ['-s', serial, 'shell'], { windowsHide: true });
    sh.on('error', () => shells.delete(serial));
    sh.stdout.resume();
    sh.stderr.resume();
    shells.set(serial, sh);
  }
  return sh;
}

module.exports = {
  info() {
    return { sdk: sdkRoot(), emulator: !!exe('emulator', 'emulator'), adb: !!exe('platform-tools', 'adb') };
  },

  async listAvds() {
    const emu = exe('emulator', 'emulator');
    if (!emu) return [];
    const out = await run(emu, ['-list-avds']);
    return out.toString().split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('INFO'));
  },

  start(avd, headless) {
    const emu = exe('emulator', 'emulator');
    if (!emu) throw new Error('Android emulator not found in SDK');
    const args = ['-avd', avd, '-no-boot-anim'];
    if (headless) args.push('-no-window');
    const child = spawn(emu, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  },

  async devices() {
    const adb = exe('platform-tools', 'adb');
    if (!adb) return [];
    const out = (await run(adb, ['devices'])).toString();
    const serials = out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[1] === 'device')
      .map((p) => p[0]);
    return Promise.all(
      serials.map(async (serial) => {
        let booted = false;
        try {
          booted = (await run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'])).toString().trim() === '1';
        } catch {}
        return { serial, booted };
      })
    );
  },

  async stop(serial) {
    await run(exe('platform-tools', 'adb'), ['-s', serial, 'emu', 'kill']).catch(() => {});
    shells.get(serial)?.kill();
    shells.delete(serial);
  },

  // Raw RGBA framebuffer (no on-device PNG encoding, which is the slow part).
  async frame(serial) {
    const buf = await run(exe('platform-tools', 'adb'), ['-s', serial, 'exec-out', 'screencap'], { encoding: 'buffer' });
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    const header = buf.length - width * height * 4; // 12 bytes on old Android, 16 with colour space
    if (header !== 12 && header !== 16) throw new Error('Unexpected screencap format');
    return { width, height, data: buf.subarray(header) };
  },

  input(serial, ev) {
    const sh = shellFor(serial);
    const n = (v) => Math.round(Number(v));
    let cmd;
    switch (ev.type) {
      case 'tap':
        cmd = `input tap ${n(ev.x)} ${n(ev.y)}`;
        break;
      case 'swipe':
        cmd = `input swipe ${n(ev.x1)} ${n(ev.y1)} ${n(ev.x2)} ${n(ev.y2)} ${n(ev.ms || 200)}`;
        break;
      case 'key':
        cmd = `input keyevent ${n(ev.code)}`;
        break;
      case 'text': {
        // `input text` needs spaces as %s and shell metacharacters escaped.
        const t = String(ev.text).replace(/ /g, '%s').replace(/(["'`\\$&|;<>()*?!#~])/g, '\\$1');
        cmd = `input text ${t}`;
        break;
      }
      default:
        return;
    }
    sh.stdin.write(cmd + '\n');
  },

  shutdown() {
    for (const sh of shells.values()) sh.kill();
    shells.clear();
  },
};
