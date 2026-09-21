# pi-agent-extensions

A collection of custom [pi](https://pi.dev) packages, each installable separately.

## Packages

| Package | Description |
|---|---|
| [`packages/cursor`](./packages/cursor) | Use Cursor subscription models via the `cursor-agent` CLI bridge |
| [`packages/worktree`](./packages/worktree) | Manage git worktrees with tmux-integrated pi agents |
| [`packages/terminal`](./packages/terminal) | Embedded PTY terminal pane toggled with Ctrl+/ |
| [`packages/vim`](./packages/vim) | Full-featured Vim modal editing for the prompt editor |
| [`packages/calm`](./packages/calm) | Calm mode: conversation-only transcript presentation with an animated working boat |
| [`packages/tool-call-recovery`](./packages/tool-call-recovery) | Recover pseudo-JSON tool fences that Grok and OpenAI-compatible proxies leak into the assistant text stream |

## Install

Clone the repo once, then install any package by its local path:

```bash
git clone https://github.com/kksat/pi-agent-extensions.git ~/dev/pi-agent-extensions

pi install ~/dev/pi-agent-extensions/packages/cursor
pi install ~/dev/pi-agent-extensions/packages/worktree
pi install ~/dev/pi-agent-extensions/packages/terminal
pi install ~/dev/pi-agent-extensions/packages/vim
pi install ~/dev/pi-agent-extensions/packages/calm
pi install ~/dev/pi-agent-extensions/packages/tool-call-recovery
```

Local path installs are not copied — edits to the files take effect on the next pi start (or `/reload`).

Try without installing:

```bash
pi -e ~/dev/pi-agent-extensions/packages/worktree
```
