// Specialized workflow agents:
// 1. Merger Agent: uses a model of the user's choice to check/merge task branches
//    into main (or base branch). If conflicts exist, it generates a detailed conflict
//    resolution report and sends it back to the agent that worked on the branch.
// 2. Tester Agent: uses a model of the user's choice to run and evaluate tests/checks
//    after an agent modifies code, and sends a failure report back to the working
//    agent if tests or checks fail.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parse } = require('./providers');
const gitOps = require('./git');

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  LC_ALL: 'C',
};

function runGit(repo, args, { allowCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repo, env: ENV, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const out = (stdout || '').toString();
      const errOut = (stderr || '').toString();
      if (!allowCodes.includes(code)) {
        reject(new Error((errOut || out || err?.message || `git ${args[0]} failed`).trim()));
      } else {
        resolve({ code, stdout: out, stderr: errOut });
      }
    });
  });
}

function runShellCommand(cwd, command, timeoutMs = 600000, onLine) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
    const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
    const child = spawn(shell, args, { cwd, env: { ...process.env, CI: 'true' }, windowsHide: true });
    let output = '';
    let lineBuf = '';
    let timedOut = false;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);

    const onData = (d) => {
      const str = d.toString();
      if (output.length < 96000) output += str;
      else output = output.slice(-64000) + str;
      if (onLine) {
        lineBuf += str;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() || '';
        for (const l of lines) {
          const clean = l.trim();
          if (clean) onLine(clean);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: output + `\n${err.message}`, timedOut, durationMs: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : code ?? 1, output: output.trim(), timedOut, durationMs: Date.now() - t0 });
    });
  });
}

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}

async function detectBaseBranch(repo, preferred) {
  const branches = await gitOps.branches(repo).catch(() => []);
  const localNames = branches.filter((b) => !b.remote).map((b) => b.name);
  if (preferred && localNames.includes(preferred)) return preferred;
  for (const cand of ['main', 'master', 'develop', 'trunk']) {
    if (localNames.includes(cand)) return cand;
  }
  return localNames[0] || 'main';
}

// Checks whether `sourceBranch` can merge cleanly into `targetBranch` without touching the working tree.
async function checkBranchMerge(repo, targetBranch, sourceBranch) {
  // First check if sourceBranch has any commits ahead of targetBranch
  const aheadRes = await runGit(repo, ['rev-list', '--count', `${targetBranch}..${sourceBranch}`], { allowCodes: [0, 128] }).catch(() => ({ stdout: '0' }));
  const aheadCount = parseInt(aheadRes.stdout.trim(), 10) || 0;

  // Try modern `git merge-tree --write-tree` (Git 2.38+)
  const mt = await runGit(repo, ['merge-tree', '--write-tree', targetBranch, sourceBranch], { allowCodes: [0, 1] }).catch(() => null);
  if (mt) {
    const hasConflict = mt.code !== 0 || /CONFLICT/i.test(mt.stdout) || /CONFLICT/i.test(mt.stderr);
    const conflictLines = `${mt.stdout}\n${mt.stderr}`
      .split(/\r?\n/)
      .filter((l) => /CONFLICT|Auto-merging/i.test(l));
    const conflictFiles = [];
    for (const line of conflictLines) {
      const m = line.match(/Merge conflict in (.+)$/i) || line.match(/CONFLICT \([^)]+\): .* in (.+)$/i);
      if (m && m[1] && !conflictFiles.includes(m[1].trim())) conflictFiles.push(m[1].trim());
    }
    return {
      clean: !hasConflict,
      aheadCount,
      conflictFiles,
      rawOutput: `${mt.stdout}\n${mt.stderr}`.trim(),
    };
  }

  // Fallback for older Git: 3-way merge-tree with merge-base
  const mb = await runGit(repo, ['merge-base', targetBranch, sourceBranch], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }));
  const base = mb.stdout.trim();
  if (!base) {
    return { clean: true, aheadCount, conflictFiles: [], rawOutput: '' };
  }
  const oldMt = await runGit(repo, ['merge-tree', base, targetBranch, sourceBranch], { allowCodes: [0, 1] });
  const hasConflict = /^\+<<<<<<< /m.test(oldMt.stdout);
  return {
    clean: !hasConflict,
    aheadCount,
    conflictFiles: [],
    rawOutput: oldMt.stdout.slice(0, 12000),
  };
}

const MERGER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['clean', 'merged', 'conflict', 'dirty'] },
    summary: { type: 'string' },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          cause: { type: 'string' },
          resolution: { type: 'string' },
        },
        required: ['file', 'cause', 'resolution'],
      },
    },
    instructions_for_agent: { type: 'string' },
  },
  required: ['status', 'summary', 'instructions_for_agent'],
};

