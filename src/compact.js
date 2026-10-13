// Custom compaction: a model of the user's choice reads the whole chat, splits
// it into sections with summaries and a keep / summary / drop suggestion. The
// user reviews every section; apply() rebuilds the history from their choices.

const { parse } = require('./providers');
const { buildTurns, estimateTokens } = require('./providers/common');

const MAX_TOOL_CHARS = 6000; // a huge page dump adds little to a summary

const SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          first_turn: { type: 'integer' },
          last_turn: { type: 'integer' },
          summary: { type: 'string' },
          recommendation: { type: 'string', enum: ['keep', 'summary', 'drop'] },
          reason: { type: 'string' },
        },
        required: ['title', 'first_turn', 'last_turn', 'summary', 'recommendation', 'reason'],
      },
    },
  },
  required: ['sections'],
};

const SYSTEM = `You help compact a long AI chat so it costs less and fits in context, without losing what matters.
You get the full transcript, split into numbered turns (a turn = one user message plus everything that answered it).

Split the conversation into 3 to 12 sections of consecutive turns, one per topic or phase of work. Together the sections must cover every turn exactly once, in order.
For each section give:
- title: a few words
- first_turn, last_turn: turn numbers (inclusive)
- summary: 2-6 sentences that would let someone continue the work without the original. Keep concrete facts: decisions, conclusions, file paths, function/variable names, commands, URLs, numbers, open questions. No filler.
- recommendation:
  - "keep": still needed in full (ongoing work, recent turns, exact code or text that will be reused, unresolved problems)
  - "summary": finished work or exploration where the summary is enough
  - "drop": dead ends, chit-chat, superseded attempts, or anything irrelevant to what the user is doing now
- reason: max 20 words, why.
The most recent section should usually be "keep".
Respond with JSON only: {"sections": [...]}`;

function transcript(turns) {
  return turns
    .map((turn, i) => {
      const lines = [`=== Turn ${i + 1} ===`];
      for (const m of turn) {
        if (m.role === 'user') lines.push(m.kind === 'summary' ? `[earlier summary] ${m.content}` : `[user] ${m.content}`);
        else if (m.role === 'assistant') {
          if (m.content) lines.push(`[assistant${m.model ? ` (${m.model})` : ''}] ${m.content}`);
          for (const tc of m.tool_calls || []) lines.push(`[tool call] ${tc.name} ${JSON.stringify(tc.arguments || {})}`);
        } else if (m.role === 'tool') {
          const c = m.content || '';
          lines.push(`[tool result: ${m.tool_name}] ${c.length > MAX_TOOL_CHARS ? c.slice(0, MAX_TOOL_CHARS) + ` …[${c.length - MAX_TOOL_CHARS} more chars]` : c}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The model did not return JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

// Makes the model's sections cover turns 1..n exactly once, in order.
function normalize(raw, n) {
  const secs = (raw || [])
    .map((s) => ({
      title: String(s.title || 'Section').slice(0, 80),
      first: Math.max(1, Math.min(n, parseInt(s.first_turn, 10) || 1)),
      last: Math.max(1, Math.min(n, parseInt(s.last_turn, 10) || 1)),
      summary: String(s.summary || '').trim(),
      recommendation: ['keep', 'summary', 'drop'].includes(s.recommendation) ? s.recommendation : 'summary',
      reason: String(s.reason || '').slice(0, 200),
    }))
    .sort((a, b) => a.first - b.first);
  const out = [];
  let next = 1;
  for (const s of secs) {
    if (s.last < next) continue; // fully overlapped
    s.first = next;
    if (s.last < s.first) s.last = s.first;
    out.push(s);
    next = s.last + 1;
    if (next > n) break;
  }
  if (!out.length) out.push({ title: 'Whole conversation', first: 1, last: n, summary: '', recommendation: 'keep', reason: '' });
  if (next <= n) out[out.length - 1].last = n; // extend the last section over any uncovered tail
  return out;
}

async function analyze(chat, modelId, settings) {
  const turns = buildTurns(chat.messages);
  if (turns.length < 2) throw new Error('This chat is too short to compact.');
  const text = transcript(turns);
  const tokens = Math.ceil(text.length / 3.6);
  const { provider, name } = parse(modelId);
  const raw = await provider.complete({
    model: name,
    system: SYSTEM,
    prompt: `Transcript (${turns.length} turns):\n\n${text}`,
    schema: SCHEMA,
    numCtx: Math.min(131072, Math.ceil((tokens + 6000) / 1024) * 1024),
  });
  const sections = normalize(extractJson(raw).sections, turns.length).map((s) => ({
    ...s,
    tokens: estimateTokens(turns.slice(s.first - 1, s.last).flat()),
  }));
  return { sections, turns: turns.length, tokens: estimateTokens(turns.flat()) };
}

// sections: [{ first, last, action: 'keep'|'summary'|'drop', title, summary }]
function apply(chat, sections) {
  const turns = buildTurns(chat.messages);
  const before = estimateTokens(turns.flat());
  const messages = [];
  for (const s of [...sections].sort((a, b) => a.first - b.first)) {
    const part = turns.slice(s.first - 1, s.last).flat();
    if (s.action === 'keep') {
      // Provider-specific payloads (e.g. Claude thinking blocks) are tied to the
      // original history; once it's edited they must not be replayed.
      for (const m of part) {
        const { native, ...rest } = m;
        messages.push(rest);
      }
    } else if (s.action === 'summary' && s.summary.trim()) {
      messages.push({
        role: 'user',
        kind: 'summary',
        title: s.title,
        turns: [s.first, s.last],
        content: `[Summary of earlier conversation, turns ${s.first}-${s.last}: ${s.title}]\n${s.summary.trim()}`,
      });
    }
  }
  const after = estimateTokens(messages);
  chat.archive = [...(chat.archive || []), { at: Date.now(), messages: chat.messages }];
  delete chat.agentSessions; // CLI sessions hold the old history; start fresh from the compacted one
  delete chat.claudeCode;
  chat.messages = [...messages, { kind: 'compacted', role: 'system', content: '', before, after, at: Date.now() }];
  return { before, after };
}

function undo(chat) {
  const prev = chat.archive?.pop();
  if (!prev) throw new Error('Nothing to undo');
  chat.messages = prev.messages;
  delete chat.agentSessions;
  delete chat.claudeCode;
}

module.exports = { analyze, apply, undo };
