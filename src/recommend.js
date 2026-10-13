// "Let AI pick": a model of the user's choice ranks recommendation candidates.
// The renderer gathers candidates and does the hardware-fit math (rules);
// the AI only orders and explains them, and may only return tags from the list.

const { parse } = require('./providers');

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          picks: {
            type: 'array',
            items: { type: 'object', properties: { tag: { type: 'string' }, reason: { type: 'string' } }, required: ['tag', 'reason'] },
          },
        },
        required: ['title', 'picks'],
      },
    },
  },
  required: ['summary', 'sections'],
};

const SYSTEM = `You recommend open AI models for a user to run with Ollama on their own PC.
You get the user's hardware, their goal, and a list of candidate models. Each candidate lists downloadable options (exact Ollama tags) with size and how it fits the hardware:
- "gpu": fits entirely in VRAM, fast
- "gpu+ram": split between VRAM and system RAM; fine for MoE models (few active parameters), slow for dense models
- "cloud": runs on ollama.com through the user's account (no local resources, usage limits, prompts leave the PC)

Pick the best options for the goal. Prefer strong, recent, well-regarded models; use what you know about model quality and benchmarks{{WEB}}.
Rules:
- Only use tags that appear in the candidate list, copied exactly.
- 2 to 4 sections (e.g. "Best for coding", "Best for research & web tasks", "Fast & small", "Vision"), 2 to 4 picks each, best first. Only include sections relevant to the goal.
- Prefer current model families. Use last_updated and recently_added: models last updated a year or more ago have usually been superseded by newer families from the same makers.
- Prefer "gpu" options. Include a "gpu+ram" option only for MoE models and say so. Mark cloud picks clearly in the reason.
- Each reason: one sentence, max 25 words, saying why it suits THIS user and hardware.
- summary: 1-2 sentences of overall advice.
Respond with JSON only, matching: {"summary": "...", "sections": [{"title": "...", "picks": [{"tag": "...", "reason": "..."}]}]}`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The model did not return JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

async function aiPick({ modelId, goal, hw, candidates }) {
  const { provider, name } = parse(modelId);
  const webSearch = provider.id !== 'ollama'; // Claude, Gemini and OpenAI can search the web
  const system = SYSTEM.replace('{{WEB}}', webSearch ? ', and search the web for recent releases and benchmarks if useful (keep it to a few searches)' : '');
  const prompt = JSON.stringify(
    {
      hardware: {
        gpu: hw.gpu,
        vram_gb: Math.round(hw.vram / 2 ** 30),
        ram_gb: Math.round(hw.ram / 2 ** 30),
      },
      goal,
      candidates,
    },
    null,
    1
  );
  const text = await provider.complete({ model: name, system, prompt, webSearch, schema: SCHEMA });
  const result = extractJson(text);

  // Never trust tags from the model: keep only ones we offered.
  const allowed = new Set(candidates.flatMap((c) => c.options.map((o) => o.tag)));
  const sections = (result.sections || [])
    .map((s) => ({
      title: String(s.title || '').slice(0, 80),
      picks: (s.picks || [])
        .filter((p) => allowed.has(p.tag))
        .map((p) => ({ tag: p.tag, reason: String(p.reason || '').slice(0, 300) })),
    }))
    .filter((s) => s.picks.length);
  if (!sections.length) throw new Error('The model returned no valid picks. Try again or choose another model.');
  return { summary: String(result.summary || '').slice(0, 600), sections, model: modelId };
}

module.exports = { aiPick };
