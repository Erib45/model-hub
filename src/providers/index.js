const ollama = require('./ollama');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const openai = require('./openai');
const claudecode = require('./claudecode');
const codexcli = require('./codexcli');
const geminicli = require('./geminicli');

const providers = { ollama, anthropic, gemini, openai, claudecode, codexcli, geminicli };

// Model ids look like "ollama:qwen3:1.7b", "anthropic:claude-opus-5-5",
// "gemini:gemini-2.5-flash", "openai:gpt-5". Bare names (older chats) are Ollama models.
function parse(modelId) {
  const i = modelId.indexOf(':');
  const prefix = i > 0 ? modelId.slice(0, i) : '';
  if (providers[prefix]) return { provider: providers[prefix], name: modelId.slice(i + 1) };
  return { provider: ollama, name: modelId };
}

async function listAll(notes) {
  const lists = await Promise.all([
    ollama.listModels(notes),
    anthropic.listModels(notes).catch(() => []),
    gemini.listModels(notes).catch(() => []),
    openai.listModels(notes).catch(() => []),
    claudecode.listModels(notes).catch(() => []),
    codexcli.listModels(notes).catch(() => []),
    geminicli.listModels(notes).catch(() => []),
  ]);
  return lists.flat();
}

module.exports = { providers, parse, listAll };
