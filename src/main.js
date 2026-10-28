const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const catalog = require('./catalog');
const discover = require('./discover');
const { ollamaAccount, hfAccount } = require('./accounts');
const { aiPick } = require('./recommend');
const gitOps = require('./git');
const setup = require('./setup');
const ptys = require('./pty');
const repoKnowledgeModule = require('./repoknowledge');
const android = require('./android');
const secrets = require('./secrets');
const { providers, parse, listAll } = require('./providers');
const { repairHistory, genId, handBack } = require('./providers/common');
const compact = require('./compact');
const agents = require('./agents');
const { startBridge } = require('./claudecode/bridge');
const { SharedBrowser } = require('./tools/browser');
const { Terminal } = require('./tools/terminal');
const { TOOLS, runTool } = require('./tools');

// Keep the data folder at %APPDATA%\model-hub (the productName "Model Hub" would
// otherwise move it), unless something already chose a custom folder (tests).
if (path.basename(app.getPath('userData')) === app.getName()) {
  app.setPath('userData', path.join(app.getPath('appData'), 'model-hub'));
}

let win;
let browser;
const repoKnowledge = repoKnowledgeModule.create({
  getSettings: () => getSettings(),
  parseModel: (id) => parse(id),
  notify: (st) => win?.webContents.send('repo:status', st),
});
let terminal;

// ---------- persistence ----------

const dataDir = () => app.getPath('userData');
const chatsDir = () => path.join(dataDir(), 'chats');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const DEFAULT_SETTINGS = {
  numCtx: 16384,
  systemPrompt: 'You are a helpful assistant specialised in software development. Be concise and precise.',
  workspaceDir: path.join(os.homedir(), 'dev'),
  permissionMode: 'auto', // ask | auto | full
  allowRules: [],
  reviewerEnabled: true, // local AI reviewer for "normal" commands in Auto mode
  reviewerModel: '', // '' = pick a small installed model automatically
  mergerEnabled: false, // auto-run Merger Agent when an agent finishes work on a branch
  mergerModel: '', // model of the user's choice for Merger Agent ('' = chat's model)
  mergerTargetBranch: 'main', // target base branch to check/merge into
  mergerAutoSend: true, // automatically send conflict reports back to the working chat agent
  testerEnabled: false, // auto-run Tester Agent when an agent modifies files
  testerModel: '', // model of the user's choice for Tester Agent ('' = chat's model)
  testerCommand: '', // custom test command ('' = auto-detect)
  testerAutoSend: true, // automatically send test failure reports back to the working chat agent
  theme: 'dark', // dark | light
  gitRepos: [], // tracked repository paths
  gitActive: '', // repository shown in the Git panel
  handoff: 'compact', // compact | full: what a model sees of other models' tool work
  claudeCacheTtl: '1h', // 1h | 5m prompt-cache lifetime for Claude
  setupDone: false, // first-run dependency setup finished or skipped
  repoKnowledge: true, // index repos into a code graph + fact sheet
  factSheetModel: '', // model that writes the fact sheet's summary ('' = no AI summary)
  tracePlugin: true, // keep the TRACE plugin installed for Claude Code and Codex
  traceUpdatedAt: 0,
};
const settingsFile = () => path.join(dataDir(), 'settings.json');
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) });
const setSettings = (patch) => {
  writeJson(settingsFile(), { ...getSettings(), ...patch });
  if (patch.theme) {
    nativeTheme.themeSource = patch.theme; // web pages in the browser follow the app theme
    const isLight = patch.theme === 'light';
    try {
      win?.setTitleBarOverlay?.({
        color: isLight ? '#eef0f6' : '#090b10',
        symbolColor: isLight ? '#334155' : '#94a3b8',
        height: 38,
      });
    } catch {}
  }
};

const notesFile = () => path.join(dataDir(), 'model-notes.json');

const chatFile = (id) => path.join(chatsDir(), `${id.replace(/[^\w-]/g, '')}.json`);
function loadChat(id) {
  const chat = readJson(chatFile(id), null);
  if (!chat) return null;
  // Older chats stored bare Ollama names and Ollama-shaped tool calls.
  const fixId = (m) => (m && !/^(ollama|anthropic|gemini|openai|claudecode|codexcli|geminicli|antigravity):/.test(m) ? `ollama:${m}` : m);
  chat.model = fixId(chat.model);
  for (const m of chat.messages) {
    if (m.model) m.model = fixId(m.model);
    if (m.tool_calls) m.tool_calls = m.tool_calls.map((tc) => (tc.function ? { id: genId(), name: tc.function.name, arguments: tc.function.arguments } : tc));
  }
  return chat;
}
const saveChat = (chat) => {
  chat.updatedAt = Date.now();
  writeJson(chatFile(chat.id), chat);
};

// ---------- approvals ----------

const pendingApprovals = new Map(); // id -> { resolve, chatId }

function requestApproval(chatId, signal, req) {
  const id = crypto.randomUUID();
  const chat = loadChat(chatId);
  return new Promise((resolve) => {
    pendingApprovals.set(id, { resolve, chatId });
    win.webContents.send('approval:request', {
      id,
      chatId,
      chatTitle: chat?.title || 'Chat',
      cwd: req.cwd || terminal?.workingDir || '',
      ...req,
    });
    signal.addEventListener('abort', () => {
      if (pendingApprovals.delete(id)) resolve('deny');
    });
  });
}

// ---------- chat orchestration ----------

const active = new Map(); // chatId -> AbortController

