# pi-extension-tmux-attention

Prefixes the actual tmux window name with `● ` when Pi finishes a run and needs
input, or opens a blocking extension dialog.

Example: `wt:therapy` → `● wt:therapy`.

Works independently of cmux. It also complements the
[`cmux-notify`](../cmux-notify) package without changing its notifications. Since
the marker is part of the actual name, it appears in window pickers even when
the tmux status bar is disabled.

## Requirements

- Pi with `agent_settled`, `ui_prompt_start`, and `ui_prompt_end` extension events.
- tmux available on `PATH` (tested with tmux 3.5a).
- Node.js 22.19 or newer available at the same path used to run Pi.

Window selection clears markers without terminal focus detection. To also clear
on returning focus to the terminal, enable tmux focus events:

```tmux
set -g focus-events on
```

The outer terminal must support focus reporting. The extension does not change
this setting or enable the tmux status bar.

## Install

Clone the repository, then install this package by its local path:

```bash
git clone https://github.com/kksat/pi-agent-extensions.git ~/dev/pi-agent-extensions
pi install ~/dev/pi-agent-extensions/packages/tmux-attention
```

Alternatively, load it through a directory symlink:

```bash
ln -s ~/dev/pi-agent-extensions/packages/tmux-attention ~/.pi/agent/extensions/tmux-attention
```

Use only one installation method. If you already have a standalone copy in
`~/.pi/agent/extensions/tmux-attention`, move that copy out of the extensions
directory before installing the package to avoid loading it twice.

Run `/reload` in each already-running Pi session, or start a new one. The
extension is inactive outside interactive Pi sessions running inside tmux.

## Acknowledgement

The marker clears when:

- You select the window in tmux.
- You attach/switch a tmux client to its session or return terminal focus.
- Pi receives a terminal focus-in event or you submit interactive input.
- The dialog ends, Pi starts another run, or the extension shuts down/reloads.

Aborted runs do not create markers.

## Preservation and cleanup

The extension saves the window name and explicit/inherited `automatic-rename`
and `allow-rename` settings in a window-local `@pi_attention` option. Renaming is
paused while attention is pending and restored after acknowledgement. A manual
rename made while marked takes precedence over the saved name.

Each Pi process owns its pending attention. Normal cleanup by one process leaves
other pending owners in the same window intact; selecting the window acknowledges
all owners.

Four global tmux hooks use a reserved array slot (`777001`), preserving existing
hook entries. These hooks remain available after Pi exits, so selecting a window
can clear a marker left by an unexpected process exit. They launch the Node
helper only when the target window is marked; there is no polling process.

To change the symbol, edit `MARKER` in `tmux-attention.mjs` after clearing existing
markers, then `/reload`.

## Tests

```bash
cd ~/dev/pi-agent-extensions/packages/tmux-attention
npm test
```

Tests use an isolated tmux server and do not modify live sessions. They cover
selection/focus hooks, name and option preservation, multiple attention owners,
Pi lifecycle cleanup, aborted runs, and non-interactive sessions.

## License

GPL-3.0-only. See the repository's [LICENSE](../../LICENSE).
