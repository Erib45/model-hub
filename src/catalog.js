// Descriptions for known model families. Matched against the installed model
// name (the part before ":"), longest prefix wins. Users can override any
// description from the Library view; overrides are stored in userData.

const CATALOG = [
  {
    family: 'qwen3-coder',
    title: 'Qwen3 Coder',
    tags: ['coding', 'agentic'],
    description:
      'Coding specialist (MoE, ~3B active params, so fast even when partly in RAM). Excellent at writing, refactoring and agentic multi-file work with tool calls.',
    pull: ['qwen3-coder:30b'],
  },
  {
    family: 'qwen2.5-coder',
    title: 'Qwen2.5 Coder',
    tags: ['coding', 'autocomplete'],
    description:
      'Reliable code chat, explanation and refactoring. The 1.5B/3B sizes are ideal for fast tab-autocomplete; 14B for chat.',
    pull: ['qwen2.5-coder:14b', 'qwen2.5-coder:1.5b'],
  },
  {
    family: 'devstral',
    title: 'Devstral',
    tags: ['coding', 'agentic'],
    description:
      'Mistral\'s agentic coding model. Built to navigate repositories, edit multiple files and use tools in multi-step software tasks.',
    pull: ['devstral:24b'],
  },
  {
    family: 'gpt-oss',
    title: 'gpt-oss',
    tags: ['research', 'reasoning', 'tools'],
    description:
      'OpenAI open-weight reasoning model. Very good at tool calling and browsing — the best pick here for web research and fact-finding.',
    pull: ['gpt-oss:20b'],
  },
  {
    family: 'qwen3',
    title: 'Qwen3',
    tags: ['general', 'research', 'reasoning', 'tools'],
    description:
      'Strong general model with an optional thinking mode. Good at tool use and digesting long search results; the 30b-a3b MoE is fast.',
    pull: ['qwen3:14b', 'qwen3:30b'],
  },
  {
    family: 'gemma3',
    title: 'Gemma 3',
    tags: ['general', 'vision', 'writing'],
    description:
      'Google general-purpose model that can also read images (screenshots, diagrams, UI mockups). Nice writing quality.',
    pull: ['gemma3:12b', 'gemma3:27b-it-qat'],
  },
  {
    family: 'deepseek-r1',
    title: 'DeepSeek R1 (distill)',
    tags: ['reasoning', 'math'],
    description:
      'Long chain-of-thought reasoning for maths, logic and hard debugging. Slower because it thinks at length before answering.',
    pull: ['deepseek-r1:14b'],
  },
  {
    family: 'phi4',
    title: 'Phi-4',
    tags: ['reasoning', 'general'],
    description: 'Compact Microsoft model, quick and good at STEM-style reasoning.',
    pull: ['phi4:14b'],
  },
  {
    family: 'llama3',
    title: 'Llama 3.x',
    tags: ['general'],
    description: 'Meta general-purpose chat model. Solid all-rounder, widely supported.',
    pull: ['llama3.1:8b'],
  },
  {
    family: 'mistral',
    title: 'Mistral',
    tags: ['general'],
    description: 'Fast general-purpose model from Mistral AI.',
    pull: [],
  },
  {
    family: 'nomic-embed-text',
    title: 'Nomic Embed',
    tags: ['embeddings'],
    description: 'Embedding model (not for chat). Used for search / RAG over documents.',
    pull: [],
  },
];

function lookup(modelName) {
  const base = modelName.split(':')[0].split('/').pop().toLowerCase();
  let best = null;
  for (const entry of CATALOG) {
    if (base.startsWith(entry.family) && (!best || entry.family.length > best.family.length)) {
      best = entry;
    }
  }
  return best;
}

module.exports = { CATALOG, lookup };
