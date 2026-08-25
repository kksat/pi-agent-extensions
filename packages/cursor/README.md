# pi-extension-cursor

A [pi](https://pi.dev) extension that lets pi use the models of your Cursor subscription (Composer, Claude, GPT, Gemini, Grok, ...) by shelling out to the `cursor-agent` CLI.

## How it works (bridge mode)

- Model discovery runs `cursor-agent models` at startup and registers every model under a local `cursor` provider.
- For each request, the full pi conversation (system prompt, messages, tool schemas) is serialized into a single text prompt. The model is instructed to emit tool calls as one fenced JSON envelope instead of using cursor-agent's own built-in tools, because pi owns tool execution.
- The prompt is piped to `cursor-agent --print --output-format stream-json --stream-partial-output`, and the stream-json events are translated into pi's `AssistantMessageEventStream` (thinking deltas, text deltas, usage).
- A tool-call envelope found in the output is parsed into structured pi toolCall blocks so the normal pi agent loop continues.

Authentication uses your existing Cursor login (`cursor-agent status` / `cursor-agent login`). No API key needed.

## Requirements

- [`cursor-agent`](https://docs.cursor.com/cli) CLI installed and logged in.

## Environment variables

| Variable | Description |
|---|---|
| `CURSOR_AGENT_BIN` | Path to the cursor-agent binary (default: resolved from `PATH`) |
| `CURSOR_BRIDGE_FORCE` | Set to `"1"` to pass `--force` to cursor-agent (lets its built-in tools run unchecked; default off, not recommended) |

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/cursor
```

Or from npm, if published:

```bash
pi install npm:pi-extension-cursor
```