const MERGER_SYSTEM = `You are the Merger Agent in Model Hub.
Your job is to coordinate work across branches/tasks in a Git repository, verify that task branches merge cleanly into the main branch, and when conflicts or integration issues occur, write a clear, actionable Conflict & Integration Report for the coding agent that worked on the task.

Be concrete:
- Name exact file paths, conflicting symbols/lines, and what changed on the base branch vs the task branch.
- In "instructions_for_agent", write direct, step-by-step instructions that the working agent can execute immediately to resolve the conflicts or uncommitted overlaps without losing changes from either side.
Respond with JSON only matching the schema.`;

/**
 * Runs the Merger Agent on `repo`.
 * - Checks all active task branches (or `sourceBranch`) against `targetBranch` (e.g. `main`).
 * - If `performMerge` is true and the merge is clean, merges into `targetBranch`.
 * - Uses the user's chosen `modelId` to analyze any conflicts or multi-branch interactions.
 */
async function runMergerAgent({
  repo,
  sourceBranch,
  targetBranch,
  performMerge = false,
  modelId,
  chats = [],
  onProgress,
}) {
  const top = await gitOps.toplevel(repo);
  if (!top) throw new Error(`${repo} is not inside a Git repository.`);

  const base = await detectBaseBranch(top, targetBranch);
  const st = await gitOps.status(top);
  const currentBranch = st.branch;
  const allBranches = await gitOps.branches(top);
  const localBranches = allBranches.filter((b) => !b.remote).map((b) => b.name);

  // Determine which branches to evaluate
  let branchesToCheck = [];
  if (sourceBranch && sourceBranch !== base && localBranches.includes(sourceBranch)) {
    branchesToCheck = [sourceBranch];
  } else if (currentBranch && currentBranch !== base && !st.detached) {
    branchesToCheck = [currentBranch];
  } else {
    // Check all local task branches that have commits ahead of `base`
    for (const b of localBranches) {
      if (b === base) continue;
      const ahead = await runGit(top, ['rev-list', '--count', `${base}..${b}`], { allowCodes: [0, 128] }).catch(() => ({ stdout: '0' }));
      if ((parseInt(ahead.stdout.trim(), 10) || 0) > 0) branchesToCheck.push(b);
    }
  }

  onProgress?.({ stage: 'checking', text: `Checking ${branchesToCheck.length ? branchesToCheck.join(', ') : currentBranch || base} against ${base}…` });

  const results = [];
  for (const br of branchesToCheck) {
    const check = await checkBranchMerge(top, base, br);
    const diffStat = (await runGit(top, ['diff', '--stat', `${base}...${br}`], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.trim();
    const baseLog = (await runGit(top, ['log', '--oneline', '-n', '8', `${br}..${base}`], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.trim();
    const branchLog = (await runGit(top, ['log', '--oneline', '-n', '8', `${base}..${br}`], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.trim();
    const fileDiffs = !check.clean
      ? (await runGit(top, ['diff', `${base}...${br}`, '--', ...check.conflictFiles.slice(0, 6)], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.slice(0, 10000)
      : '';

    // Find which chat worked on this branch
    const ownerChat = chats.find((c) => c.repo === top && c.branch === br) || chats.find((c) => c.cwd && path.normalize(c.cwd).startsWith(top));

    let merged = false;
    let mergeError = '';
    if (performMerge && check.clean && check.aheadCount > 0) {
      if (st.files.length > 0) {
        mergeError = `Merge is clean, but working tree has ${st.files.length} uncommitted file(s). Commit or stash first before merging into ${base}.`;
      } else {
        try {
          onProgress?.({ stage: 'merging', text: `Merging ${br} into ${base}…` });
          const prevBranch = currentBranch;
          if (currentBranch !== base) await gitOps.switchBranch(top, base, false);
          await runGit(top, ['merge', '--no-edit', br]);
          merged = true;
          if (prevBranch && prevBranch !== base) await gitOps.switchBranch(top, prevBranch, false).catch(() => {});
        } catch (e) {
          await runGit(top, ['merge', '--abort'], { allowCodes: [0, 1, 128] }).catch(() => {});
          mergeError = e.message;
        }
      }
    }

    const branchVerdict = merged ? 'merged' : check.clean && !mergeError ? 'clean' : 'conflict';
    results.push({
      agent: 'merger',
      branch: br,
      targetBranch: base,
      verdict: branchVerdict,
      status: branchVerdict,
      clean: check.clean && !mergeError,
      merged,
      mergeError,
      aheadCount: check.aheadCount,
      conflictFiles: check.conflictFiles,
      conflicts: check.conflictFiles.map((f) => ({
        file: f,
        cause: `Conflicting changes between ${br} and ${base}`,
        resolution: `Merge or rebase ${base} into ${br} and resolve conflicts in ${f}.`,
      })),
      summary:
        branchVerdict === 'conflict'
          ? `Branch ${br} has merge conflicts with ${base} in ${check.conflictFiles.join(', ') || 'working tree'}.`
          : branchVerdict === 'merged'
            ? `Branch ${br} merged cleanly into ${base}.`
            : `Branch ${br} merges cleanly with ${base}.`,
      rawOutput: check.rawOutput.slice(0, 8000),
      diffStat,
      baseLog,
      branchLog,
      fileDiffs,
      ownerChatId: ownerChat?.id || null,
      ownerChatTitle: ownerChat?.title || null,
    });
  }

  // If the user is on `base` (e.g. `main`) with no separate task branches, check uncommitted / working tree state or recent commits
  if (!results.length) {
    const uncommittedDiff = (await runGit(top, ['diff', '--stat', 'HEAD'], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.trim();
    const conflictEntries = st.files.filter((f) => f.conflict);
    const isClean = conflictEntries.length === 0;
    results.push({
      agent: 'merger',
      branch: currentBranch || base,
      targetBranch: base,
      verdict: isClean ? 'clean' : 'conflict',
      status: isClean ? 'clean' : 'conflict',
      clean: isClean,
      merged: false,
      mergeError: '',
      aheadCount: st.ahead || 0,
      conflictFiles: conflictEntries.map((f) => f.path),
      conflicts: conflictEntries.map((f) => ({
        file: f.path,
        cause: 'Unresolved conflict in working tree',
        resolution: `Resolve conflict markers in ${f.path}.`,
      })),
      summary: isClean ? `On ${base}; no conflicting task branches found.` : `Unresolved conflicts in ${conflictEntries.map((f) => f.path).join(', ')}.`,
      rawOutput: uncommittedDiff || 'On base branch; no separate unmerged task branches found.',
      diffStat: uncommittedDiff,
      baseLog: '',
      branchLog: '',
      fileDiffs: '',
      ownerChatId: null,
      ownerChatTitle: null,
    });
  }

  const hasAnyConflict = results.some((r) => !r.clean || r.conflictFiles.length > 0);
  const allMerged = results.some((r) => r.merged);

  // Use the user's chosen model to analyze when conflicts exist or to summarize multi-branch merges
  let aiReport = null;
  if (modelId) {
    try {
      onProgress?.({ stage: 'analyzing', text: `Merger Agent (${modelId}) is analyzing branch integration…` });
      const { provider, name } = parse(modelId);
      const promptPayload = {
        repository: top,
        base_branch: base,
        current_branch: currentBranch,
        uncommitted_files: st.files.map((f) => `${f.x}${f.y} ${f.path}`).slice(0, 40),
        branch_checks: results,
      };
      const raw = await provider.complete({
        model: name,
        system: MERGER_SYSTEM,
        prompt: `Analyze this repository merge check and produce the Merger Agent report:\n\n${JSON.stringify(promptPayload, null, 2)}`,
        schema: MERGER_SCHEMA,
        numCtx: 16384,
      });
      aiReport = extractJson(raw);
    } catch (e) {
      aiReport = null;
    }
  }

  const status = hasAnyConflict ? 'conflict' : allMerged ? 'merged' : 'clean';
  const fallbackConflicts = results.flatMap((r) =>
    r.conflictFiles.map((f) => ({
      file: f,
      cause: `Conflicting edits between branch "${r.branch}" and "${base}"`,
      resolution: `Merge or rebase "${base}" into "${r.branch}" and reconcile changes in ${f}.`,
    }))
  );
  const summary =
    aiReport?.summary ||
    (hasAnyConflict
      ? `Merge conflicts detected with ${base} in: ${results.flatMap((r) => r.conflictFiles).join(', ') || 'checked branches'}.`
      : allMerged
        ? `Successfully merged ${results.filter((r) => r.merged).map((r) => r.branch).join(', ')} into ${base}.`
        : `All checked branches (${results.map((r) => r.branch).join(', ')}) merge cleanly with ${base}.`);

  return {
    agent: 'merger',
    repo: top,
    branch: results.map((r) => r.branch).join(', ') || currentBranch || base,
    targetBranch: base,
    baseBranch: base,
    currentBranch,
    model: modelId,
    status,
    verdict: status,
    summary,
    conflicts: aiReport?.conflicts?.length ? aiReport.conflicts : fallbackConflicts,
    instructionsForAgent:
      aiReport?.instructions_for_agent ||
      (hasAnyConflict
        ? `Rebase or merge ${base} into your branch (${results.map((r) => r.branch).join(', ')}) and resolve conflicts in: ${results.flatMap((r) => r.conflictFiles).join(', ')}.`
        : ''),
    results,
    at: Date.now(),
  };
}

// ---------------- Tester Agent ----------------

const TESTER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'warn'] },
    summary: { type: 'string' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          test_or_file: { type: 'string' },
          root_cause: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['test_or_file', 'root_cause', 'suggested_fix'],
      },
    },
    instructions_for_agent: { type: 'string' },
  },
  required: ['verdict', 'summary', 'instructions_for_agent'],
};

const TESTER_SYSTEM = `You are the Tester Agent in Model Hub.
Your job is to verify recent code changes in the repository by inspecting the test/check command output and git diff, and if anything failed or broke, write a clear, actionable Test Failure Report for the coding agent that made the changes.

Be concrete:
- Identify exact failing tests, syntax/type errors, file paths, and line numbers.
- Explain why the failure happened based on the recent diff and test output.
- In "instructions_for_agent", give direct instructions the working agent can follow immediately to fix the failure and re-verify.
Respond with JSON only matching the schema.`;

const gradleTasksCache = new Map(); // dir -> { at, tasks: string[] }

function readTextSafe(p, maxLen = 64000) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, 'utf8').slice(0, maxLen);
    }
  } catch {}
  return '';
}

function listFilesInDir(dir, extRegex) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (!extRegex || extRegex.test(e.name)))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function resolveGradleBin(dir) {
  if (process.platform === 'win32') {
    if (fs.existsSync(path.join(dir, 'gradlew.bat'))) return '.\\gradlew.bat';
    return 'gradle';
  }
  if (fs.existsSync(path.join(dir, 'gradlew'))) return './gradlew';
  return 'gradle';
}

