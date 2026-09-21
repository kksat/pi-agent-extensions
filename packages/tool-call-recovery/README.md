# pi-extension-tool-call-recovery

Recover pseudo-JSON tool calls that some providers leak into the assistant **text** stream instead of emitting native `tool_calls`.

## The problem

xAI Grok and various OpenAI-compatible proxies occasionally write a tool call as text:

```
<tool_call>
{"name": "bash", "arguments": {"command": "ls -la"}}
</tool_call>
```

Because no native `toolCall` content block is created, Pi sees `toolCalls.length === 0`, assumes the agent's turn is complete, exits the agent loop, and yields back to the prompt. The tool never runs.

## The fix

Pi's `message_end` extension event can replace the finalized assistant message in place, and that replacement is visible to the agent loop **before** it checks for tool calls. This extension uses that hook to:

1. Detect leaked tool fences in the assistant text.
2. Parse them into real `toolCall` content blocks.
3. Strip the raw fence text so it is not replayed to the model.
4. Set `stopReason` to `toolUse` so the loop executes the calls.

## Supported shapes

| Shape | Example |
|---|---|
| Tagged | `<tool_call>{"name":"bash","arguments":{...}}</tool_call>` |
| Tagged array | `<tool_calls>[{"name":"read","arguments":{...}}]</tool_calls>` |
| Function tag | `<function_call>{"name":"bash","parameters":{...}}</function_call>` |
| Markdown fence | ` ```json {"name":"bash","arguments":{...}} ``` ` |
| Marker | `[TOOL_CALLS] [{"name":"bash","arguments":{...}}]` |
| OpenAI wrapper | `{"tool_calls":[{"function":{"name":"bash","arguments":"{...}"}}]}` |
| Single-key | `<tool_call>{"bash":{"command":"ls"}}</tool_call>` |
| Anthropic XML | `<invoke name="bash"><parameter name="command">ls</parameter></invoke>` |
| Bare JSON | `{"name":"bash","arguments":{...}}` (whole message only) |

## Safety

- Only runs when the provider produced **no** native tool calls.
- Only runs on clean `stop` turns — never truncated (`length`), errored, or aborted output.
- Only recovers calls whose name is one of the **currently active tools**.
- Bare JSON is only treated as a tool call when it is the whole message or carries an explicit `tool_calls`/`function_call` wrapper, so JSON the model is merely discussing is not executed.

## Install

```bash
pi install ~/dev/pi-agent-extensions/packages/tool-call-recovery
```

Or try it without installing:

```bash
pi -e ~/dev/pi-agent-extensions/packages/tool-call-recovery
```

## Tests

```bash
node --experimental-strip-types packages/tool-call-recovery/test.ts
```