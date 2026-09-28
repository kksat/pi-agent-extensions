# pi-agent-extensions

A collection of custom [pi](https://pi.dev) packages, each installable separately.

## Packages

| Package | Description |
|---|---|
| [`packages/worktree`](./packages/worktree) | Manage git worktrees with tmux-integrated pi agents |
| [`packages/terminal`](./packages/terminal) | Embedded PTY terminal pane toggled with Ctrl+/ |
| [`packages/vim`](./packages/vim) | Full-featured Vim modal editing for the prompt editor |
| [`packages/calm`](./packages/calm) | Calm mode: conversation-only transcript presentation with an animated working boat |
| [`packages/cmux-notify`](./packages/cmux-notify) | Notify cmux when a turn settles and the user needs to act |

## Install

Clone the repo once, then install any package by its local path:

```bash
git clone https://github.com/kksat/pi-agent-extensions.git ~/dev/pi-agent-extensions

pi install ~/dev/pi-agent-extensions/packages/worktree
pi install ~/dev/pi-agent-extensions/packages/terminal
pi install ~/dev/pi-agent-extensions/packages/vim
pi install ~/dev/pi-agent-extensions/packages/calm
pi install ~/dev/pi-agent-extensions/packages/cmux-notify
```

Local path installs are not copied — edits to the files take effect on the next pi start (or `/reload`).

Try without installing:

```bash
pi -e ~/dev/pi-agent-extensions/packages/worktree
```
