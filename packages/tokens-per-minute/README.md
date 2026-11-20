# tokens-per-minute

Shows your token rate in the pi bottom status bar.

Tracks assistant message usage over a rolling 60-second window and renders:

```
⚡ in 12.3k | out 456 tok/min
```

- `in` — uncached input tokens in the last minute (cache reads excluded, since they just reflect context re-reads)
- `out` — output tokens in the last minute
- The display refreshes every 2 seconds so the rate decays as samples age out

## Install

```bash
pi install ~/dev/pi-agent-extensions/packages/tokens-per-minute
```
