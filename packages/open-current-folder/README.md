# pi-extension-open-current-folder

A [pi](https://pi.dev) extension that opens the current folder in `$EDITOR` (Neovim by default) with **Ctrl+E** and clean terminal state management.

When you close the editor (`:q`, `:qa`, or `ZZ`), you return immediately to pi.

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/open-current-folder
```

Or from npm, if published:

```bash
pi install npm:pi-extension-open-current-folder
```

## Usage

Press **Ctrl+E** in a pi TUI session. Uses `$EDITOR` (falls back to `nvim`).
