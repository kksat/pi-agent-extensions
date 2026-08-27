# pi-extension-vim

A full-featured Vim modal editing extension for [Pi](https://pi.dev/) prompt editor, inspired by `pi-vimmode`.

Replaces Pi's main input editor with an authentic, prompt-optimized Vim modal editor with hardware cursor morphing, prompt transforms, marks, macros, Ex commands, and seamless integration with Pi's autocomplete, image paste, and app keybindings.

## Features

- **Modes**: `NORMAL`, `INSERT`, `VISUAL` (char), `V-LINE` (linewise), `V-BLOCK` (rectangular block), `REPLACE`, `COMMAND` (`:`), `SEARCH` (`/`)
- **Motions**: `h`, `j`, `k`, `l`, `w`, `W`, `b`, `B`, `e`, `E`, `ge`, `gE`, `0`, `^`, `$`, `gg`, `G`, `f{c}`, `F{c}`, `t{c}`, `T{c}`, `;`, `,`, `%`, `{`, `}`, `H`, `M`, `L`, `Ctrl+D`, `Ctrl+U`, `Ctrl+F`, `Ctrl+B`
- **Text Objects**: `iw`, `aw`, `iW`, `aW`, `i"`, `a"`, `i'`, `a'`, `i\``, `a\``, `i(`, `a(`, `ib`, `ab`, `i[`, `a[`, `i{`, `a{`, `iB`, `aB`, `i<`, `a<`, `ip`, `ap`
- **Operators**: `d` (delete), `c` (change), `y` (yank), `>` (indent), `<` (unindent), `g~` (toggle case), `gu` (lowercase), `gU` (uppercase) + line doubling (`dd`, `cc`, `yy`, `>>`, `<<`)
- **Editing Actions**: `i`, `I`, `a`, `A`, `o`, `O`, `s`, `S`, `C`, `D`, `x`, `X`, `r{c}`, `R`, `~`, `J`, `p`, `P`, `u`, `Ctrl+R`, `.` (dot repeat)
- **Prompt-Native Ex Commands**:
  - `:%s/old/new/g` or `:s/old/new/g` — regex & string search and replace
  - `:quote` / `:unquote` — markdown blockquote toggle (`> ...`)
  - `:fence [lang]` — wrap prompt in markdown code fence (```` ```ts ````)
  - `:reflow [width]` — word wrap prompt text at specified width (default 80)
  - `:bullet` — convert lines to bullet list (`- ...`)
  - `:d` / `:delete`, `:y` / `:yank`, `:pu` / `:put`, `:j` / `:join`
  - `:noh` — clear search highlight
  - `:w` / `:submit` / `:x` — submit prompt to Pi
  - `:q` / `:quit`, `:q!`, `:c` / `:clear` — close or clear buffer
  - `:set vim` / `:set novim` — toggle modal editing
- **Marks & Macros**:
  - `m{a-z}` set mark, `'{a-z}` jump to mark line, `` `{a-z} `` jump to exact position
  - `q{a-z}` record macro, `q` stop, `@{a-z}` replay, `@@` repeat last macro
- **Hardware Cursor Morphing**: Steady Block in Normal, Steady Bar in Insert, Steady Underline in Replace
- **Fast Insert Exit**: `jk` or `jj` in Insert mode returns instantly to Normal mode with zero typing lag
- **Registers & Clipboard**: System clipboard sync via `"+` / `"*` or automatic sync
- **Pi Integration**:
  - `Enter` in Normal mode submits prompt
  - `Esc` in clean Normal mode delegates to Pi (for abort / tree navigation)
  - Pi slash-command (`/`) and symbol (`@`, `#`) autocomplete stays 100% functional
  - Toggle anytime via `/vim` or `/vimmode` slash command, or `Ctrl+Alt+V` shortcut

## Installation

### Local install:

```bash
pi install ~/dev/pi-agent-extensions/packages/vim
```

### Try without installing:

```bash
pi -e ~/dev/pi-agent-extensions/packages/vim
```

## Quick Reference

### Modes

| Mode | Trigger | Description |
|---|---|---|
| **NORMAL** | `Esc` or `Ctrl+[` or `jk`/`jj` | Navigation, operators, commands |
| **INSERT** | `i`, `I`, `a`, `A`, `o`, `O`, `s`, `S`, `C`, `c{motion}` | Standard text typing |
| **VISUAL** | `v` | Character-wise selection |
| **V-LINE** | `V` | Line-wise selection |
| **V-BLOCK** | `Ctrl+V` or `Alt+B` | Rectangular column selection |
| **REPLACE** | `R` | Overwrite text character by character |
| **SEARCH** | `/` (forward) or `?` (backward) | Search in prompt text (`n` / `N` to navigate) |
| **COMMAND** | `:` | Ex command-line mode |

### Motions & Navigation

| Motion | Action |
|---|---|
| `h` / `j` / `k` / `l` | Left, down, up, right |
| `w` / `W` | Next word / WORD start |
| `b` / `B` | Previous word / WORD start |
| `e` / `E` | Next word / WORD end |
| `ge` / `gE` | Previous word / WORD end |
| `0` / `^` / `$` | Start of line / First non-blank / End of line |
| `gg` / `G` | First line (or line `[N]gg`) / Last line (or line `[N]G`) |
| `f{c}` / `F{c}` | Find character `{c}` forward / backward on line |
| `t{c}` / `T{c}` | Till character `{c}` forward / backward on line |
| `;` / `,` | Repeat last find / Repeat in opposite direction |
| `%` | Jump to matching bracket `()`, `[]`, `{}`, `<>` |
| `{` / `}` | Jump to previous / next paragraph (blank line) |
| `H` / `M` / `L` | Top, middle, bottom of visible editor window |
| `Ctrl+D` / `Ctrl+U` | Half-page down / up |
| `Ctrl+F` / `Ctrl+B` | Page down / up |

### Text Objects (use with `d`, `c`, `y`, `v`)

| Text Object | Description |
|---|---|
| `iw` / `aw` | Inner word / A word (with whitespace) |
| `iW` / `aW` | Inner WORD / A WORD |
| `i"` / `a"` | Inside / around double quotes |
| `i'` / `a'` | Inside / around single quotes |
| `i\`` / `a\`` | Inside / around backticks |
| `i(` / `a(` or `ib` / `ab` | Inside / around parentheses `()` |
| `i[` / `a[` | Inside / around square brackets `[]` |
| `i{` / `a{` or `iB` / `aB` | Inside / around curly braces `{}` |
| `i<` / `a<` | Inside / around angle brackets `<>` |
| `ip` / `ap` | Inside / around paragraph |

### Ex Commands

Type `:` in Normal mode to access prompt-native commands:

| Command | Action |
|---|---|
| `:%s/old/new/g` | Replace all occurrences in buffer |
| `:s/old/new/g` | Replace all occurrences on current line |
| `:quote` / `:unquote` | Toggle Markdown quote (`> ...`) |
| `:fence [lang]` | Wrap in code block (e.g. `:fence ts`) |
| `:reflow [width]` | Word wrap lines at width (default 80) |
| `:bullet` | Format lines as markdown list (`- ...`) |
| `:d` / `:delete` | Delete line(s) |
| `:y` / `:yank` | Yank line(s) |
| `:pu` / `:put` | Paste line(s) below |
| `:j` / `:join` | Join lines with space |
| `:noh` | Clear search match highlight |
| `:w` / `:submit` / `:x` | Submit prompt to Pi |
| `:q` / `:quit`, `:q!`, `:c` | Exit or clear prompt buffer |
| `:set vim` / `:set novim` | Enable or disable Vim mode |
| `:help` / `:h` | Show help cheatsheet |

## Configuration

Configuration is automatically stored in `~/.pi/agent/vim.json`:

```json
{
  "enabled": true,
  "startMode": "normal",
  "enableJkEscape": true,
  "syncClipboard": true,
  "cursorShape": true,
  "showModeBadge": true,
  "showPosition": true
}
```

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable or disable Vim mode |
| `startMode` | `"normal"` | Initial mode for prompt editor (`"normal"` or `"insert"`) |
| `enableJkEscape` | `true` | Fast `jk` or `jj` exit from Insert to Normal mode |
| `syncClipboard` | `true` | Sync yanked text with system clipboard |
| `cursorShape` | `true` | Change terminal hardware cursor shape per mode |
| `showModeBadge` | `true` | Show mode indicator on editor border |
| `showPosition` | `true` | Show cursor line:col on editor border |

## Commands & Shortcuts

- `/vim` or `/vimmode`: Toggle Vim mode on/off
- `/vim on` / `/vim off`: Enable or disable
- `/vim status`: Show current configuration status
- `/vim help`: Display cheatsheet
- `Ctrl+Alt+V`: Keyboard shortcut to toggle Vim mode anytime

## License

GPL-3.0-only