// Normalizes a raw gradle command from CI or user input (e.g. `./gradlew test`, `gradle .\test`, `gradle .\integrationTests`)
function normalizeGradleCommand(dir, rawCmd) {
  const bin = resolveGradleBin(dir);
  let cmd = rawCmd.trim().replace(/^(\.\/|\.\\)?gradlew(\.bat)?\b/i, bin).replace(/^gradle\b/i, bin);
  // Convert `gradle .\test` or `gradle ./integrationTests` into `<gradleBin> test` unless a local script file literally exists
  cmd = cmd.replace(/(\s)(\.\\|\.\/)([A-Za-z0-9_:-]+)\b/g, (full, sp, prefix, taskName) => {
    if (fs.existsSync(path.join(dir, taskName)) && fs.statSync(path.join(dir, taskName)).isFile()) return full;
    return `${sp}${taskName}`;
  });
  return cmd;
}

// Reads CI configuration files (.gitlab-ci.yml, local/sibling included templates, GitHub workflows, Jenkinsfile, etc.)
function gatherCiConfigTexts(dir) {
  const sources = [];
  const addFile = (filePath, label) => {
    const content = readTextSafe(filePath);
    if (content) sources.push({ label: label || path.relative(dir, filePath) || path.basename(filePath), filePath, content });
  };

  addFile(path.join(dir, '.gitlab-ci.yml'), '.gitlab-ci.yml');
  for (const f of listFilesInDir(path.join(dir, '.gitlab'), /\.ya?ml$/i)) addFile(f);
  for (const f of listFilesInDir(path.join(dir, 'ci'), /\.ya?ml$/i)) addFile(f);
  for (const f of listFilesInDir(path.join(dir, '.github', 'workflows'), /\.ya?ml$/i)) addFile(f);
  addFile(path.join(dir, 'Jenkinsfile'), 'Jenkinsfile');
  addFile(path.join(dir, 'azure-pipelines.yml'), 'azure-pipelines.yml');
  addFile(path.join(dir, 'bitbucket-pipelines.yml'), 'bitbucket-pipelines.yml');

  // Follow local or sibling `include:` references in .gitlab-ci.yml if present on disk
  const gitlabMain = sources.find((s) => s.label === '.gitlab-ci.yml');
  if (gitlabMain) {
    const parentDir = path.dirname(dir);
    const fileRefs = [...gitlabMain.content.matchAll(/(?:local|file)\s*:\s*['"]?([^\s'"#]+)['"]?/g)].map((m) => m[1]);
    const projRefs = [...gitlabMain.content.matchAll(/project\s*:\s*['"]?([^\s'"#]+)['"]?/g)].map((m) => m[1]);
    for (const ref of fileRefs) {
      const cleanRef = ref.replace(/^\/+/, '');
      addFile(path.join(dir, cleanRef), `include:${cleanRef}`);
      // Also check sibling repos in parent workspace if `project:` was referenced
      for (const proj of projRefs) {
        const repoBase = proj.split('/').pop();
        if (repoBase) addFile(path.join(parentDir, repoBase, cleanRef), `template:${repoBase}/${cleanRef}`);
      }
      // Or any sibling `*ci*` / `*template*` folder in parent workspace
      try {
        for (const sib of fs.readdirSync(parentDir, { withFileTypes: true })) {
          if (sib.isDirectory() && /ci|template|pipeline/i.test(sib.name)) {
            addFile(path.join(parentDir, sib.name, cleanRef), `template:${sib.name}/${cleanRef}`);
          }
        }
      } catch {}
    }
  }
  return sources;
}

