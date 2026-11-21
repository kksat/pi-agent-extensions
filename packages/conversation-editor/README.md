# conversation-editor

Open the whole conversation in an external editor for reading and copying,
with nicer navigation than terminal scrollback.

Press **ctrl+alt+g** (like the built-in ctrl+g, which edits only the prompt).
Pi suspends while the editor runs and resumes when it exits, exactly like the
built-in prompt editor. The conversation is exported as a Markdown temp file:

```markdown
# Pi conversation

### 👤 User · 14:32

what changed in the auth module?

### 🤖 Assistant · 14:32

- `bash` {"command": "git diff"}

#### ↳ bash · result

```
…
```
```

## Positioning

The document opens where the transcript is currently displayed:

- **Fullscreen mode**: the transcript scroll position is mapped to a document
  line, so the editor opens on the part of the conversation on screen.
- **Regular mode**: the conversation ends at the bottom of the terminal, so the
  document opens at the end.

Positioning is supported for vim/nvim/vi (`+N` plus `normal zz` to center),
nano, emacs, emacsclient (`+N`), and VS Code / Codium / Cursor (`-g file:line`,
with `--wait` added if missing). Other editors open at the top; search for
`pi-conversation-editor: current view` to jump to the anchored position, which
is always marked with an HTML comment (invisible in rendered Markdown).

## Notes

- Thinking blocks are skipped; tool results are truncated after 4000 chars
  (noted in the document).
- The export is a snapshot of the current branch, taken when the shortcut is
  pressed. Nothing is written back — closing the editor discards the file.
- Change the shortcut with the `PI_CONVERSATION_EDITOR_KEY` environment
  variable, e.g. `ctrl+shift+g`.

## Install

```bash
pi install ~/dev/pi-agent-extensions/packages/conversation-editor
```
