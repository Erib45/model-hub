// OpenAI via its REST API (API key from https://platform.openai.com/api-keys).
// Chat uses Chat Completions (streaming + function calling); the one-shot
// complete() used by the AI model picker uses the Responses API so the model
// can search the web.

const secrets = require('../secrets');
const { sse } = require('./common');

const BASE = 'https://api.openai.com/v1';
// Chat-capable families; snapshots, audio/realtime/image/embedding models etc. are hidden.
const CHAT = /^(gpt-|o\d|chatgpt-)/;
const HIDE = /(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct|codex|davinci|babbage|dall-e|whisper|sora|computer-use|-\d{4}-\d{2}-\d{2}$|-preview$)/;
const REASONING = /^(o\d|gpt-5)/;

let modelCache = null;

function key() {
  const k = secrets.get('openai') || process.env.OPENAI_API_KEY;
  if (!k) throw new Error('No OpenAI API key configured');
  return k;
}

async function request(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error.message; } catch {}
    const err = new Error(`OpenAI ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function describe(id) {
  if (/^o\d|pro/.test(id)) return [['reasoning', 'coding', 'research'], 'OpenAI reasoning model: thinks before answering. Strong at hard coding, maths and multi-step research.'];
  if (/nano/.test(id)) return [['fast'], 'Smallest, cheapest OpenAI model for simple, high-volume tasks.'];
  if (/mini/.test(id)) return [['fast', 'general', 'coding'], 'Fast, inexpensive OpenAI model. A good everyday choice.'];
  return [['general', 'coding', 'research'], "OpenAI's flagship general model for coding, writing and research."];
}

function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content || '' });
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content || '(empty)' });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) } }));
      }
      if (msg.content || msg.tool_calls) out.push(msg);
    }
  }
  return out;
}

module.exports = {
  id: 'openai',

  async status() {
    try {
      await this.listModels({}, true);
      return { connected: true, source: secrets.get('openai') ? 'API key' : 'environment' };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  },

  async listModels(notes, refresh) {
    if (!modelCache || refresh) {
      const data = await (await request('/models')).json();
      modelCache = (data.data || [])
        .map((m) => m.id)
        .filter((id) => CHAT.test(id) && !HIDE.test(id))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    }
    return modelCache.map((name) => {
      const id = `openai:${name}`;
      const [tags, desc] = describe(name);
      return {
        id,
        provider: 'openai',
        name,
        title: name,
        tags,
        description: notes[id] ?? desc,
        customDescription: id in notes,
        capabilities: ['tools', ...(REASONING.test(name) ? ['thinking'] : [])],
        efforts: REASONING.test(name) ? ['low', 'medium', 'high'] : [],
        nativeTools: true,
        contextLength: null,
      };
    });
  },

  forget() {
    modelCache = null;
  },

  async complete({ model, system, prompt, webSearch }) {
    const body = { model, instructions: system, input: prompt };
    if (webSearch) body.tools = [{ type: 'web_search' }];
    let res;
    try {
      res = await request('/responses', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (!webSearch || e.status !== 400) throw e;
      delete body.tools; // model without web search support
      res = await request('/responses', { method: 'POST', body: JSON.stringify(body) });
    }
    const data = await res.json();
    return (data.output || [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('');
  },

  async chatTurn({ model, system, messages, tools, effort, signal, onText }) {
    const body = {
      model,
      messages: toOpenAI(system, messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(effort && REASONING.test(model) ? { reasoning_effort: effort } : {}),
    };
    if (tools) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const res = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body), signal });

    const result = { content: '', thinking: '', toolCalls: [], stats: null };
    const partial = []; // tool calls stream in fragments, keyed by index
    let finish = null;
    for await (const chunk of sse(res.body)) {
      const choice = chunk.choices?.[0];
      const d = choice?.delta || {};
      if (d.content) {
        result.content += d.content;
        onText(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const p = (partial[tc.index] ||= { id: '', name: '', args: '' });
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) result.stats = { outputTokens: chunk.usage.completion_tokens, inputTokens: chunk.usage.prompt_tokens, cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens || 0 };
    }
    for (const p of partial.filter(Boolean)) {
      let args = {};
      try {
        args = p.args ? JSON.parse(p.args) : {};
      } catch {
        args = { __invalid_json: p.args };
      }
      result.toolCalls.push({ id: p.id, name: p.name, arguments: args });
    }
    if (finish === 'length' && result.toolCalls.length) {
      result.toolCalls = [];
      result.notice = 'Response hit the output limit while writing a tool call; the call was skipped.';
    } else if (finish === 'content_filter') {
      result.notice = 'OpenAI stopped this response (content filter).';
    }
    return result;
  },
};