// Extracts explicit test commands from CI YAML / Jenkinsfile scripts
function extractExplicitCiCommands(dir, ciSources) {
  const steps = [];
  const seen = new Set();
  const isGradleRepo =
    fs.existsSync(path.join(dir, 'build.gradle')) ||
    fs.existsSync(path.join(dir, 'build.gradle.kts')) ||
    fs.existsSync(path.join(dir, 'settings.gradle')) ||
    fs.existsSync(path.join(dir, 'settings.gradle.kts')) ||
    fs.existsSync(path.join(dir, 'gradlew')) ||
    fs.existsSync(path.join(dir, 'gradlew.bat'));

  for (const src of ciSources) {
    const lines = src.content.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Match YAML list items (`- ./gradlew test`), `run: ...`, `sh '...'`, `bat '...'`
      const m =
        trimmed.match(/^-\s+['"]?(.+?)['"]?$/) ||
        trimmed.match(/^run\s*:\s*['"]?(.+?)['"]?$/) ||
        trimmed.match(/^(?:sh|bat|powershell)\s*\(?['"](.+?)['"]\)?$/);
      if (!m) continue;
      let cmd = m[1].trim();
      if (!cmd || /^[|$><{}]/.test(cmd)) continue;
      // Skip non-test lifecycle commands (deploy, publish, docker push, sonar, release, artifact upload)
      if (/\b(deploy|publish|artifactoryPublish|MavenPublication|sonarqube|sonar|docker\s+push|docker\s+build|release|pages|SpotlessApply)\b/i.test(cmd)) {
        continue;
      }
      // Check if this is a test/check command
      if (/\b(gradlew?|mvnw?|npm|pnpm|yarn|pytest|cargo|go\s+test|dotnet\s+test)\b/i.test(cmd)) {
        if (/\b(test|integrationTest|integrationTests|scenarioTest|scenariotests|scenarioTests|functionalTest|e2eTest|check|verify|typecheck|lint)\b/i.test(cmd)) {
          // Strip CI-only env vars or flags that break local runs
          if (/\bgradlew?\b/i.test(cmd) && isGradleRepo) {
            cmd = normalizeGradleCommand(dir, cmd);
          }
          const key = cmd.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            steps.push({
              label: `CI (${src.label}): ${cmd}`,
              command: cmd,
              source: src.label,
            });
          }
        }
      }
    }
  }
  return steps;
}

// Discovers all Gradle test suites (unit `test`, `integrationTests`/`integrationTest`, `scenariotests`/`scenarioTest`, etc.)
async function discoverGradleTestSteps(dir, ciSources, onProgress) {
  const gradleBin = resolveGradleBin(dir);
  const texts = [];

  // 1. Root & subproject build.gradle / build.gradle.kts & gradle/*.gradle(.kts)
  for (const f of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
    const t = readTextSafe(path.join(dir, f));
    if (t) texts.push(t);
  }
  for (const f of listFilesInDir(path.join(dir, 'gradle'), /\.gradle(\.kts)?$/i)) {
    const t = readTextSafe(f);
    if (t) texts.push(t);
  }
  const srcSetNames = new Set();
  const collectSrcSets = (baseDir) => {
    const srcDir = path.join(baseDir, 'src');
    try {
      if (fs.existsSync(srcDir)) {
        for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
          if (d.isDirectory()) srcSetNames.add(d.name);
        }
      }
    } catch {}
  };
  collectSrcSets(dir);

  try {
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory() || sub.name.startsWith('.') || sub.name === 'node_modules' || sub.name === 'build') continue;
      const subPath = path.join(dir, sub.name);
      for (const f of ['build.gradle', 'build.gradle.kts']) {
        const t = readTextSafe(path.join(subPath, f));
        if (t) texts.push(t);
      }
      collectSrcSets(subPath);
    }
  } catch {}

  for (const ci of ciSources) texts.push(ci.content);
  const combined = texts.join('\n');

  const hasTaskInTextOrSrc = (candidates) => {
    for (const cand of candidates) {
      if (srcSetNames.has(cand)) return cand;
      const re = new RegExp(`\\b${cand}\\b`);
      if (re.test(combined)) return cand;
    }
    return null;
  };

  let intTask = hasTaskInTextOrSrc(['integrationTests', 'integrationTest', 'intTests', 'intTest', 'itTest']);
  let scenTask = hasTaskInTextOrSrc(['scenariotests', 'scenarioTests', 'scenarioTest', 'scenariosTest']);
  let funcTask = hasTaskInTextOrSrc(['functionalTests', 'functionalTest', 'e2eTests', 'e2eTest']);

  // If neither integration nor scenario tasks were visible statically in build.gradle/src (e.g. provided by a company Gradle convention plugin),
  // query `<gradleBin> tasks --all --console=plain -q` once and cache the task list for this repo!
  if (!intTask && !scenTask) {
    let cached = gradleTasksCache.get(dir);
    if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
      onProgress?.({ stage: 'discovering', text: `Inspecting Gradle tasks (${gradleBin} tasks --all)…` });
      const res = await runShellCommand(dir, `${gradleBin} tasks --all --console=plain -q`, 25000);
      const taskNames = [];
      if (res.exitCode === 0 && res.output) {
        for (const line of res.output.split(/\r?\n/)) {
          const m = line.trim().match(/^(?:[a-zA-Z0-9_-]+:)*([a-zA-Z0-9_-]+)\s*(?:-\s+.*)?$/);
          if (m && m[1]) taskNames.push(m[1]);
        }
      }
      cached = { at: Date.now(), tasks: taskNames };
      gradleTasksCache.set(dir, cached);
    }
    const taskSet = new Set(cached.tasks);
    for (const c of ['integrationTests', 'integrationTest', 'intTests', 'intTest']) {
      if (taskSet.has(c)) {
        intTask = c;
        break;
      }
    }
    for (const c of ['scenariotests', 'scenarioTests', 'scenarioTest']) {
      if (taskSet.has(c)) {
        scenTask = c;
        break;
      }
    }
    for (const c of ['functionalTests', 'functionalTest', 'e2eTests', 'e2eTest']) {
      if (taskSet.has(c)) {
        funcTask = c;
        break;
      }
    }
  }

  const steps = [{ label: 'Unit tests (test)', command: `${gradleBin} test`, source: 'Gradle CI template' }];
  if (intTask) {
    steps.push({ label: `Integration tests (${intTask})`, command: `${gradleBin} ${intTask}`, source: 'Gradle CI template' });
  }
  if (scenTask) {
    steps.push({ label: `Scenario tests (${scenTask})`, command: `${gradleBin} ${scenTask}`, source: 'Gradle CI template' });
  }
  if (funcTask) {
    steps.push({ label: `Functional / E2E tests (${funcTask})`, command: `${gradleBin} ${funcTask}`, source: 'Gradle CI template' });
  }
  return steps;
}

/**
 * Discovers the ordered multi-stage CI test pipeline for `dir`.
 */
async function discoverCiTestPlan(dir, changedFiles = [], customCommand = '', onProgress) {
  const custom = (customCommand || '').trim();
  if (custom) {
    // Support multi-step custom commands separated by `;`, `&&`, or newlines
    const parts = custom
      .split(/\r?\n|;|&&/)
      .map((s) => s.trim())
      .filter(Boolean);
    const isGradleRepo =
      fs.existsSync(path.join(dir, 'build.gradle')) ||
      fs.existsSync(path.join(dir, 'build.gradle.kts')) ||
      fs.existsSync(path.join(dir, 'gradlew.bat')) ||
      fs.existsSync(path.join(dir, 'gradlew'));
    return parts.map((raw, idx) => {
      const cmd = isGradleRepo && /\bgradlew?\b/i.test(raw) ? normalizeGradleCommand(dir, raw) : raw;
      return {
        label: parts.length > 1 ? `Step ${idx + 1}: ${cmd}` : cmd,
        command: cmd,
        source: 'Custom command',
      };
    });
  }

  // 1. Check CI files (.gitlab-ci.yml, included templates, GitHub Actions, Jenkinsfile, etc.)
  const ciSources = gatherCiConfigTexts(dir);
  const explicitCiSteps = extractExplicitCiCommands(dir, ciSources);

  // 2. Gradle repository (build.gradle, build.gradle.kts, settings.gradle, gradlew)
  const isGradle =
    fs.existsSync(path.join(dir, 'build.gradle')) ||
    fs.existsSync(path.join(dir, 'build.gradle.kts')) ||
    fs.existsSync(path.join(dir, 'settings.gradle')) ||
    fs.existsSync(path.join(dir, 'settings.gradle.kts')) ||
    fs.existsSync(path.join(dir, 'gradlew.bat')) ||
    fs.existsSync(path.join(dir, 'gradlew'));

  if (isGradle) {
    const gradleSteps = await discoverGradleTestSteps(dir, ciSources, onProgress);
    if (explicitCiSteps.length > 0) {
      // Merge any extra gradle tasks discovered from the project (e.g. integrationTests / scenariotests from CI template)
      const merged = [...explicitCiSteps];
      for (const gs of gradleSteps) {
        const taskName = gs.command.split(/\s+/).pop();
        const alreadyCovered = merged.some((m) => new RegExp(`\\b${taskName}\\b`, 'i').test(m.command));
        if (!alreadyCovered) merged.push(gs);
      }
      return merged;
    }
    return gradleSteps;
  }

  if (explicitCiSteps.length > 0) {
    return explicitCiSteps;
  }

  // 3. Maven repository (pom.xml)
  if (fs.existsSync(path.join(dir, 'pom.xml'))) {
    const pom = readTextSafe(path.join(dir, 'pom.xml'));
    const mvnBin =
      process.platform === 'win32'
        ? fs.existsSync(path.join(dir, 'mvnw.cmd'))
          ? '.\\mvnw.cmd'
          : 'mvn'
        : fs.existsSync(path.join(dir, 'mvnw'))
          ? './mvnw'
          : 'mvn';
    const steps = [{ label: 'Maven unit tests (test)', command: `${mvnBin} test -B`, source: 'pom.xml' }];
    if (/maven-failsafe-plugin|integration-test/i.test(pom)) {
      steps.push({ label: 'Maven integration tests (verify)', command: `${mvnBin} verify -B`, source: 'pom.xml' });
    }
    return steps;
  }

  // 4. Node.js / TypeScript repository (package.json)
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const s = pkg.scripts || {};
      const steps = [];
      const addScript = (name, label) => {
        if (s[name] && !/no test specified/i.test(s[name])) {
          steps.push({ label: label || `npm run ${name}`, command: name === 'test' ? 'npm test' : `npm run ${name}`, source: 'package.json' });
        }
      };
      addScript('test', 'Unit / main tests (npm test)');
      for (const k of ['test:unit', 'test:integration', 'integrationTest', 'integrationTests', 'test:scenario', 'scenariotests', 'test:e2e']) {
        if (k !== 'test') addScript(k, `Tests (${k})`);
      }
      addScript('typecheck', 'Typecheck');
      if (!s.typecheck) addScript('lint', 'Lint');
      if (steps.length) return steps;
    } catch {}
  }

  // 5. Python / Rust / Go / .NET
  if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini'))) {
    return [{ label: 'Pytest', command: 'pytest -q', source: 'Python project' }];
  }
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
    return [{ label: 'Cargo test', command: 'cargo test --quiet', source: 'Cargo.toml' }];
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) {
    return [{ label: 'Go test', command: 'go test ./...', source: 'go.mod' }];
  }
  if (listFilesInDir(dir, /\.(sln|csproj)$/i).length > 0) {
    return [{ label: '.NET test', command: 'dotnet test --nologo', source: '.NET project' }];
  }

  // 6. Fallback for Node/JS projects without a test script: syntax-check changed .js files
  const jsFiles = changedFiles.filter((f) => /\.(c|m)?js$/i.test(f) && fs.existsSync(path.join(dir, f)));
  if (jsFiles.length) {
    return [
      {
        label: `Syntax check (${jsFiles.length} JS file${jsFiles.length === 1 ? '' : 's'})`,
        command: jsFiles.map((f) => `node --check "${f.replace(/"/g, '')}"`).join(' ; '),
        source: 'JS syntax check',
      },
    ];
  }
  return [];
}