function describeToolCall(name, args = {}) {
  const short = (s, n = 80) => {
    const str = String(s || '').trim().replace(/\s+/g, ' ');
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  switch (name) {
    case 'run_command':
    case 'codex_shell':
      return { label: 'Running command', target: short(args.command), panel: 'terminal' };
    case 'write_file':
      return { label: 'Writing file', target: short(args.path), panel: 'git' };
    case 'read_file':
    case 'Read':
      return { label: 'Reading file', target: short(args.path || args.file_path) };
    case 'Edit':
    case 'MultiEdit':
    case 'codex_edit':
      return { label: 'Editing file', target: short(args.file_path || args.path || args.changes?.[0]?.path), panel: 'git' };
    case 'web_search':
    case 'codex_web_search':
      return { label: 'Searching web', target: short(args.query), panel: 'browser' };
    case 'open_url':
      return { label: 'Opening page', target: short(args.url), panel: 'browser' };
    case 'read_page':
      return { label: 'Reading browser page', target: '', panel: 'browser' };
    case 'click':
      return { label: 'Clicking element', target: `#${args.element ?? ''}`, panel: 'browser' };
    case 'type_text':
      return { label: 'Typing in browser', target: short(args.text), panel: 'browser' };
    case 'repo_facts':
      return { label: 'Reading repo facts', target: short(args.path), panel: 'git' };
    case 'code_graph':
      return { label: `Code graph (${args.action || 'query'})`, target: short(args.query || args.path), panel: 'git' };
    case 'Grep':
    case 'Glob':
      return { label: 'Searching codebase', target: short(args.pattern || args.path) };
    default:
      return { label: `Using ${name}`, target: short(args.path || args.file_path || args.command || args.query || '') };
  }
}

function systemPrompt(settings, useTools, extra = '') {
  let s = `${settings.systemPrompt}\nToday's date is ${new Date().toISOString().slice(0, 10)}. The user is on Windows (${os.release()}).`;
  if (useTools) {
    s +=
      `\n\nYou have tools:\n` +
      `- A web browser shared with the user (they see it and can click in it). Use web_search, then open_url/read_page to read sources; click/type_text to interact. Cite URLs for facts you found online. The user may navigate it themselves - use read_page to see what they are looking at.\n` +
      `- A PowerShell terminal (run_command) and read_file/write_file. The workspace folder is ${settings.workspaceDir}. Prefer working inside it. Some commands need the user's approval; if one is denied, don't retry it - ask the user or choose another approach.\n` +
      `Use tools when they help; answer directly when they don't.`;
  }
  return s + extra;
}

// ---------- Claude Code (agentic provider) ----------

const toolRunners = new Map(); // chatId -> (name, args) => result, while a Claude Code turn runs
let bridgeInfo = null;
async function ensureBridge() {
  bridgeInfo ||= await startBridge({ tools: TOOLS, getRunner: (id) => toolRunners.get(id) });
  return bridgeInfo;
}

const traceChecked = new Set();
async function ensureTrace(provider, { update = false } = {}) {
  if (!getSettings().tracePlugin || !provider.ensurePlugin) return null;
  const r = await provider.ensurePlugin({ update }).catch((e) => ({ ok: false, error: e.message }));
  traceChecked.add(provider.id);
  return r;
}

async function runAgenticTurn({ chat, chatId, modelId, name, provider, text, useTools, tools, effort, ctrl, send, runAppTool, setPending }) {
  const settings = getSettings();
  if (!traceChecked.has(provider.id)) {
    const r = await ensureTrace(provider);
    if (r && !r.ok) send({ type: 'notice', text: `Couldn't set up the TRACE plugin for this CLI: ${r.error}` });
    else if (r?.installed) send({ type: 'notice', text: 'Installed the TRACE plugin for this CLI.' });
  }
  // One CLI session per provider per chat, resumed while the history still matches.
  chat.agentSessions ||= {};
  const sess = chat.agentSessions[provider.id];
  const cwd = sess?.cwd && fs.existsSync(sess.cwd) ? sess.cwd : terminal.workingDir;
  const resuming = !!sess?.sessionId && sess.cwd === cwd;
  // Everything since this CLI last answered (or the whole chat for a new session), minus the new user message.
  const since = chat.messages.slice(resuming ? sess.upTo : 0, -1);
  const context = settings.handoff === 'full' ? repairHistory(since) : handBack(repairHistory(since), modelId);

  let bridge = null;
  if (useTools) {
    const { port, token } = await ensureBridge();
    bridge = { port, token };
    toolRunners.set(chatId, runAppTool);
  }

  let live = { role: 'assistant', model: modelId, content: '', thinking: '' };
  setPending(live);
  send({ type: 'start', model: modelId, cwd });
  const t0 = Date.now();
  try {
    const turn = await provider.chatTurn({
      model: name,
      system: systemPrompt(settings, useTools, useTools ? await repoKnowledge.promptContext(terminal.workingDir, { includeAgentsMd: provider.id === 'claudecode' ? 'unless-claude-md' : false }) : ''),
      context,
      userText: text,
      resuming,
      sessionId: sess?.sessionId,
      tools,
      cwd,
      bridge,
      chatId,
      effort,
      signal: ctrl.signal,
      onText: (d) => {
        live.content += d;
        send({ type: 'delta', text: d, cwd });
      },
      onThinking: (d) => {
        live.thinking += d;
        send({ type: 'thinking', text: d, cwd });
      },
      // Intermediate steps (tool calls, tool results) as Claude Code reports them.
      emitMessage: (m) => {
        chat.messages.push(m);
        saveChat(chat);
        if (m.tool_calls?.length) {
          const tc = m.tool_calls[m.tool_calls.length - 1];
          send({ type: 'tool_call', name: tc.name, args: tc.arguments, cwd, internal: true, ...describeToolCall(tc.name, tc.arguments) });
        }
        send({ type: 'message', message: m });
        if (m.role === 'tool') {
          live = { role: 'assistant', model: modelId, content: '', thinking: '' };
          setPending(live);
          send({ type: 'start', model: modelId, cwd });
        }
      },
    });
    setPending(null);
    const msg = { role: 'assistant', model: modelId, content: turn.content };
    if (turn.thinking) msg.thinking = turn.thinking;
    if (turn.stats) msg.stats = { ...turn.stats, ms: turn.stats.ms || Date.now() - t0 };
    chat.messages.push(msg);
    chat.agentSessions[provider.id] = { sessionId: turn.sessionId, cwd, upTo: chat.messages.length };
    saveChat(chat);
    send({ type: 'message', message: msg });
    if (turn.notice) send({ type: 'notice', text: turn.notice });
  } finally {
    toolRunners.delete(chatId);
  }
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
// Picks the closest level the model supports (never higher than asked, unless
// even its lowest level is higher).
function clampEffort(effort, supported) {
  if (!effort || !supported?.length) return null;
  if (supported.includes(effort)) return effort;
  const want = EFFORT_ORDER.indexOf(effort);
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= want);
  return below.length ? below[below.length - 1] : supported[0];
}
const modelEfforts = new Map(); // modelId -> supported levels (filled by models:list)

function listAllChatsMeta() {
  fs.mkdirSync(chatsDir(), { recursive: true });
  return fs
    .readdirSync(chatsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(chatsDir(), f), null))
    .filter(Boolean)
    .map(({ id, title, model, cwd, repo, branch, updatedAt }) => ({ id, title, model, cwd, repo, branch, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function formatAgentReportPrompt(report) {
  if (report.agent === 'merger') {
    const conflictDetails = (report.conflicts || [])
      .map((c) => `- **${c.file}**: ${c.cause}\n  Suggested resolution: ${c.resolution}`)
      .join('\n');
    const branchFiles = (report.results || [])
      .filter((r) => !r.clean)
      .map((r) => `Branch \`${r.branch}\` into \`${r.targetBranch}\` (${r.conflictFiles.join(', ') || 'conflict'}):\n${r.rawOutput.slice(0, 3000)}`)
      .join('\n\n');
    return [
      `[Merger Agent Report — Conflicts detected with \`${report.baseBranch}\`]`,
      report.summary,
      conflictDetails ? `\nConflicting files:\n${conflictDetails}` : '',
      branchFiles ? `\nGit merge output:\n\`\`\`\n${branchFiles}\n\`\`\`` : '',
      report.instructionsForAgent ? `\nInstructions to resolve:\n${report.instructionsForAgent}` : '\nPlease resolve these merge conflicts cleanly so the branch can merge into main without losing work.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const stepLines = (report.steps || [])
    .map((s, i) => `  ${i + 1}. \`${s.command}\` (${s.label || 'stage'}) — **${s.passed ? 'PASS' : `FAIL (exit ${s.exitCode})`}** (${((s.durationMs || 0) / 1000).toFixed(1)}s)`)
    .join('\n');
  const failDetails = (report.failures || [])
    .map((f) => `- **${f.test_or_file}**: ${f.root_cause}\n  Suggested fix: ${f.suggested_fix}`)
    .join('\n');
  return [
    `[Tester Agent Report — CI Test Pipeline Failures (branch: \`${report.branch || 'HEAD'}\`, exit ${report.exitCode})]`,
    report.summary,
    stepLines ? `\nCI Pipeline Stages:\n${stepLines}` : '',
    failDetails ? `\nFailures:\n${failDetails}` : '',
    report.output ? `\nCommand output:\n\`\`\`\n${report.output.slice(-4500)}\n\`\`\`` : '',
    report.instructionsForAgent ? `\nInstructions to fix:\n${report.instructionsForAgent}` : '\nPlease fix the failing tests/errors and verify that the CI checks pass.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function deliverReportToChat(targetChatId, report, { autoTrigger = false } = {}) {
  if (!targetChatId) return false;
  const chat = loadChat(targetChatId);
  if (!chat) return false;
  const msg = {
    role: 'system',
    kind: 'agent_report',
    agent: report.agent,
    report,
    autoTriggered: Boolean(autoTrigger),
    content: '',
    at: Date.now(),
  };
  chat.messages.push(msg);
  saveChat(chat);
  win?.webContents.send('chat:event', { chatId: targetChatId, type: 'message', message: msg });

  if (autoTrigger && !active.has(targetChatId) && chat.model) {
    if (report.repo && fs.existsSync(report.repo)) {
      terminal.cwd = report.repo;
    }
    const prompt = formatAgentReportPrompt(report);
    runChat(targetChatId, chat.model, prompt, true, chat.effort || '', { isAgentReport: true });
    return true;
  }
  return false;
}

// ---------- Strict Single-MR Tester & Merger Queues ----------
// Only ONE MR/task may run tests at a time so multiple concurrent agents never overload the PC.
const testerQueue = []; // [{ key, opts, label, chatId, repo, branch, resolvers: [{ resolve, reject }] }]
let activeTesterJob = null;

const mergerQueue = [];
let activeMergerJob = null;

function broadcastQueueState() {
  win?.webContents.send('agents:event', {
    agent: 'queue',
    state: 'queue_update',
    testerActive: activeTesterJob
      ? {
          chatId: activeTesterJob.chatId,
          label: activeTesterJob.label,
          repo: activeTesterJob.repo,
          branch: activeTesterJob.branch,
          model: activeTesterJob.model,
          startedAt: activeTesterJob.startedAt,
          stepText: activeTesterJob.stepText,
          liveLine: activeTesterJob.liveLine,
          stepIndex: activeTesterJob.stepIndex,
          stepTotal: activeTesterJob.stepTotal,
          stages: activeTesterJob.stages || [],
        }
      : null,
    testerQueue: testerQueue.map((j, idx) => ({
      position: idx + 1,
      chatId: j.chatId,
      label: j.label,
      repo: j.repo,
      branch: j.branch,
    })),
    mergerActive: activeMergerJob
      ? {
          chatId: activeMergerJob.chatId,
          label: activeMergerJob.label,
          repo: activeMergerJob.repo,
          branch: activeMergerJob.branch,
          model: activeMergerJob.model,
          startedAt: activeMergerJob.startedAt,
          stepText: activeMergerJob.stepText,
        }
      : null,
    mergerQueue: mergerQueue.map((j, idx) => ({
      position: idx + 1,
      chatId: j.chatId,
      label: j.label,
      repo: j.repo,
      branch: j.branch,
    })),
  });

  // Also notify each queued tester job's chat of its updated position in line
  testerQueue.forEach((j, idx) => {
    const activeLbl = activeTesterJob?.label || 'current MR';
    win?.webContents.send('agents:event', {
      agent: 'tester',
      chatId: j.chatId,
      repo: j.repo,
      branch: j.branch,
      state: 'queued',
      queuePosition: idx + 1,
      queueTotal: testerQueue.length,
      text: `Queued for Tester (#${idx + 1} in line — waiting for ${activeLbl} to finish testing)…`,
    });
  });
}

async function runSingleTesterJob(job) {
  const { chatId, repo, cwd, customCommand, modelId, autoSend, userRequest } = job.opts;
  const s = getSettings();
  const chat = chatId ? loadChat(chatId) : null;
  const chosenModel = modelId || s.testerModel || chat?.model || '';
  job.model = chosenModel;
  job.startedAt = Date.now();
  const workCwd = cwd || chat?.cwd || terminal?.workingDir || s.workspaceDir;
  const workRepo = repo || chat?.repo || (await gitOps.toplevel(workCwd).catch(() => null)) || workCwd;
  const sendEv = (ev) => win?.webContents.send('agents:event', { agent: 'tester', chatId, repo: workRepo, branch: job.branch, ...ev });

  sendEv({ state: 'running', text: `Tester Agent starting on ${job.label}…`, model: chosenModel });
  broadcastQueueState();
  try {
    const report = await agents.runTesterAgent({
      cwd: workCwd,
      repo: workRepo,
      customCommand: customCommand ?? s.testerCommand,
      modelId: chosenModel,
      userRequest: userRequest || [...(chat?.messages || [])].reverse().find((m) => m.role === 'user')?.content || '',
      onProgress: (p) => {
        job.stepText = p.text;
        if (p.liveLine) job.liveLine = p.liveLine;
        if (p.stepIndex) job.stepIndex = p.stepIndex;
        if (p.stepTotal) job.stepTotal = p.stepTotal;
        if (p.stages) job.stages = p.stages;
        sendEv({
          state: 'running',
          text: p.text,
          stage: p.stage,
          command: p.command,
          stepIndex: p.stepIndex,
          stepTotal: p.stepTotal,
          stages: p.stages,
          liveLine: p.liveLine,
          model: chosenModel,
        });
        broadcastQueueState();
      },
    });
    const shouldAutoSend = (autoSend ?? s.testerAutoSend) && report.verdict === 'fail';
    const triggered = chatId ? await deliverReportToChat(chatId, report, { autoTrigger: shouldAutoSend }) : false;
    sendEv({ state: 'done', report, triggered });
    return { report, triggered };
  } catch (e) {
    sendEv({ state: 'error', text: e.message });
    throw e;
  }
}

async function drainTesterQueue() {
  if (activeTesterJob || !testerQueue.length) {
    broadcastQueueState();
    return;
  }
  const job = testerQueue.shift();
  activeTesterJob = job;
  broadcastQueueState();
  try {
    const res = await runSingleTesterJob(job);
    for (const r of job.resolvers) r.resolve(res);
  } catch (err) {
    for (const r of job.resolvers) r.reject(err);
  } finally {
    activeTesterJob = null;
    drainTesterQueue();
  }
}

async function executeTester(opts = {}) {
  const s = getSettings();
  const chat = opts.chatId ? loadChat(opts.chatId) : null;
  const workCwd = opts.cwd || chat?.cwd || terminal?.workingDir || s.workspaceDir;
  const workRepo = opts.repo || chat?.repo || (await gitOps.toplevel(workCwd).catch(() => null)) || workCwd;
  const st = await gitOps.status(workRepo).catch(() => null);
  const branch = chat?.branch || st?.branch || '';
  const repoName = path.basename(workRepo || 'workspace');
  const label = [chat?.title, branch ? `(${branch})` : repoName].filter(Boolean).join(' ') || repoName;
  const key = `${workRepo}::${opts.chatId || branch || 'manual'}`;

  // If this exact MR/chat is already waiting in the queue, coalesce with the queued entry
  const existing = testerQueue.find((j) => j.key === key);
  if (existing) {
    existing.opts = { ...existing.opts, ...opts };
    return new Promise((resolve, reject) => {
      existing.resolvers.push({ resolve, reject });
    });
  }

  return new Promise((resolve, reject) => {
    testerQueue.push({
      key,
      opts: { ...opts, cwd: workCwd, repo: workRepo },
      chatId: opts.chatId || null,
      repo: workRepo,
      branch,
      label,
      stepText: 'Starting…',
      resolvers: [{ resolve, reject }],
    });
    broadcastQueueState();
    drainTesterQueue();
  });
}

async function runSingleMergerJob(opts = {}) {
  const { chatId, repo, sourceBranch, targetBranch, performMerge = false, modelId, autoSend } = opts;
  const s = getSettings();
  const chat = chatId ? loadChat(chatId) : null;
  const chosenModel = modelId || s.mergerModel || chat?.model || '';
  const workCwd = chat?.cwd || terminal?.workingDir || s.workspaceDir;
  const workRepo = repo || chat?.repo || s.gitActive || (await gitOps.toplevel(workCwd).catch(() => null));
  if (!workRepo) throw new Error('No Git repository found for Merger Agent.');
  const sendEv = (ev) => win?.webContents.send('agents:event', { agent: 'merger', chatId, repo: workRepo, ...ev });

  sendEv({ state: 'running', text: 'Merger Agent checking branches…', model: chosenModel });
  try {
    const allChats = listAllChatsMeta();
    const report = await agents.runMergerAgent({
      repo: workRepo,
      sourceBranch: sourceBranch || chat?.branch || '',
      targetBranch: targetBranch || s.mergerTargetBranch || 'main',
      performMerge,
      modelId: chosenModel,
      chats: allChats,
      onProgress: (p) => sendEv({ state: 'running', text: p.text, stage: p.stage, model: chosenModel }),
    });
    if (report.results?.some((r) => r.merged)) {
      win?.webContents.send('git:changed');
    }

    const shouldAutoSend = (autoSend ?? s.mergerAutoSend) && report.status === 'conflict';
    const targetChatIds = new Set();
    if (report.status === 'conflict') {
      for (const r of report.results || []) {
        if (!r.clean && r.ownerChatId) targetChatIds.add(r.ownerChatId);
      }
    }
    if (chatId) targetChatIds.add(chatId);

    let triggered = false;
    for (const tid of targetChatIds) {
      const t = await deliverReportToChat(tid, report, { autoTrigger: shouldAutoSend && !triggered });
      if (t) triggered = true;
    }
    sendEv({ state: 'done', report, triggered });
    return { report, triggered };
  } catch (e) {
    sendEv({ state: 'error', text: e.message });
    throw e;
  }
}

async function drainMergerQueue() {
  if (activeMergerJob || !mergerQueue.length) {
    broadcastQueueState();
    return;
  }
  const job = mergerQueue.shift();
  activeMergerJob = job;
  broadcastQueueState();
  try {
    const res = await runSingleMergerJob(job.opts);
    for (const r of job.resolvers) r.resolve(res);
  } catch (err) {
    for (const r of job.resolvers) r.reject(err);
  } finally {
    activeMergerJob = null;
    drainMergerQueue();
  }
}

async function executeMerger(opts = {}) {
  const s = getSettings();
  const chat = opts.chatId ? loadChat(opts.chatId) : null;
  const workCwd = chat?.cwd || terminal?.workingDir || s.workspaceDir;
  const workRepo = opts.repo || chat?.repo || s.gitActive || (await gitOps.toplevel(workCwd).catch(() => null)) || '';
  const branch = opts.sourceBranch || chat?.branch || '';
  const label = [chat?.title, branch ? `(${branch})` : path.basename(workRepo || 'repo')].filter(Boolean).join(' ');
  const key = `${workRepo}::${branch || opts.chatId || 'manual'}::${opts.performMerge ? 'merge' : 'check'}`;

  const existing = mergerQueue.find((j) => j.key === key);
  if (existing) {
    existing.opts = { ...existing.opts, ...opts };
    return new Promise((resolve, reject) => {
      existing.resolvers.push({ resolve, reject });
    });
  }

  return new Promise((resolve, reject) => {
    mergerQueue.push({
      key,
      opts,
      chatId: opts.chatId || null,
      repo: workRepo,
      branch,
      label,
      resolvers: [{ resolve, reject }],
    });
    broadcastQueueState();
    drainMergerQueue();
  });
}

async function runChat(chatId, modelId, text, useTools, effortWanted, opts = {}) {
  const chat = loadChat(chatId);
  const send = (ev) => win?.webContents.send('chat:event', { chatId, ...ev });
  const ctrl = new AbortController();
  active.set(chatId, ctrl);
  let pending = null; // assistant message being streamed, kept if the user stops
  let modifiedWorktree = false;

  try {
    // Seamless swap: history is provider-neutral, so whichever model answers next sees all of it.
    const prevModel = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model;
    if (prevModel && prevModel !== modelId) {
      chat.messages.push({ kind: 'switch', role: 'system', from: prevModel, to: modelId, content: '' });
    }
    chat.model = modelId;
    chat.effort = effortWanted || '';
    chat.cwd = terminal.workingDir;
    const topRepo = await gitOps.toplevel(terminal.workingDir).catch(() => null);
    if (topRepo) {
      chat.repo = topRepo;
      const st = await gitOps.status(topRepo).catch(() => null);
      if (st?.branch && !st.detached) chat.branch = st.branch;
    }
    const effort = clampEffort(effortWanted, modelEfforts.get(modelId));
    chat.messages.push({ role: 'user', content: text });
    if (!chat.title || chat.title === 'New chat') chat.title = text.slice(0, 60);
    saveChat(chat);
    send({ type: 'saved', chat, cwd: terminal.workingDir });

    const { provider, name } = parse(modelId);
    const tools = useTools ? TOOLS : null;

    // Runs one of the app's tools for this chat (approvals, AI reviewer, panels).
    const runAppTool = async (callName, args) => {
      send({ type: 'tool_call', name: callName, args, cwd: terminal.workingDir, ...describeToolCall(callName, args) });
      if (ctrl.signal.aborted) return { content: 'Cancelled by user.', isError: true };
      const result = await runTool(
        {
          browser,
          terminal,
          repoKnowledge,
          settings: getSettings(),
          approve: (req) => requestApproval(chatId, ctrl.signal, { ...req, model: modelId }),
          userRequest: text,
          onReview: (r) => send({ type: 'review', cwd: terminal.workingDir, ...r }),
          addAllowRule: (rule) => {
            const s = getSettings();
            if (!s.allowRules.includes(rule)) setSettings({ allowRules: [...s.allowRules, rule] });
          },
        },
        callName,
        args
      );
      if (['run_command', 'write_file'].includes(callName)) {
        modifiedWorktree = true;
        win?.webContents.send('git:changed');
      }
      return result;
    };

    const runPostTurnAgents = async () => {
      if (opts.isAgentReport || !modifiedWorktree || ctrl.signal.aborted) return;
      const postRepo = await gitOps.toplevel(terminal.workingDir).catch(() => null);
      if (postRepo) {
        chat.repo = postRepo;
        const postSt = await gitOps.status(postRepo).catch(() => null);
        if (postSt?.branch && !postSt.detached) chat.branch = postSt.branch;
        saveChat(chat);
      }
      const s = getSettings();
      let triggeredFix = false;
      if (s.testerEnabled) {
        const res = await executeTester({ chatId, cwd: terminal.workingDir, repo: chat.repo, userRequest: text }).catch(() => null);
        if (res?.triggered) triggeredFix = true;
      }
      if (s.mergerEnabled && chat.repo && !triggeredFix) {
        await executeMerger({ chatId, repo: chat.repo, sourceBranch: chat.branch }).catch(() => null);
      }
    };

    if (provider.agentic) {
      // Claude Code runs its own agent loop; it reaches our tools through MCP.
      await runAgenticTurn({ chat, chatId, modelId, name, provider, text, useTools, tools, effort, ctrl, send, runAppTool, setPending: (p) => (pending = p) });
      if (useTools) modifiedWorktree = true;
      send({ type: 'done' });
      active.delete(chatId);
      await runPostTurnAgents();
      return;
    }

    // Repo the AI works in: point it at the fact sheet / code graph, and include
    // AGENTS.md (TRACE's project context) for models that don't read it themselves.
    const repoCtx = useTools ? await repoKnowledge.promptContext(terminal.workingDir, { includeAgentsMd: true }) : '';
    const noticed = new Set();
    for (let round = 0; round < 30; round++) {
      const settings = getSettings();
      const history = repairHistory(chat.messages);
      pending = { role: 'assistant', model: modelId, content: '', thinking: '' };
      send({ type: 'start', model: modelId, cwd: terminal.workingDir });
      const t0 = Date.now();
      const turn = await provider.chatTurn({
        model: name,
        system: systemPrompt(settings, useTools, repoCtx),
        messages: settings.handoff === 'full' ? history : handBack(history, modelId),
        tools,
        settings,
        effort,
        signal: ctrl.signal,
        onText: (d) => {
          pending.content += d;
          send({ type: 'delta', text: d });
        },
        onThinking: (d) => {
          pending.thinking += d;
          send({ type: 'thinking', text: d });
        },
      });
      pending = null;

      const msg = { role: 'assistant', model: modelId, content: turn.content };
      if (turn.thinking) msg.thinking = turn.thinking;
      if (turn.toolCalls.length) msg.tool_calls = turn.toolCalls;
      if (turn.native) msg.native = turn.native;
      if (turn.stats) msg.stats = { ...turn.stats, ms: turn.stats.ms || Date.now() - t0 };
      chat.messages.push(msg);
      saveChat(chat);
      send({ type: 'message', message: msg });
      if (turn.notice && !noticed.has(turn.notice)) {
        noticed.add(turn.notice);
        send({ type: 'notice', text: turn.notice });
      }
      if (!turn.toolCalls.length) break;

      for (const call of turn.toolCalls) {
        const result = await runAppTool(call.name, call.arguments);
        const toolMsg = { role: 'tool', tool_call_id: call.id, tool_name: call.name, content: result.content };
        if (result.isError) toolMsg.is_error = true;
        chat.messages.push(toolMsg);
        saveChat(chat);
        send({ type: 'message', message: toolMsg });
      }
      if (ctrl.signal.aborted) throw new Error('aborted');
    }
    send({ type: 'done' });
    active.delete(chatId);
    await runPostTurnAgents();
  } catch (e) {
    if (pending?.content) {
      pending.content += ctrl.signal.aborted ? ' …[stopped]' : '';
      if (!pending.thinking) delete pending.thinking;
      chat.messages.push(pending);
      send({ type: 'message', message: pending });
    }
    saveChat(chat);
    if (ctrl.signal.aborted) send({ type: 'done', aborted: true });
    else send({ type: 'error', text: e.message });
  } finally {
    active.delete(chatId);
  }
}

// ---------- IPC ----------

function ollamaExe() {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
  return fs.existsSync(p) ? p : 'ollama';
}

function registerIpc() {
  const { ollama, anthropic, gemini, openai } = providers;

  ipcMain.handle('ollama:status', () => ollama.status());
  ipcMain.handle('ollama:start', async () => {
    spawn(ollamaExe(), ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await ollama.status()).running) return true;
    }
    return false;
  });

  // Accounts
  ipcMain.handle('accounts:status', async () => {
    const [a, g, oa, o, h, cc, cx, gc, ag] = await Promise.all([
      anthropic.status(), gemini.status(), openai.status(), ollamaAccount.status(), hfAccount.status(),
      providers.claudecode.status(), providers.codexcli.status(), providers.geminicli.status(), providers.antigravity.status(),
    ]);
    return {
      claudecode: cc,
      codexcli: cx,
      geminicli: gc,
      antigravity: ag,
      anthropic: { ...a, hasKey: secrets.has('anthropic') },
      gemini: { ...g, hasKey: secrets.has('gemini') },
      openai: { ...oa, hasKey: secrets.has('openai') },
      ollama: o,
      huggingface: h,
    };
  });
  ipcMain.handle('accounts:setKey', async (_e, provider, key) => {
    if (!['anthropic', 'gemini', 'openai', 'huggingface'].includes(provider)) throw new Error('Unknown provider');
    secrets.set(provider, key?.trim() || null);
    if (provider === 'huggingface') return hfAccount.status();
    providers[provider].forget();
    return providers[provider].status();
  });
  ipcMain.handle('accounts:open', (_e, url) => {
    if (/^https:\/\/(console\.anthropic\.com|platform\.claude\.com|claude\.com|developers\.openai\.com|github\.com|geminicli\.com|antigravity\.google|aistudio\.google\.com|platform\.openai\.com|huggingface\.co|ollama\.com)\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('accounts:ollamaSignin', async () => {
    const url = await ollamaAccount.signinUrl();
    if (!/^https:\/\/ollama\.com\//.test(url)) throw new Error('Unexpected sign-in link');
    shell.openExternal(url);
    return url;
  });
  ipcMain.handle('accounts:ollamaSignout', () => ollamaAccount.signout());
  const CLI_PROVIDERS = ['claudecode', 'codexcli', 'geminicli', 'antigravity'];
  // Sign-in runs in an in-app terminal session; returns that session.
  ipcMain.handle('accounts:cliLogin', (_e, id, size) => {
    if (!CLI_PROVIDERS.includes(id)) throw new Error('Unknown CLI');
    const spec = providers[id].login();
    return { ...ptys.create(spec, (ch, p) => win?.webContents.send(ch, p), size), hint: spec.hint };
  });
  ipcMain.handle('accounts:cliStatus', (_e, id) => {
    if (!CLI_PROVIDERS.includes(id)) throw new Error('Unknown CLI');
    providers[id].forget();
    return providers[id].status();
  });
  ipcMain.handle('accounts:cliLogout', (_e, id) => {
    if (!CLI_PROVIDERS.includes(id)) throw new Error('Unknown CLI');
    return providers[id].logout();
  });
  ipcMain.handle('accounts:testHfSsh', async () => {
    const r = await hfAccount.testSshKey();
    // Warn if the key is linked to a different account than the saved token.
    const st = await hfAccount.status().catch(() => ({}));
    if (r.linked && st.name && st.name.toLowerCase() !== r.user.toLowerCase()) r.otherAccount = st.name;
    return r;
  });
  ipcMain.handle('accounts:copySshKey', () => {
    const key = hfAccount.sshKey();
    if (!key) throw new Error("Ollama's key wasn't found (~/.ollama/id_ed25519.pub). Start Ollama once to create it.");
    clipboard.writeText(key);
    shell.openExternal('https://huggingface.co/settings/keys/add?type=ssh');
    return true;
  });

  // Git
  const gitRepo = async (repo) => {
    // Only operate on repositories the user is tracking.
    if (!getSettings().gitRepos.includes(repo)) throw new Error('Repository is not tracked');
    return repo;
  };
  const progress = (repo, op) => (line) => win.webContents.send('git:progress', { repo, op, line });
  ipcMain.handle('git:repos', async () => {
    const s = getSettings();
    const repos = await Promise.all(s.gitRepos.map(async (p) => ({ path: p, name: path.basename(p), exists: fs.existsSync(p) })));
    return { repos, active: s.gitActive };
  });
  ipcMain.handle('git:add', async (_e, dir) => {
    const top = await gitOps.toplevel(dir);
    if (!top) throw new Error(`${dir} is not inside a git repository`);
    const s = getSettings();
    if (!s.gitRepos.includes(top)) setSettings({ gitRepos: [...s.gitRepos, top] });
    setSettings({ gitActive: top });
    return top;
  });
  ipcMain.handle('git:remove', (_e, repo) => {
    const s = getSettings();
    setSettings({ gitRepos: s.gitRepos.filter((r) => r !== repo), gitActive: s.gitActive === repo ? s.gitRepos.find((r) => r !== repo) || '' : s.gitActive });
  });
  ipcMain.handle('git:setActive', (_e, repo) => setSettings({ gitActive: repo }));
  ipcMain.handle('git:scan', async () => {
    const s = getSettings();
    const found = await gitOps.scan(s.workspaceDir);
    const tops = (await Promise.all(found.map((d) => gitOps.toplevel(d)))).filter(Boolean);
    const merged = [...new Set([...s.gitRepos, ...tops])];
    setSettings({ gitRepos: merged, gitActive: s.gitActive || merged[0] || '' });
    return tops.length;
  });
  ipcMain.handle('git:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: getSettings().workspaceDir });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('git:clone', async (_e, url) => {
    const dest = await gitOps.clone(url, getSettings().workspaceDir, progress(url, 'clone'));
    const s = getSettings();
    setSettings({ gitRepos: [...s.gitRepos, dest], gitActive: dest });
    return dest;
  });
  ipcMain.handle('git:init', async (_e, dir) => {
    await gitOps.init(dir);
    const s = getSettings();
    setSettings({ gitRepos: [...new Set([...s.gitRepos, path.normalize(dir)])], gitActive: path.normalize(dir) });
    return dir;
  });
  ipcMain.handle('git:detect', (_e, dir) => gitOps.toplevel(dir));
  ipcMain.handle('git:info', async (_e, repo) => gitOps.info(await gitRepo(repo)));
  ipcMain.handle('git:diff', async (_e, repo, file, opts) => gitOps.diff(await gitRepo(repo), file, opts));
  ipcMain.handle('git:stage', async (_e, repo, files) => gitOps.stage(await gitRepo(repo), files));
  ipcMain.handle('git:stageAll', async (_e, repo) => gitOps.stageAll(await gitRepo(repo)));
  ipcMain.handle('git:unstage', async (_e, repo, files) => gitOps.unstage(await gitRepo(repo), files));
  ipcMain.handle('git:discard', async (_e, repo, files) => gitOps.discard(await gitRepo(repo), files));
  ipcMain.handle('git:commit', async (_e, repo, msg, amend) => gitOps.commit(await gitRepo(repo), msg, amend));
  ipcMain.handle('git:log', async (_e, repo) => gitOps.log(await gitRepo(repo)));
  ipcMain.handle('git:show', async (_e, repo, hash) => gitOps.show(await gitRepo(repo), hash));
  ipcMain.handle('git:branches', async (_e, repo) => gitOps.branches(await gitRepo(repo)));
  ipcMain.handle('git:switch', async (_e, repo, name, create) => gitOps.switchBranch(await gitRepo(repo), name, create));
  for (const op of ['fetch', 'pull', 'push']) {
    ipcMain.handle(`git:${op}`, async (_e, repo) => {
      const r = await gitOps[op](await gitRepo(repo), progress(repo, op));
      if (op !== 'fetch') repoKnowledge.check(repo); // pushed or pulled: refresh the fact sheet
      return r;
    });
  }
  ipcMain.handle('git:openFolder', async (_e, repo) => shell.openPath(await gitRepo(repo)));

  // Repo knowledge (code graph + fact sheet)
  ipcMain.handle('repo:status', (_e, repo) => repoKnowledge.status(repo));
  ipcMain.handle('repo:facts', (_e, repo) => repoKnowledge.facts(repo));
  ipcMain.handle('repo:reindex', (_e, repo) => repoKnowledge.reindex(repo, 'manual'));

  // TRACE plugin for Claude Code / Codex
  ipcMain.handle('trace:status', async () => {
    const out = {};
    for (const id of ['claudecode', 'codexcli', 'antigravity']) {
      const st = await providers[id].status().catch(() => ({}));
      out[id] = st.installed ? await providers[id].ensurePlugin({ checkOnly: true }).catch((e) => ({ ok: false, error: e.message })) : { ok: false, error: 'not installed' };
    }
    return out;
  });
  ipcMain.handle('trace:update', async () => {
    const out = {};
    for (const id of ['claudecode', 'codexcli', 'antigravity']) out[id] = await ensureTrace(providers[id], { update: true });
    setSettings({ traceUpdatedAt: Date.now() });
    return out;
  });

  // Dependency setup
  ipcMain.handle('setup:check', () => setup.check());
  ipcMain.handle('setup:install', async (_e, id) => {
    await setup.install(id, (line) => win.webContents.send('setup:progress', { id, line }));
    // Newly installed CLIs/Ollama: re-detect them.
    for (const p of Object.values(providers)) p.forget?.();
  });

  // Recommendations: AI ranking of rule-filtered candidates
  ipcMain.handle('recommend:ai', (_e, req) => aiPick(req));

  // Library
  ipcMain.handle('models:list', async () => {
    const list = await listAll(readJson(notesFile(), {}));
    for (const m of list) modelEfforts.set(m.id, m.efforts || []);
    return list;
  });
  ipcMain.handle('models:catalog', () => catalog.CATALOG);
  ipcMain.handle('models:setNote', (_e, id, text) => {
    const notes = readJson(notesFile(), {});
    if (text == null) delete notes[id];
    else notes[id] = text;
    writeJson(notesFile(), notes);
  });
  ipcMain.handle('models:delete', (_e, name) => ollama.remove(name));
  const pulls = new Map(); // name -> { ctrl, queued }
  const pullQueue = [];
  let activePull = null;

  async function drainPullQueue() {
    if (activePull || !pullQueue.length) return;
    const job = pullQueue.shift();
    if (!job || job.ctrl.signal.aborted) {
      drainPullQueue();
      return;
    }
    activePull = job.name;
    job.entry.queued = false;
    try {
      await ollama.pull(job.name, (p) => win?.webContents.send('pull:progress', { name: job.name, ...p }), job.ctrl.signal);
      win?.webContents.send('pull:progress', { name: job.name, status: 'success', done: true });
    } catch (e) {
      win?.webContents.send('pull:progress', {
        name: job.name,
        status: job.ctrl.signal.aborted ? 'cancelled' : e.message,
        done: true,
        error: true,
      });
    } finally {
      pulls.delete(job.name);
      activePull = null;
      drainPullQueue();
    }
  }

  ipcMain.handle('models:pull', async (_e, name) => {
    if (pulls.has(name)) return;
    const ctrl = new AbortController();
    const entry = { ctrl, queued: Boolean(activePull) };
    pulls.set(name, entry);
    pullQueue.push({ name, ctrl, entry });
    if (activePull) {
      win?.webContents.send('pull:progress', { name, status: `Queued (waiting for ${activePull})…`, queued: true });
    } else {
      win?.webContents.send('pull:progress', { name, status: 'Connecting to Ollama…' });
    }
    drainPullQueue();
  });
  ipcMain.handle('models:cancelPull', (_e, name) => {
    const entry = pulls.get(name);
    if (!entry) return;
    entry.ctrl.abort();
    const idx = pullQueue.findIndex((j) => j.name === name);
    if (idx !== -1) {
      pullQueue.splice(idx, 1);
      pulls.delete(name);
      win?.webContents.send('pull:progress', { name, status: 'cancelled', done: true, error: true });
    }
  });
  ipcMain.handle('models:importFile', async (_e, file, name) => {
    if (pulls.has(name)) return;
    const ctrl = new AbortController();
    pulls.set(name, { ctrl, queued: false });
    const progress = (p) => win?.webContents.send('pull:progress', { name, ...p });
    try {
      await discover.importGguf(file, name, progress, ctrl.signal);
      progress({ status: 'success', done: true });
    } catch (e) {
      progress({ status: ctrl.signal.aborted ? 'cancelled' : e.message, done: true, error: true });
    } finally {
      pulls.delete(name);
    }
  });

  // Discover
  ipcMain.handle('discover:ollamaSearch', (_e, opts) => discover.ollamaSearch(opts));
  ipcMain.handle('discover:ollamaTags', (_e, name) => discover.ollamaTags(name));
  ipcMain.handle('discover:hfSearch', (_e, q) => discover.hfSearch(q));
  ipcMain.handle('discover:hfFiles', (_e, repo) => discover.hfFiles(repo));
  ipcMain.handle('discover:open', (_e, url) => {
    if (/^https:\/\/(ollama\.com|huggingface\.co)\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('system:info', () => discover.systemInfo());
  ipcMain.handle('models:unload', (_e, name) => ollama.unload(name));

  // Chats
  ipcMain.handle('chats:list', () => listAllChatsMeta());
  ipcMain.handle('chats:get', (_e, id) => loadChat(id));
  ipcMain.handle('chats:create', (_e, model) => {
    const chat = { id: crypto.randomUUID(), title: 'New chat', model, cwd: terminal?.workingDir || getSettings().workspaceDir, createdAt: Date.now(), messages: [] };
    saveChat(chat);
    return chat;
  });
  ipcMain.handle('chats:delete', (_e, id) => fs.rmSync(chatFile(id), { force: true }));
  ipcMain.handle('chats:rename', (_e, id, title) => {
    const chat = loadChat(id);
    chat.title = title;
    saveChat(chat);
  });
  ipcMain.handle('chat:send', (_e, { chatId, model, text, useTools, effort }) => {
    runChat(chatId, model, text, useTools, effort); // streams via chat:event
  });
  ipcMain.handle('chat:stop', (_e, chatId) => active.get(chatId)?.abort());
  ipcMain.handle('chat:compactAnalyze', (_e, chatId, modelId) => compact.analyze(loadChat(chatId), modelId, getSettings()));
  ipcMain.handle('chat:compactApply', (_e, chatId, sections) => {
    if (active.has(chatId)) throw new Error('Wait for the current answer to finish');
    const chat = loadChat(chatId);
    const r = compact.apply(chat, sections);
    saveChat(chat);
    return { chat, ...r };
  });
  ipcMain.handle('chat:compactUndo', (_e, chatId) => {
    const chat = loadChat(chatId);
    compact.undo(chat);
    saveChat(chat);
    return chat;
  });
  ipcMain.handle('approval:respond', (_e, id, answer) => {
    const p = pendingApprovals.get(id);
    if (p) {
      pendingApprovals.delete(id);
      p.resolve(answer);
    }
  });

  // Merger Agent & Tester Agent
  ipcMain.handle('agents:runMerger', async (_e, opts) => {
    try {
      const { report, triggered } = await executeMerger(opts);
      return { ok: true, ...report, report, triggered };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('agents:runTester', async (_e, opts) => {
    try {
      const { report, triggered } = await executeTester(opts);
      return { ok: true, ...report, report, triggered };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('agents:sendReport', (_e, { chatId, report }) => {
    const chat = loadChat(chatId);
    if (!chat || !chat.model || active.has(chatId)) return false;
    if (report.repo && fs.existsSync(report.repo)) terminal.cwd = report.repo;
    const prompt = formatAgentReportPrompt(report);
    runChat(chatId, chat.model, prompt, true, chat.effort || '', { isAgentReport: true });
    return true;
  });

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, s) => setSettings(s));
  ipcMain.handle('settings:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'GGUF model', extensions: ['gguf'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: getSettings().workspaceDir });
    return r.canceled ? null : r.filePaths[0];
  });

  // Interactive terminal sessions (real shell via ConPTY)
  ipcMain.handle('pty:create', (_e, size) =>
    ptys.create({ title: 'PowerShell', kind: 'shell', cwd: terminal.workingDir }, (ch, p) => win?.webContents.send(ch, p), size)
  );
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.handle('pty:kill', (_e, id) => ptys.kill(id));

  // Terminal (user-typed commands run without approval: the user is the one asking)
  ipcMain.handle('terminal:run', (_e, command) => terminal.run(command, { source: 'user' }));
  ipcMain.handle('terminal:kill', (_e, runId) => terminal.kill(runId));
  ipcMain.handle('terminal:cwd', () => terminal.workingDir);
  ipcMain.handle('terminal:setCwd', (_e, dir) => {
    if (dir && fs.existsSync(dir)) {
      terminal.cwd = dir;
      win?.webContents.send('terminal:event', { type: 'cwd', cwd: terminal.workingDir });
    }
    return terminal.workingDir;
  });

  // Shared browser
  ipcMain.on('browser:bounds', (_e, b) => browser.setBounds(b));
  ipcMain.on('browser:visible', (_e, v) => browser.setVisible(v));
  ipcMain.handle('browser:navigate', (_e, url) => browser.navigate(url));
  ipcMain.handle('browser:back', () => browser.wc.navigationHistory.goBack());
  ipcMain.handle('browser:forward', () => browser.wc.navigationHistory.goForward());
  ipcMain.handle('browser:reload', () => browser.wc.reload());
  ipcMain.handle('browser:external', () => shell.openExternal(browser.wc.getURL()));

  // Android
  ipcMain.handle('android:info', () => android.info());
  ipcMain.handle('android:avds', () => android.listAvds());
  ipcMain.handle('android:start', (_e, avd, headless) => android.start(avd, headless));
  ipcMain.handle('android:devices', () => android.devices());
  ipcMain.handle('android:stop', (_e, serial) => android.stop(serial));
  ipcMain.handle('android:frame', (_e, serial) => android.frame(serial));
  ipcMain.on('android:input', (_e, serial, ev) => android.input(serial, ev));
}

// ---------- app ----------

function createWindow() {
  const isLight = getSettings().theme === 'light';
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: isLight ? '#f4f5f8' : '#090b10',
    title: 'Model Hub',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isLight ? '#eef0f6' : '#090b10',
      symbolColor: isLight ? '#334155' : '#94a3b8',
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  browser = new SharedBrowser(win);
  terminal = new Terminal((ch, payload) => win?.webContents.send(ch, payload), getSettings);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = getSettings().theme;
  await setup.refreshPath(); // pick up tools installed since Windows started this process
  registerIpc();
  createWindow();
  repoKnowledge.start();
  // Keep TRACE current for the installed CLIs (daily).
  const s = getSettings();
  if (s.tracePlugin && Date.now() - (s.traceUpdatedAt || 0) > 24 * 3600e3) {
    setTimeout(async () => {
      for (const id of ['claudecode', 'codexcli', 'antigravity']) {
        const st = await providers[id].status().catch(() => ({}));
        if (st.installed) await ensureTrace(providers[id], { update: true });
      }
      setSettings({ traceUpdatedAt: Date.now() });
    }, 15000);
  }
});
app.on('window-all-closed', () => {
  android.shutdown();
  terminal?.killAll();
  ptys.killAll();
  repoKnowledge.stop();
  app.quit();
});
