// Local models via Ollama. Models with native tool calling get real tools;
// the rest get a text protocol (<tool_call>{...}</tool_call>) so every model
// can still use the browser and terminal.

const api = require('./ollama-api');
const catalog = require('../catalog');
const { genId, estimateTokens } = require('./common');

const capCache = new Map();
async function details(name) {
  if (!capCache.has(name)) {
    try {
      const info = await api.show(name);
      const mi = info.model_info || {};
      const key = Object.keys(mi).find((k) => k.endsWith('.context_length'));
      capCache.set(name, { capabilities: info.capabilities || [], contextLength: key ? mi[key] : null });
    } catch {
      return { capabilities: [], contextLength: null };
    }
  }
  return capCache.get(name);
}

let lastLoaded = null;

function textToolPrompt(tools) {
  return (
    '\n\n# Tools\nYou can use tools. To call one, write exactly one block and then stop:\n' +
    '<tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>\n' +
    'The result arrives in the next message. Only call tools listed here:\n' +
    tools.map((t) => `- ${t.name}: ${t.description} Arguments: ${JSON.stringify(t.parameters.properties || {})}`).join('\n')
  );
}

function parseTextToolCalls(content) {
  const calls = [];
  const cleaned = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, json) => {
    try {
      const obj = JSON.parse(json);
      if (obj.name) calls.push({ id: genId(), name: obj.name, arguments: obj.arguments || obj.parameters || {} });
    } catch {}
    return '';
  });
  return { calls, cleaned: cleaned.trim() };
}

// Ollama silently cuts the oldest tokens when a prompt is too long (which can
// even remove the system prompt). Instead, drop whole old turns ourselves and
// tell the model that earlier context is missing.
function fitToContext(messages, system, numCtx, tools) {
  const reserve = Math.min(4096, Math.floor(numCtx * 0.25)); // room for the answer
  const toolSchema = tools ? Math.ceil(JSON.stringify(tools).length / 3.6) : 0;
  const budget = numCtx - reserve - estimateTokens([], system) - toolSchema;
  const total = estimateTokens(messages);
  if (total <= budget) return { messages };
  const starts = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  let cut = starts[starts.length - 1] ?? 0; // always keep at least the latest turn
  for (let k = starts.length - 1; k >= 0; k--) {
    if (estimateTokens(messages.slice(starts[k])) > budget) break;
    cut = starts[k];
  }
  const kept = messages.slice(cut);
  const droppedTurns = starts.filter((i) => i < cut).length;
  const note = {
    role: 'user',
    content: `[Note: the first ${droppedTurns} turn(s) of this conversation were left out because they don't fit in your context window. If something seems to be missing, say so.]`,
  };
  return {
    messages: [note, ...kept],
    notice: `This model's context window (${Math.round(numCtx / 1024)}k tokens) only fits the latest ${starts.length - droppedTurns} of ${starts.length} turns (~${Math.round(total / 1000)}k tokens in the chat), so it can't see the beginning. Use Compact, or raise the context window in Settings.`,
  };
}

function toOllama(messages, nativeTools) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return nativeTools
        ? { role: 'tool', tool_name: m.tool_name, content: m.content }
        : { role: 'user', content: `[Result of ${m.tool_name}]\n${m.content}` };
    }
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls?.length) {
        if (nativeTools) out.tool_calls = m.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } }));
        else out.content += m.tool_calls.map((tc) => `\n<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.arguments })}</tool_call>`).join('');
      }
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

