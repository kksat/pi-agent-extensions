# pi-extension-terminal

A [pi](https://pi.dev) extension that embeds a real PTY-backed terminal pane inside pi, toggled with **Ctrl+/**.

- First press: creates the terminal session and shows it
- Later presses: shows/hides the existing session (state is preserved)
- While the terminal has focus, **Ctrl+/** hides it and returns to pi

The terminal keeps running while hidden, so long-running commands keep going.
It only dies when you quit pi.

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/terminal
```

Or from npm, if published:

```bash
pi install npm:pi-extension-terminal
```

## Features

- Full VT emulation (`@xterm/headless` + `node-pty`) — full-screen apps like `vim` and `htop` work
- 256-color and truecolor output preserved
- Kitty keyboard protocol input is translated back to legacy sequences for the shell
- Live resize with the pane
- Session survives `/new`, `/resume`, `/fork`; killed on quit

## Usage

Press **Ctrl+/** in a pi TUI session. Uses `$SHELL` (falls back to `/bin/zsh`).

## Limitations

- Mouse events are not forwarded to programs running inside the pane
- Shifted-symbol edge cases under the Kitty protocol are best-effort

## License

GPL-3.0-only
