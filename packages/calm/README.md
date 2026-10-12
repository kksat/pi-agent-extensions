# pi-extension-calm

A [pi](https://pi.dev) extension that adds **Calm mode**: a conversation-only transcript presentation, toggled with `/calm`.

While Calm is on, pi shows your prompts, the agent's final replies, and the working indicator. All tool calls and output — including subagents, built-ins, `codemode`, MCP, and other extensions — are hidden, along with thinking, intermediate narration, operational messages, summaries, and extension progress widgets/statuses. Required input dialogs, warnings/errors, and command confirmations remain visible. While an agent run is under way, the stock `Working...` row is replaced by one of 14 horizontal animations, each only one or two rows tall.

Nothing is deleted. Hidden content stays in the message, the model context, session storage, and `/export` artifacts — Calm changes presentation only.

## Behavior

- **Every tool row is hidden.** Calls, partial/completed output, images, and tool errors occupy zero rows, regardless of the tool's name or owner. This includes subagent start/check/wait/send calls and unfamiliar tools restored from a session. Toggling `/calm` applies to existing rows; turning it off restores them. Executors, nested calls, arguments, and stored results are unchanged.
- **Only genuine assistant replies.** Thinking stays hidden even when expanded. All tool-use narration is hidden, including long or multiline text. Genuine replies still stream; text is suppressed once the message contains a tool call or ends with `toolUse`. Abort, provider-error, and truncation notices remain visible even when the associated tool row is hidden.
- **Operational noise is hidden.** Custom extension messages/entries (including subagent kickoff prompts and status reports), user-bash output, skill bodies, compaction/branch summaries, cache notices, and extension progress widgets/footer statuses are hidden. Skill arguments supplied by you remain visible. Calm's working animation and explicitly requested `/calm-preview` remain visible.
- **Required interaction stays visible.** Input/confirmation dialogs, selectors, overlays, warnings/errors, and command confirmations such as an export's destination are not suppressed. Use `/calm` to inspect hidden operational details or other extensions' widgets.
- **Animated working scene.** Each run randomly chooses from the preferred sailboat, fish, duck, ball, spinner, progress bar, wave, butterfly, and cat, plus five new progress-style bars. Motion travels along the terminal's full width or forms a full-width texture; every working scene uses at most two rows. Scenes reflow on resize and disappear when the run settles, aborts, or fails. The next run starts a freshly chosen scene.
- **Operational input rows.** User rows recognized by the bundled Firstmate operational-input parser (session-start, watcher, turn-end guard, away-supervisor, launch-brief, branch-outcome, from-firstmate) render at zero height. Every other user row stays visible.
- **Export stays complete.** `/export` and `/share` temporarily render stock rows so exported artifacts contain everything.
- **Persistent preference.** The last `/calm` choice is stored in `~/.pi/agent/calm` and restored on the next start.

## Working scenes

Each agent run picks uniformly from **1, 2, 3, 9, 11, 12, 14, 17, 18, and 21–25**. The disliked original scenes remain in the preview catalogue for reference but never appear in the working rotation. All scenes share a 220 ms tick and paint only single-column glyphs in a fixed ANSI palette, so they never depend on the active theme. The original 1–20 catalogue order below stays unchanged.

| Scene | Description |
|---|---|
| `sailboat` | The original Firstmate sailboat on a rolling swell |
| `fish` | A fish swimming across with a wiggling tail |
| `duck` | A duck paddling along a water line |
| `clouds` | Two clouds drifting at different speeds |
| `stars` | A twinkling starfield |
| `moon` | A moon cycling through its phases |
| `rain` | Falling raindrops |
| `snow` | Drifting snowflakes |
| `ball` | A ball bouncing along the ground |
| `pendulum` | A pendulum swinging from a pivot |
| `spinner` | A brighter `[ ⠋ ]` marker spinning and sweeping across a full-width track (one row) |
| `progress` | An indeterminate progress bar |
| `pulse` | A pulsing dot |
| `wave` | A travelling sine wave |
| `rocket` | A rocket flying with a flickering flame |
| `balloon` | A balloon floating across |
| `butterfly` | A butterfly flapping its wings |
| `cat` | A walking cat with a swishing tail |
| `coffee` | A steaming cup |
| `windmill` | A rotating windmill |

### New progress animations

These five additions span the terminal width and use **exactly one row**. They loop
as activity indicators, with no percentage, ETA, or claim about task completion.
Numbers 1–20 are unchanged.

| Number | Scene | Motion |
|---|---|---|
| 21 | `scanner` | A broad cyan band with a bright center sweeps from edge to edge and back |
| 22 | `conveyor` | Green shaded stripes flow continuously across the whole bar |
| 23 | `comet` | A bright arrowhead travels with a long fading trail, wrapping at the edge |
| 24 | `segments` | Successive blocks light up across the entire track, with a short trailing highlight |
| 25 | `zipper` | Two bright fronts advance inward from both ends, then retreat |

The scanner, comet, segments, and zipper use width-scaled motion so a wide terminal
does not turn a traverse into a minute-long wait. Each bar keeps a visible full-width
track and reflows on resize without adding height.

## Commands

| Command | Description |
|---|---|
| `/calm` | Toggle Calm mode on or off |
| `/calm-preview` | Show the 14 working animations, preserving the original numbers |
| `/calm-preview progress` | Compare bar 12 and the five new progress variants, all at full width |
| `/calm-preview 21` | Show just the scanner across the full terminal width (any number 1–25 works) |
| `/calm-preview all` | Show all 25 catalogue entries, including the excluded originals |
| `/calm-preview off` | Hide the preview and stop its timer |

The preview uses the actual working scenes, colors, and 220 ms tick. It keeps running
while you type or chat, without changing your Calm preference. The compact gallery
fits up to five columns. Use `/calm-preview <number>` to judge horizontal movement at
its real full width instead of inside a gallery cell. A focused preferred scene uses
only three or four preview rows including its label and help line. Numbering follows
the original catalogue above, from **1: sailboat** to **20: windmill**, followed by
**21–25: the new progress bars**. Re-running the
command restarts the preview; leaving or reloading the session closes it.

After editing the extension, use `/reload`, then `/calm-preview` to see the changes.

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/calm
```

Or from npm, if published:

```bash
pi install npm:pi-extension-calm
```

## Compatibility

Calm probes the exact pi API seams it patches (assistant layout, operational-user rows, all-tool row rendering, and transcript/widget/status presentation) and degrades one adapter at a time with a console diagnostic if a future pi removes a seam — `/calm` and the rest of the extension keep working. The focused checks exercise Pi 1.1.0's real UI components.

Normally Calm does not register or claim any tool names: other extensions keep their executors, ownership, and custom renderers. If the all-tool render seam is unavailable, legacy built-in overrides provide a limited fallback, skipping names already owned by other extensions. Non-interactive execution and transcript storage are unchanged.

## Tests

The animation catalogue has a self-running check:

```bash
node --experimental-strip-types packages/calm/test.ts
```

With the host peer dependencies available, the presentation regression checks
exercise Pi's real tool, assistant, and transcript components, including toggles,
streaming/completed output, preserved prompts/failures, export rendering, widgets,
footer statuses, and reload-safe installation:

```bash
node --experimental-strip-types packages/calm/test-tool-layout.ts
node --experimental-strip-types packages/calm/test-assistant-layout.ts
node --experimental-strip-types packages/calm/test-transcript-layout.ts
node --experimental-strip-types packages/calm/test-extension.ts
```

## Provenance

Vendored from [Firstmate](https://github.com/kunchenguid/firstmate) at commit `2bcb88c38921030033a37d67ae4f5d82cea90eb4` (`.pi/extensions/fm-calm.ts` and its `lib/` dependencies). Firstmate is MIT licensed; see [`LICENSE.firstmate`](./LICENSE.firstmate). Local changes: the Calm preference is fixed at `~/.pi/agent/calm`, the operational-input helper is fixed at the bundled `./bin/fm-operational-input.sh`, and `lib/fm-calm-animations.ts` adds a numbered working-animation catalogue and curated rotation (the original sailboat is kept as one scene).