module.exports = {
  id: 'ollama',
  status: api.status,
  details,

  async listModels(notes) {
    let models;
    try {
      models = await api.list();
    } catch {
      return [];
    }
    const running = await api.running().catch(() => []);
    return Promise.all(
      models.map(async (m) => {
        const entry = catalog.lookup(m.name);
        const d = await details(m.name);
        const loaded = running.find((r) => r.name === m.name);
        const id = `ollama:${m.name}`;
        const cloud = !!m.remote_host; // runs on ollama.com via the user's account
        return {
          id,
          provider: 'ollama',
          name: m.name,
          local: !cloud,
          cloud,
          size: cloud ? null : m.size,
          parameterSize: m.details?.parameter_size,
          quantization: m.details?.quantization_level,
          title: (entry?.title || m.name.split(':')[0]) + (cloud ? ' (cloud)' : ''),
          tags: [...(entry?.tags || []), ...(cloud ? ['cloud'] : [])],
          description: notes[id] ?? (cloud ? `Runs on Ollama's servers through your ollama.com account (usage limits apply; prompts leave your PC). ${entry?.description || ''}` : entry?.description ?? ''),
          customDescription: id in notes,
          capabilities: d.capabilities,
          nativeTools: d.capabilities.includes('tools'),
          efforts: !d.capabilities.includes('thinking') ? [] : /^gpt-oss/.test(m.name) ? ['low', 'medium', 'high'] : ['low', 'high'],
          contextLength: d.contextLength,
          loaded: loaded ? { vram: loaded.size_vram, total: loaded.size } : null,
        };
      })
    );
  },

  // One-shot JSON request (used by the AI model picker). No web access.
  async complete({ model, system, prompt, schema, numCtx }) {
    const res = await fetch(api.BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: schema,
        think: (await details(model)).capabilities.includes('thinking') ? false : undefined, // long thinking + JSON schema can stall small models
        options: { num_ctx: numCtx || 24576, temperature: 0.2 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(300000),
    }).catch((e) => {
      throw new Error(e.name === 'TimeoutError' ? `${model} took longer than 5 minutes; try a bigger or cloud model` : e.message);
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()).message?.content || '';
  },

  async chatTurn({ model, system, messages, tools, settings, effort, signal, onText, onThinking }) {
    // Only one big local model fits in VRAM at a time: evict the previous one.
    // Cloud models use no VRAM, so they don't evict anything.
    const isCloud = /(-|:)cloud$/.test(model);
    if (!isCloud) {
      if (lastLoaded && lastLoaded !== model) await api.unload(lastLoaded);
      lastLoaded = model;
    }

    const info = await details(model);
    const nativeTools = !!tools && info.capabilities.includes('tools');
    const sys = tools && !nativeTools ? system + textToolPrompt(tools) : system;
    // Local models use the context window from Settings (capped at what the model
    // supports); cloud models get their full window.
    const numCtx = isCloud ? info.contextLength || 131072 : Math.min(settings.numCtx, info.contextLength || settings.numCtx);
    const fitted = fitToContext(messages, sys, numCtx, tools);
    const result = { content: '', thinking: '', toolCalls: [], stats: null, notice: fitted.notice };
    await api.chat(
      {
        model,
        messages: [{ role: 'system', content: sys }, ...toOllama(fitted.messages, nativeTools)],
        tools: nativeTools ? tools.map((t) => ({ type: 'function', function: t })) : undefined,
        options: isCloud ? {} : { num_ctx: numCtx },
        // Effort: gpt-oss takes low/medium/high; other thinking models switch thinking off (low) or on.
        ...(effort && info.capabilities.includes('thinking') ? { think: /^gpt-oss/.test(model) ? (effort === 'xhigh' || effort === 'max' ? 'high' : effort) : effort !== 'low' } : {}),
      },
      (chunk) => {
        const m = chunk.message || {};
        if (m.thinking) {
          result.thinking += m.thinking;
          onThinking(m.thinking);
        }
        if (m.content) {
          result.content += m.content;
          onText(m.content);
        }
        for (const tc of m.tool_calls || []) {
          let args = tc.function.arguments;
          if (typeof args === 'string') try { args = JSON.parse(args); } catch { args = {}; }
          result.toolCalls.push({ id: genId(), name: tc.function.name, arguments: args || {} });
        }
        if (chunk.done) {
          result.stats = { outputTokens: chunk.eval_count, ms: Math.round((chunk.eval_duration || 0) / 1e6) };
        }
      },
      signal
    );
    if (tools && !nativeTools) {
      const { calls, cleaned } = parseTextToolCalls(result.content);
      result.toolCalls.push(...calls);
      result.content = cleaned;
    }
    return result;
  },

  // Library management
  pull: api.pull,
  remove: (name) => {
    capCache.delete(name);
    return api.remove(name);
  },
  unload: api.unload,
};
