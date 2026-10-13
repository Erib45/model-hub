// Decides whether a tool call may run without asking the user.
//
// Modes:
//   ask  – every command and file write needs approval
//   auto – read-only commands and writes inside the workspace run on their own;
//          everything else asks
//   full – everything runs, except commands classified as dangerous
// Dangerous commands always ask, in every mode.

const path = require('path');

const DANGEROUS = [
  /\b(Remove-Item|rm|rmdir|rd|ri|del|erase)\b[^\n;|]*(\s-r\b|-Recurse|\s\/s\b|-rf\b)/i,
  /\bformat\s+[a-z]:/i,
  /\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart|bcdedit|vssadmin)\b/i,
  /\b(shutdown|Stop-Computer|Restart-Computer)\b/i,
  /\breg(\.exe)?\s+(delete|add|import)\b/i,
  /\b(Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Remove-Item)\b[^\n]*HK(LM|CU|EY_)/i,
  /\bgit\s+push\b[^\n]*(--force|\s-f\b)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression|sh|bash|powershell|pwsh|cmd)\b/i,
  /\b(Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference)\b/i,
  /\b(cipher\s+\/w|takeown|icacls[^\n]*\/grant)\b/i,
  /\bnet\s+(user|localgroup)\b[^\n]*\/(add|delete)/i,
  /\b(schtasks\s+\/create|New-Service|sc(\.exe)?\s+(create|delete|config))\b/i,
  /\bStop-Process\b[^\n]*(lsass|csrss|winlogon|explorer|svchost)/i,
];
// Touching system folders is only dangerous when the command isn't read-only.
const SYSTEM_PATH = /[a-z]:\\(Windows|Program Files)/i;

const READ_ONLY_CMDS = new Set(
  [
    'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'findstr', 'rg', 'grep',
    'where', 'where.exe', 'get-command', 'gcm', 'get-location', 'pwd', 'gl', 'get-item', 'gi', 'test-path', 'get-date',
    'get-process', 'ps', 'echo', 'write-output', 'write-host', 'tree', 'whoami', 'hostname', 'get-psdrive', 'measure-object',
    'select-object', 'sort-object', 'where-object', 'format-table', 'format-list', 'ft', 'fl', 'resolve-path', 'split-path',
    'join-path', 'get-filehash', 'get-itemproperty', 'get-computerinfo', 'systeminfo', 'nvidia-smi', 'ipconfig',
  ].map((s) => s.toLowerCase())
);
const READ_ONLY_GIT = /^git\s+(status|diff|log|show|branch|remote(\s+-v)?|rev-parse|ls-files|blame|describe|tag)\b(?![^\n]*\s(-d|-D|--delete|add|rm|set-url)\b)/i;
const VERSION_QUERY = /^[\w.-]+(\.exe)?\s+(--version|-v|-V|version)$/i;
const READ_ONLY_PKG = /^(npm\s+(ls|list|outdated|view|config\s+get)|pip\s+(list|show|freeze)|python\s+-m\s+pip\s+(list|show)|ollama\s+(list|ps|show))\b/i;

function isDangerous(command) {
  return DANGEROUS.some((re) => re.test(command)) || (SYSTEM_PATH.test(command) && !isReadOnly(command));
}

function isReadOnly(command) {
  // Sub-expressions, script blocks and redirection can hide writes.
  if (/[`]|\$\(|\biex\b|Invoke-Expression|(^|[^-])>|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b/i.test(command)) return false;
  const segments = command.split(/\|\||&&|[;|\n]/).map((s) => s.trim()).filter(Boolean);
  return segments.every((seg) => {
    const first = seg.split(/\s+/)[0].toLowerCase();
    return READ_ONLY_CMDS.has(first) || READ_ONLY_GIT.test(seg) || VERSION_QUERY.test(seg) || READ_ONLY_PKG.test(seg);
  });
}

// Returns { decision: 'allow' | 'ask', risk: 'read-only' | 'normal' | 'dangerous', reason }
function checkCommand(command, settings) {
  if (isDangerous(command)) return { decision: 'ask', risk: 'dangerous', reason: 'Matches a destructive/system-level pattern' };
  const ro = isReadOnly(command);
  const rule = (settings.allowRules || []).find((r) => command.trim().toLowerCase().startsWith(r.toLowerCase()));
  if (rule) return { decision: 'allow', risk: ro ? 'read-only' : 'normal', reason: `Always-allowed: "${rule}"` };
  if (settings.permissionMode === 'full') return { decision: 'allow', risk: ro ? 'read-only' : 'normal', reason: 'Full auto mode' };
  if (settings.permissionMode === 'auto' && ro) return { decision: 'allow', risk: 'read-only', reason: 'Read-only command' };
  return { decision: 'ask', risk: ro ? 'read-only' : 'normal', reason: ro ? 'Ask mode' : 'May change files or system state' };
}

function checkWrite(filePath, settings) {
  const inside = isInside(filePath, settings.workspaceDir);
  if (SYSTEM_PATH.test(path.resolve(filePath))) return { decision: 'ask', risk: 'dangerous', reason: 'System location' };
  if (settings.permissionMode === 'full') return { decision: 'allow', risk: 'normal', reason: 'Full auto mode' };
  if (settings.permissionMode === 'auto' && inside) return { decision: 'allow', risk: 'normal', reason: 'Inside workspace' };
  return { decision: 'ask', risk: 'normal', reason: inside ? 'Ask mode' : 'Outside the workspace folder' };
}

function isInside(p, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The prefix stored when the user picks "always allow" (e.g. "npm test", "git commit").
function rulePrefix(command) {
  return command.trim().split(/\s+/).slice(0, 2).join(' ');
}

module.exports = { checkCommand, checkWrite, rulePrefix, isReadOnly, isDangerous };
