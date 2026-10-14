// Claude via the official Anthropic SDK. Credentials: an API key saved in the
// app, otherwise whatever the SDK resolves itself (ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).

const Anthropic = require('@anthropic-ai/sdk').default;
const secrets = require('../secrets');

// Models that take adaptive thinking (Claude 4.6 and later).
const ADAPTIVE = /claude-(fable|mythos|opus|sonnet|haiku)-(5|4-6|4-7|4-8)/;
// Models that take the dynamic-filtering web search tool; older ones use the basic variant.
const WEB_SEARCH_NEW = /claude-(fable|mythos|opus|sonnet)-(5|4-6|4-7|4-8)/;
// Models with server-side refusal fallbacks ("default" routing).
const FALLBACK = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;

const FAMILY = [
  [/fable|mythos/, ['reasoning', 'coding', 'agentic'], "Anthropic's most capable model, for the hardest reasoning and long agentic tasks. The most expensive."],
  [/opus/, ['coding', 'agentic', 'research'], 'Top-tier Claude for complex coding, agentic work and deep research.'],
  [/sonnet/, ['coding', 'general', 'research'], 'Fast, highly capable Claude. A strong everyday choice for coding and agent work.'],
  [/haiku/, ['fast', 'general'], 'The fastest and cheapest Claude. Good for quick questions and simple tasks.'],
];

// Effort levels per model: 4.7+ / 5.x take low…max, 4.6 has no xhigh, older none.
function effortsFor(model) {
  if (/-(4-6)\b|-4-6$/.test(model)) return ['low', 'medium', 'high', 'max'];
  if (ADAPTIVE.test(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/opus-4-5/.test(model)) return ['low', 'medium', 'high'];
  return [];
}

let cachedClient = null;
let cachedKey;
function client() {
  const key = secrets.get('anthropic') || undefined;
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new Anthropic(key ? { apiKey: key } : {});
    cachedKey = key;
  }
  return cachedClient;
}

let modelCache = null;

function toAnthropic(messages, model) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content) push('user', [{ type: 'text', text: m.content }]);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '(empty)', ...(m.is_error ? { is_error: true } : {}) }]);
    } else if (m.role === 'assistant') {
      // Same model: replay the exact blocks (keeps thinking blocks valid).
      if (m.native?.provider === 'anthropic' && m.native.model === model) {
        push('assistant', m.native.content);
        continue;
      }
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
      push('assistant', blocks);
    }
  }
  return out;
}

module.exports = {
  id: 'anthropic',

  async status() {
    try {
      await this.listModels({}, true);
      return { connected: true, source: secrets.get('anthropic') ? 'API key' : 'environment / ant profile' };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  },

  async listModels(notes, refresh) {
    if (!modelCache || refresh) {
      const list = [];
      for await (const m of client().models.list()) list.push(m);
      modelCache = list;
    }
    return modelCache.map((m) => {
      const fam = FAMILY.find(([re]) => re.test(m.id));
      const id = `anthropic:${m.id}`;
      return {
        id,
        provider: 'anthropic',
        name: m.id,
        title: m.display_name || m.id,
        tags: fam?.[1] || [],
        description: notes[id] ?? fam?.[2] ?? '',
        customDescription: id in notes,
        capabilities: ['tools', 'vision', ...(ADAPTIVE.test(m.id) ? ['thinking'] : [])],
        efforts: effortsFor(m.id),
        nativeTools: true,
        contextLength: m.max_input_tokens || null,
      };
    });
  },

  forget() {
    modelCache = null;
    cachedClient = null;
  },

  // One-shot request (used by the AI model picker). Claude may search the web.
  async complete({ model, system, prompt, webSearch }) {
    const params = { model, max_tokens: 16000, system, messages: [{ role: 'user', content: prompt }] };
    if (webSearch) {
      params.tools = [{ type: WEB_SEARCH_NEW.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }
    if (ADAPTIVE.test(model)) params.thinking = { type: 'adaptive' };
    if (FALLBACK.test(model)) {
      params.fallbacks = 'default';
      params.betas = ['server-side-fallback-2026-07-01'];
    }
    // Server-side tools can pause a long turn; resend to let it continue.
    for (let i = 0; i < 5; i++) {
      const msg = await client().beta.messages.stream(params).finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      if (msg.stop_reason === 'pause_turn') {
        params.messages = [...params.messages, { role: 'assistant', content: msg.content }];
        continue;
      }
      return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    throw new Error('Claude did not finish (too many pauses).');
  },

  async chatTurn({ model, system, messages, tools, settings, effort, signal, onText, onThinking }) {
    // Prompt caching: an explicit breakpoint on the stable system prompt, plus
    // automatic caching that moves along with the growing conversation. Both use
    // the same TTL (a longer TTL may not follow a shorter one).
    const cache = settings?.claudeCacheTtl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };
    const params = {
      model,
      max_tokens: 64000,
      system: [{ type: 'text', text: system, cache_control: cache }],
      messages: toAnthropic(messages, model),
      cache_control: cache,
    };
    if (tools) {
      params.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
    }
    if (ADAPTIVE.test(model)) params.thinking = { type: 'adaptive', display: 'summarized' };
    if (effort && effortsFor(model).includes(effort)) params.output_config = { effort };
    if (FALLBACK.test(model)) {
      // If a safety classifier declines, the API retries on its recommended fallback model.
      params.fallbacks = 'default';
      params.betas = ['server-side-fallback-2026-07-01'];
    }

    const stream = client().beta.messages.stream(params, { signal });
    stream.on('text', (d) => onText(d));
    stream.on('thinking', (d) => onThinking(d));
    const msg = await stream.finalMessage();

    const result = {
      content: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      thinking: msg.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n'),
      toolCalls: msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
      native: { provider: 'anthropic', model, content: msg.content },
      stats: {
        outputTokens: msg.usage?.output_tokens,
        // Total prompt = uncached + written to cache + read from cache.
        inputTokens: (msg.usage?.input_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0),
        cacheRead: msg.usage?.cache_read_input_tokens || 0,
        cacheWrite: msg.usage?.cache_creation_input_tokens || 0,
      },
    };
    if (msg.stop_reason === 'refusal') {
      result.toolCalls = []; // a refusal can cut a tool call off mid-input
      result.notice = `Claude declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}. Try rephrasing or switch to another model; the conversation carries over.`;
    } else if (msg.stop_reason === 'max_tokens' && result.toolCalls.length) {
      result.toolCalls = []; // truncated tool input — never run it
      result.notice = 'Response hit the output limit while writing a tool call; the call was skipped.';
    }
    return result;
  },
};
