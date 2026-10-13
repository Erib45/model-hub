// Shared helpers for the provider adapters.
//
// Chats are stored in one provider-neutral format so any model can pick up a
// conversation started by any other model:
//   { role: 'user', content }
//   { role: 'assistant', model: 'provider:id', content, thinking?, tool_calls?: [{ id, name, arguments }],
//     native?: { provider, model, ... } }   // exact provider payload, replayed only to the same model
//   { role: 'tool', tool_call_id, tool_name, content, is_error? }
//   { kind: 'switch', ... }                 // UI-only marker

const crypto = require('crypto');

const genId = () => 'call_' + crypto.randomBytes(8).toString('hex');

// Every tool call must be followed by a result, or the APIs reject the
// history. Fill in any that are missing (e.g. after the user pressed Stop).
function repairHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind && m.kind !== 'summary') continue; // UI-only markers (model switch, compaction)
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length && !m.native) continue;
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set();
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) answered.add(messages[j].tool_call_id);
      const missing = m.tool_calls.filter((tc) => !answered.has(tc.id));
      // Results that do exist are pushed by the main loop; only add the missing ones after them.
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') out.push(messages[j++]);
      for (const tc of missing) out.push({ role: 'tool', tool_call_id: tc.id, tool_name: tc.name, content: 'Cancelled by user.', is_error: true });
      i = j - 1;
    }
  }
  return out;
}

// Rough token estimate (~3.6 characters per token for mixed prose/code).
function estimateTokens(messages, system = '') {
  let chars = system.length;
  for (const m of messages) {
    chars += (m.content || '').length + 12;
    for (const tc of m.tool_calls || []) chars += JSON.stringify(tc.arguments || {}).length + tc.name.length + 12;
  }
  return Math.ceil(chars / 3.6);
}

// "Compact hand-back": what one model sees of other models' work. Their tool
// calls and raw tool output are dropped and consecutive replies are merged, so
// only their answers come through. The transform depends only on each message
// itself, so the history stays byte-stable between requests (prompt caching).
function handBack(messages, modelId) {
  const out = [];
  const foreignCalls = new Set();
  for (const m of messages) {
    if (m.role === 'tool' && foreignCalls.has(m.tool_call_id)) continue;
    if (m.role === 'assistant' && m.model && m.model !== modelId) {
      for (const tc of m.tool_calls || []) foreignCalls.add(tc.id);
      if (!m.content?.trim()) continue;
      const tools = [...new Set((m.tool_calls || []).map((tc) => tc.name))];
      const last = out[out.length - 1];
      if (last?.handedBack && last.model === m.model) {
        last.content += `\n\n${m.content}`;
        continue;
      }
      out.push({
        role: 'assistant',
        model: m.model,
        handedBack: true,
        content: `[Answer from ${m.model}${tools.length ? `, which used ${tools.join(', ')}; raw tool output omitted` : ''}]\n${m.content}`,
      });
      continue;
    }
    out.push(m);
  }
  return out;
}

// Groups messages into turns: each starts at a user message (or summary).
function buildTurns(messages) {
  const turns = [];
  for (const m of repairHistory(messages)) {
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(m);
  }
  return turns;
}

// Parses newline-delimited `data: {...}` server-sent events.
async function* sse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
    }
  }
}

module.exports = { genId, repairHistory, sse, estimateTokens, handBack, buildTurns };
