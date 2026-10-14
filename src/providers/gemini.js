// Gemini via the Google Generative Language REST API (API key from
// https://aistudio.google.com/apikey).

const secrets = require('../secrets');
const { genId, sse } = require('./common');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const THINKING = /gemini-(2\.5|[3-9])/;
const NEEDS_SIGNATURE = /gemini-([3-9])/; // Gemini 3+ validates thought signatures on function calls

let modelCache = null;

function key() {
  const k = secrets.get('gemini') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!k) throw new Error('No Gemini API key configured');
  return k;
}

async function request(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error.message; } catch {}
    throw new Error(`Gemini ${res.status}: ${msg}`);
  }
  return res;
}

function describe(id) {
  if (/pro/.test(id)) return [['reasoning', 'coding', 'research'], "Google's most capable Gemini: deep reasoning, coding and long-context research."];
  if (/flash-lite/.test(id)) return [['fast'], 'Cheapest, fastest Gemini for simple, high-volume tasks.'];
  if (/flash/.test(id)) return [['fast', 'general', 'research'], 'Fast, inexpensive Gemini with a large context window. A good all-rounder.'];
  return [[], ''];
}

function toGemini(messages, model) {
  const out = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content) push('user', [{ text: m.content }]);
    } else if (m.role === 'tool') {
      push('user', [{ functionResponse: { name: m.tool_name, response: { result: m.content } } }]);
    } else if (m.role === 'assistant') {
      if (m.native?.provider === 'gemini' && m.native.model === model) {
        push('model', m.native.parts);
        continue;
      }
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls || []) {
        const part = { functionCall: { name: tc.name, args: tc.arguments || {} } };
        // Calls made by a different model carry no signature; Gemini documents this placeholder for that case.
        if (NEEDS_SIGNATURE.test(model)) part.thoughtSignature = 'skip_thought_signature_validator';
        parts.push(part);
      }
      push('model', parts);
    }
  }
  return out;
}

function toDeclarations(tools) {
  return tools.map((t) => {
    const hasParams = t.parameters && Object.keys(t.parameters.properties || {}).length;
    // Gemini's schema subset has no additionalProperties.
    const { additionalProperties, ...parameters } = t.parameters || {};
    return { name: t.name, description: t.description, ...(hasParams ? { parameters } : {}) };
  });
}

module.exports = {
  id: 'gemini',

  async status() {
    try {
      await this.listModels({}, true);
      return { connected: true, source: secrets.get('gemini') ? 'API key' : 'environment' };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  },

  async listModels(notes, refresh) {
    if (!modelCache || refresh) {
      const res = await request('/models?pageSize=1000');
      const data = await res.json();
      modelCache = (data.models || []).filter(
        (m) =>
          m.supportedGenerationMethods?.includes('generateContent') &&
          /gemini/.test(m.name) &&
          !/tts|image|embedding|live|audio|robotics|computer-use/.test(m.name)
      );
    }
    return modelCache.map((m) => {
      const name = m.name.replace(/^models\//, '');
      const id = `gemini:${name}`;
      const [tags, desc] = describe(name);
      return {
        id,
        provider: 'gemini',
        name,
        title: m.displayName || name,
        tags,
        description: notes[id] ?? (desc || m.description || ''),
        customDescription: id in notes,
        capabilities: ['tools', 'vision', ...(THINKING.test(name) ? ['thinking'] : [])],
        efforts: !THINKING.test(name) ? [] : NEEDS_SIGNATURE.test(name) ? ['low', 'high'] : ['low', 'medium', 'high', 'max'],
        nativeTools: true,
        contextLength: m.inputTokenLimit || null,
      };
    });
  },

  forget() {
    modelCache = null;
  },

  // One-shot request (used by the AI model picker). Gemini may ground with Google Search.
  async complete({ model, system, prompt, webSearch }) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
    };
    if (webSearch) body.tools = [{ google_search: {} }];
    const res = await request(`/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  },

  async chatTurn({ model, system, messages, tools, effort, signal, onText, onThinking }) {
    const body = {
      contents: toGemini(messages, model),
      systemInstruction: { parts: [{ text: system }] },
    };
    if (tools) body.tools = [{ functionDeclarations: toDeclarations(tools) }];
    if (THINKING.test(model)) {
      const thinkingConfig = { includeThoughts: true };
      if (effort && NEEDS_SIGNATURE.test(model)) thinkingConfig.thinkingLevel = ['low', 'medium'].includes(effort) ? 'low' : 'high'; // Gemini 3+
      else if (effort) thinkingConfig.thinkingBudget = { low: 1024, medium: 8192, high: 16384, xhigh: 24576, max: /flash/.test(model) ? 24576 : 32768 }[effort];
      body.generationConfig = { thinkingConfig };
    }

    const res = await request(`/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });

    const result = { content: '', thinking: '', toolCalls: [], stats: null };
    const parts = []; // native parts, replayed verbatim to this model (keeps thought signatures)
    let finish = null;
    for await (const chunk of sse(res.body)) {
      const cand = chunk.candidates?.[0];
      for (const p of cand?.content?.parts || []) {
        if (p.functionCall) {
          parts.push(p);
          result.toolCalls.push({ id: genId(), name: p.functionCall.name, arguments: p.functionCall.args || {} });
        } else if (typeof p.text === 'string') {
          if (p.thought) {
            result.thinking += p.text;
            onThinking(p.text);
          } else {
            result.content += p.text;
            onText(p.text);
          }
          const last = parts[parts.length - 1];
          // Merge streamed text fragments, but never across a signature boundary.
          if (last && typeof last.text === 'string' && !!last.thought === !!p.thought && !last.thoughtSignature && !p.thoughtSignature) {
            last.text += p.text;
          } else {
            parts.push({ ...p });
          }
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (chunk.usageMetadata) result.stats = { outputTokens: chunk.usageMetadata.candidatesTokenCount, inputTokens: chunk.usageMetadata.promptTokenCount, cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0 };
    }
    result.native = { provider: 'gemini', model, parts };
    if (finish && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
      result.notice = `Gemini stopped early (${finish}).`;
    }
    return result;
  },
};
