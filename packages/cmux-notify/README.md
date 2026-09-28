# pi-extension-cmux-notify

Notifies [cmux](https://cmux.com/docs/notifications) when a Pi turn has settled and is waiting for you.

Hooks `agent_settled` (not `agent_end`) and writes OSC 777 to `/dev/tty`. Inside tmux the sequence is wrapped for passthrough, so the ring lands on this pane.

## Requirements

In `~/.tmux.conf`, passthrough must include background panes, then restart the tmux server:

```tmux
set -g allow-passthrough all
```

## Install

Either load the file directly:

```bash
ln -sfn ~/dev/pi-agent-extensions/packages/cmux-notify/index.ts ~/.pi/agent/extensions/cmux-notify.ts
```

Or install the package (do not do both — Pi would notify twice):

```bash
pi install ~/dev/pi-agent-extensions/packages/cmux-notify
```

Restart Pi. When a turn finishes and nothing else is queued, cmux marks that surface.

Check it from a shell in the same tmux pane:

```bash
printf '\ePtmux;\e\e]777;notify;pi;Needs your input\a\e\\'
```

Outside tmux:

```bash
printf '\e]777;notify;pi;Needs your input\a'
```
