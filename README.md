# pi-agent-extensions

A collection of custom [pi](https://pi.dev) packages, each installable separately.

## Packages

| Package | Description |
|---|---|
| [`packages/cursor`](./packages/cursor) | Use Cursor subscription models via the `cursor-agent` CLI bridge |
| [`packages/worktree`](./packages/worktree) | Manage git worktrees with tmux-integrated pi agents |
| [`packages/open-current-folder`](./packages/open-current-folder) | Open the current folder in `$EDITOR` with Ctrl+E |

## Install

Clone the repo once, then install any package by its local path:

```bash
git clone https://github.com/kksat/pi-agent-extensions.git ~/dev/pi-agent-extensions

pi install ~/dev/pi-agent-extensions/packages/cursor
pi install ~/dev/pi-agent-extensions/packages/worktree
pi install ~/dev/pi-agent-extensions/packages/open-current-folder
```

Local path installs are not copied — edits to the files take effect on the next pi start (or `/reload`).

Try without installing:

```bash
pi -e ~/dev/pi-agent-extensions/packages/worktree
```