/**
 * Runs the Tester Agent on `cwd` / `repo`.
 * Discovers the CI test pipeline (e.g. `gradle test`, `gradle integrationTests`, `gradle scenariotests`)
 * and executes each stage sequentially (one at a time).
 */
async function runTesterAgent({
  cwd,
  repo,
  customCommand,
  modelId,
  userRequest,
  onProgress,
}) {
  const workDir = repo || (await gitOps.toplevel(cwd)) || cwd;
  const st = await gitOps.status(workDir).catch(() => ({ branch: '', files: [] }));
  const changedFiles = st.files.map((f) => f.path);
  const diffStat = (await runGit(workDir, ['diff', '--stat', 'HEAD'], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.trim();
  const diffPatch = (await runGit(workDir, ['diff', 'HEAD'], { allowCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.slice(0, 10000);

  const plan = await discoverCiTestPlan(workDir, changedFiles, customCommand, onProgress);
  const stepResults = [];
  let overallExitCode = 0;
  let anyTimedOut = false;

  const liveStages = plan.map((s, idx) => ({
    index: idx + 1,
    label: s.label,
    command: s.command,
    status: 'pending', // 'pending' | 'running' | 'pass' | 'fail'
    durationMs: 0,
  }));

  if (plan.length > 0) {
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      liveStages[i].status = 'running';
      const prefix = plan.length > 1 ? `[Step ${i + 1}/${plan.length}] ` : '';
      onProgress?.({
        stage: 'running',
        stepIndex: i + 1,
        stepTotal: plan.length,
        command: step.command,
        stages: liveStages.map((x) => ({ ...x })),
        liveLine: `Starting ${step.command}…`,
        text: `${prefix}Running ${step.label}: ${step.command}`,
      });

      const res = await runShellCommand(workDir, step.command, 600000, (line) => {
        onProgress?.({
          stage: 'running',
          stepIndex: i + 1,
          stepTotal: plan.length,
          command: step.command,
          stages: liveStages.map((x) => ({ ...x })),
          liveLine: line.slice(0, 140),
          text: `${prefix}${step.command} — ${line.slice(0, 90)}`,
        });
      });

      const passed = res.exitCode === 0 && !res.timedOut;
      liveStages[i].status = passed ? 'pass' : 'fail';
      liveStages[i].durationMs = res.durationMs;
      stepResults.push({
        label: step.label,
        command: step.command,
        source: step.source,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
        passed,
        output: res.output.slice(-10000),
      });

      if (!passed) {
        overallExitCode = res.exitCode || 1;
        if (res.timedOut) {
          anyTimedOut = true;
          break;
        }
        // If compilation itself failed (`compileJava FAILED`, `compileKotlin FAILED`, `COMPILATION ERROR`),
        // subsequent test stages in the same build tool will fail identically, so stop early.
        if (/compile[A-Za-z]*\s+FAILED|COMPILATION ERROR|Could not compile/i.test(res.output)) {
          break;
        }
      }
    }
  }

  const commandSummary = plan.length ? plan.map((s) => s.command).join('  →  ') : '(static review)';
  const combinedOutput = stepResults.length
    ? stepResults
        .map(
          (s, idx) =>
            `=== [${idx + 1}/${stepResults.length}] ${s.label} (${s.command}) — ${s.passed ? 'PASS' : `FAIL (exit ${s.exitCode})`} (${(s.durationMs / 1000).toFixed(1)}s) ===\n${s.output}`
        )
        .join('\n\n')
    : 'No CI test runner or changed JS files detected; reviewing diff statically.';

  let aiReport = null;
  if (modelId) {
    try {
      onProgress?.({ stage: 'analyzing', text: `Tester Agent (${modelId}) is evaluating ${stepResults.length || 1} test stage(s)…` });
      const { provider, name } = parse(modelId);
      const payload = {
        working_directory: workDir,
        branch: st.branch || '',
        user_request: (userRequest || '').slice(0, 1200),
        ci_pipeline_steps: stepResults.map((s) => ({
          label: s.label,
          command: s.command,
          source: s.source,
          exit_code: s.exitCode,
          duration_sec: +(s.durationMs / 1000).toFixed(1),
          passed: s.passed,
          output_excerpt: s.output.slice(-6000),
        })),
        overall_exit_code: overallExitCode,
        timed_out: anyTimedOut,
        changed_files: changedFiles,
        diff_stat: diffStat,
        diff_excerpt: diffPatch,
      };
      const raw = await provider.complete({
        model: name,
        system: TESTER_SYSTEM,
        prompt: `Evaluate these CI test pipeline results and code changes:\n\n${JSON.stringify(payload, null, 2)}`,
        schema: TESTER_SCHEMA,
        numCtx: 16384,
      });
      aiReport = extractJson(raw);
    } catch {}
  }

  const verdict = aiReport?.verdict || (overallExitCode === 0 ? 'pass' : 'fail');
  const passedCount = stepResults.filter((s) => s.passed).length;
  const summary =
    aiReport?.summary ||
    (stepResults.length === 0
      ? 'Static review complete (no CI test commands detected).'
      : overallExitCode === 0
        ? `All ${stepResults.length} CI test stage(s) passed (${commandSummary}).`
        : `${stepResults.length - passedCount} of ${stepResults.length} CI test stage(s) failed running: ${commandSummary}`);

  return {
    agent: 'tester',
    repo: workDir,
    branch: st.branch || '',
    model: modelId,
    command: commandSummary,
    steps: stepResults,
    exitCode: overallExitCode,
    output: combinedOutput.slice(-14000),
    verdict,
    summary,
    failures: aiReport?.failures || [],
    instructionsForAgent: aiReport?.instructions_for_agent || '',
    at: Date.now(),
  };
}

module.exports = {
  runMergerAgent,
  runTesterAgent,
  discoverCiTestPlan,
  detectBaseBranch,
};
