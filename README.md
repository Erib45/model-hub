# Model Hub

Desktop app (Electron, Windows) for working with local and cloud AI models side by side: a model library, chat with seamless model switching, and shared tools (browser, terminal, Git, Android emulator) that every model can use under your approval.

## Install

Download `Model-Hub-Setup-<version>.exe` from Releases (or build it, below) and run it. The app isn't code-signed, so Windows SmartScreen may warn on first launch: choose **More info → Run anyway**.

On first start, the **Setup** page checks for the tools Model Hub uses and installs missing ones with one click from official sources:

| Tool | Used for | Installed with |
|---|---|---|
| Ollama | Local models | winget `Ollama.Ollama` |
| Git | Git panel | winget `Git.Git` |
| Node.js | Installing/running the CLIs below | winget `OpenJS.NodeJS.LTS` |
| Claude Code / Codex / Gemini CLI | Chatting on your own Claude / ChatGPT / Google plan | npm |
| Android Studio (optional) | Android emulator panel | winget `Google.AndroidStudio` |

Setup can be reopened any time from Settings.

## Develop

```
npm install
npm start          # run from source
npm run dist       # build the Windows installer into dist/
```

## Features

- **Library**: installed models with editable "what it's good at" descriptions, unload/delete.
- **Discover**: hand-picked models, the Ollama library, Hugging Face GGUF repos (with a fit-on-your-GPU badge), and import of a local `.gguf` file or any model by name. One-click downloads.
- **Chat**: switch models mid-conversation; history is stored provider-neutrally so the next model sees everything. By default a model sees only other models' *answers*, not their tool calls/raw tool output ("compact hand-back", Settings). Claude requests use prompt caching (1 h by default). A context meter shows how full the selected model's window is; local models get the oldest turns trimmed with a notice instead of Ollama's silent truncation.
- **Compact**: a model of your choice (only ones whose window fits the chat) splits the chat into sections with summaries and keep / summary / drop suggestions; you decide per section and can edit summaries. Undo restores the original.
- **Recommended**: live candidates from ollama.com, filtered by rules to the versions that fit your GPU/RAM (plus MoE "stretch" picks and, when signed in, Ollama cloud versions). "✨ Let AI pick" asks a model of your choice (Claude/Gemini can search the web) to rank them; it can only return tags from the filtered list.
- **Use your own plans** (Settings → Accounts): Claude Code (Claude plan), Codex (ChatGPT plan) and Gemini CLI (Google account) run as providers. The app launches each official, unmodified CLI in its own profile folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` under the app's data folder), sign-in happens in the CLI's own flow in a console window, and the app never reads credentials. Their built-in tools stay on except the ones Model Hub provides (shell, browser/web, file writing); Model Hub's tools are offered through a small MCP server (`src/claudecode/mcp-server.js`) that calls back into the app over a token-protected localhost bridge, so approvals and the AI reviewer apply. Sessions are resumed per chat; other models' work is handed over as context.
- **Git panel** (right side, next to Browser/Terminal): track repositories (add folder, scan workspace, clone, init), see changed files and diffs live as models edit them, stage/unstage/discard, commit (or amend), history with commit diffs, switch/create branches, fetch/pull/push with ahead/behind counts. Uses the git CLI with argument arrays (no shell).
- **Accounts**: Claude (API key, `ANTHROPIC_API_KEY`, or an `ant auth login` profile), OpenAI (API key or `OPENAI_API_KEY`), Gemini (API key), Ollama.com (browser sign-in; unlocks cloud models) and Hugging Face (token for gated/private repos, plus linking Ollama's SSH key so Ollama can download them). Keys are encrypted with Windows DPAPI.
- **Tools for every model**: web search/browse in an embedded browser you can also click in; PowerShell terminal; read/write files. Models without native tool calling get a text protocol.
- **Permissions**: Ask / Auto / Full auto. A rule classifier (`src/tools/permissions.js`) marks commands read-only, normal or dangerous; dangerous always asks. In Auto mode a small local model (`src/tools/reviewer.js`, CPU-only) reviews "normal" commands.
- **Android**: boot AVDs and control the emulator screen inside the app.
- Dark (default) and light theme.

## Layout

```
src/main.js            app, IPC, chat loop
src/providers/         ollama, anthropic, gemini adapters + shared message format
src/tools/             browser, terminal, permissions, AI reviewer, tool registry
src/discover.js        model search (ollama.com, Hugging Face) and GGUF import
src/android.js         emulator + adb bridge
src/renderer/          UI (plain HTML/CSS/JS, no build step)
```
