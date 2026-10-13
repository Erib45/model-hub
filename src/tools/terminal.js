// Runs PowerShell commands for the AI and for the user. The working directory
// persists between commands, like a real shell session.

const { spawn, execFile } = require('child_process');
const fs = require('fs');

const MARK = '__MODELHUB_END__';
const MAX_OUTPUT = 14000;

class Terminal {
  constructor(send, getSettings) {
    this.send = send; // (channel, payload) -> renderer
    this.getSettings = getSettings;
    this.cwd = null;
    this.running = new Map(); // runId -> child
    this.seq = 0;
  }

  get workingDir() {
    const ws = this.getSettings().workspaceDir;
    if (!this.cwd || !fs.existsSync(this.cwd)) this.cwd = ws;
    return this.cwd;
  }

  run(command, { source = 'ai', timeoutMs = 120000 } = {}) {
    const runId = ++this.seq;
    const cwd = this.workingDir;
    fs.mkdirSync(cwd, { recursive: true });
    // Errors are merged into stdout as plain text (redirected PowerShell would
    // otherwise emit CLIXML). Native stderr (git, npm…) isn't treated as failure;
    // the exit code decides.
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`,
      '$global:LASTEXITCODE = 0',
      '$script:__err = $false',
      `. {\n${command}\n} 2>&1 | ForEach-Object {`,
      '  if ($_ -is [System.Management.Automation.ErrorRecord]) {',
      "    if ($_.FullyQualifiedErrorId -like 'NativeCommandError*') { $_.ToString() } else { $script:__err = $true; 'ERROR: ' + $_.ToString() }",
      '  } else { $_ }',
      '} | Out-String -Stream -Width 250',
      '$__code = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($script:__err) { 1 } else { 0 }',
      `Write-Output "${MARK}$__code|$((Get-Location).Path)"`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd,
      windowsHide: true,
    });
    this.running.set(runId, child);
    this.send('terminal:start', { runId, command, cwd, source });

    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      const onData = (d) => {
        const text = d.toString('utf8');
        output += text;
        const visible = text.replace(new RegExp(`${MARK}.*\\r?\\n?`), '');
        if (visible) this.send('terminal:data', { runId, text: visible });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill(runId);
      }, timeoutMs);
      child.on('close', () => {
        clearTimeout(timer);
        this.running.delete(runId);
        let exitCode = child.exitCode ?? 1;
        const m = output.match(new RegExp(`${MARK}(-?\\d+)\\|(.*)`));
        if (m) {
          exitCode = Number(m[1]);
          if (fs.existsSync(m[2].trim())) this.cwd = m[2].trim();
        }
        output = output.replace(new RegExp(`${MARK}.*\\r?\\n?`), '').replace(/\r\n/g, '\n').trimEnd();
        if (timedOut) output += `\n[timed out after ${timeoutMs / 1000}s]`;
        this.send('terminal:end', { runId, exitCode, cwd: this.cwd });
        resolve({ exitCode, output, cwd: this.cwd });
      });
    });
  }

  kill(runId) {
    const child = this.running.get(runId);
    if (child) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  killAll() {
    for (const id of this.running.keys()) this.kill(id);
  }
}

function formatForModel({ exitCode, output, cwd }) {
  let out = output || '(no output)';
  if (out.length > MAX_OUTPUT) {
    out = out.slice(0, 2000) + `\n…[${out.length - MAX_OUTPUT} chars omitted]…\n` + out.slice(-(MAX_OUTPUT - 2000));
  }
  return `Exit code: ${exitCode}\nCwd: ${cwd}\n\n${out}`;
}

module.exports = { Terminal, formatForModel };
