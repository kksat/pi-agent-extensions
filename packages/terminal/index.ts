/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * pi-terminal - embedded terminals inside pi
 *
 * Toggle real PTY-backed terminal panes inside pi.
 * - First press: creates the terminal session and shows it (optionally
 *   running a configured command inside it)
 * - Later presses: shows/hides the existing session (state is preserved)
 * - While a terminal has focus, its hotkey hides it and returns to pi;
 *   a different terminal's hotkey switches straight to that terminal
 *
 * Terminals and their hotkeys are configured in ~/.pi/agent/pi-terminal.json:
 *
 *   {
 *     "terminals": [
 *       { "key": "ctrl+/" },
 *       { "key": "alt+e", "command": "nvim", "name": "editor" }
 *     ]
 *   }
 *
 * Each entry gets its own independent terminal session. If no config file
 * exists, a single plain terminal on ctrl+/ is provided.
 *
 * The terminals keep running while hidden, so long-running commands keep
 * going. They only die when you quit pi.
 *
 * Limitations: mouse events are not forwarded to programs running inside
 * the panes.
 */

import { execPath } from "node:process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { Terminal } from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface TerminalEntry {
	id: string;
	key: string;
	/** Legacy aliases registered alongside the main key (see below). */
	aliases: string[];
	/** Optional command run inside the terminal when it is first created. */
	command?: string;
	/** Human-readable label for notifications. */
	name: string;
	/** Raw byte sequences this key can arrive as (matched in handleInput). */
	raw: string[];
}

/**
 * Raw byte sequences a key binding can arrive as on non-Kitty terminals.
 * Only simple ctrl/alt + single-letter combos are covered; everything else
 * relies on matchesKey() alone.
 */
function rawSequencesFor(key: string): string[] {
	const parts = key.split("+");
	const base = parts[parts.length - 1];
	const out: string[] = [];
	if (base && base.length === 1 && /[a-z]/.test(base)) {
		if (parts.includes("ctrl") && !parts.includes("alt")) {
			out.push(String.fromCharCode(base.charCodeAt(0) - 0x60));
		}
		if (parts.includes("alt") && !parts.includes("ctrl")) {
			out.push(`\x1b${base}`);
		}
	}
	return out;
}

/** Load terminal entries from ~/.pi/agent/pi-terminal.json (or defaults). */
function loadEntries(): TerminalEntry[] {
	let list:
		| Array<{ key?: string; command?: string; name?: string }>
		| undefined;
	try {
		const configPath = join(homedir(), ".pi", "agent", "pi-terminal.json");
		if (existsSync(configPath)) {
			const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			if (Array.isArray(parsed)) list = parsed;
			else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { terminals?: unknown }).terminals)) {
				list = (parsed as { terminals: Array<{ key?: string; command?: string; name?: string }> }).terminals;
			}
		}
	} catch {
		// malformed config -> fall back to defaults
	}

	const source = list ?? [{ key: "ctrl+/" }];
	const out: TerminalEntry[] = [];
	for (const [i, raw] of source.entries()) {
		if (!raw || typeof raw.key !== "string" || raw.key === "") continue;
		const label = raw.name ?? raw.command ?? "Terminal";
		out.push({
			id: raw.name ?? raw.command ?? `terminal-${i + 1}`,
			key: raw.key,
			// On legacy (non-Kitty) terminals ctrl+/ sends byte 0x1f which
			// pi-tui parses as "ctrl+_", so we register/handle both.
			aliases: raw.key === "ctrl+/" ? ["ctrl+_"] : [],
			command: typeof raw.command === "string" && raw.command !== "" ? raw.command : undefined,
			name: label,
			raw: rawSequencesFor(raw.key),
		});
	}
	if (out.length === 0) {
		out.push({ id: "default", key: "ctrl+/", aliases: ["ctrl+_"], name: "Terminal", raw: ["\x1f"] });
	}
	return out;
}

/**
 * Cast a config-supplied key string to pi-tui's KeyId type. The runtime
 * accepts any "modifier+key" string; the union only exists for autocomplete.
 */
function asKeyId(key: string): KeyId {
	return key as KeyId;
}

const entries = loadEntries();

/** Which configured entry does this input chunk belong to, if any? */
function matchEntry(data: string): TerminalEntry | null {
	for (const entry of entries) {
		if (entry.raw.includes(data)) return entry;
		if (matchesKey(data, asKeyId(entry.key))) return entry;
		if (entry.aliases.some((alias) => matchesKey(data, asKeyId(alias)))) return entry;
	}
	return null;
}

interface OverlayHandleLike {
	focus(): void;
	unfocus(options?: { target?: unknown | null }): void;
	setHidden(hidden: boolean): void;
	hide(): void;
}

interface TerminalSession {
	entry: TerminalEntry;
	term: Terminal;
	pty: IPty;
	handle: OverlayHandleLike | null;
	done: (() => void) | null;
	visible: boolean;
	cols: number;
	rows: number;
}

const sessions = new Map<string, TerminalSession>();
/** Handlers per entry id, used to switch between terminals from handleInput. */
const entryHandlers = new Map<string, (ctx: ExtensionContext) => Promise<void>>();

function desiredRows(tuiHeight: number): number {
	// Fill the full height (minus a small margin for pi's own chrome)
	return Math.max(6, tuiHeight - 2);
}

// ---------------------------------------------------------------------------
// Kitty keyboard protocol -> legacy sequence translation
//
// When pi enables the Kitty keyboard protocol on the real terminal, raw
// CSI-u sequences reach handleInput(). Programs inside the PTY expect
// legacy sequences, so we translate before writing.
// ---------------------------------------------------------------------------

// Kitty reports these both as control codepoints (with disambiguate flag)
// and as 5734x functional codes depending on flags.
const FUNCTIONAL_LEGACY: Record<number, string> = {
	27: "\x1b", // escape
	13: "\r", // enter
	9: "\t", // tab
	127: "\x7f", // backspace
	57344: "\x1b",
	57345: "\r",
	57346: "\t",
	57347: "\x7f",
};

const TILDE_KEYS: Record<number, string> = {
	57348: "2", // insert
	57349: "3", // delete
	57354: "5", // page up
	57355: "6", // page down
};

const ARROW_KEYS: Record<number, string> = {
	57350: "D", // left
	57351: "C", // right
	57352: "B", // down
	57353: "A", // up
};

const HOME_END: Record<number, string> = {
	57356: "H", // home
	57357: "F", // end
};

/** Translate one parsed CSI-u sequence to its legacy equivalent, or null if not representable. */
function kittyToLegacy(codepoint: number, mods: number): string | null {
	const shift = (mods & 1) !== 0;
	const alt = (mods & 2) !== 0;
	const ctrl = (mods & 4) !== 0;

	if (codepoint >= 57358 && codepoint <= 57363) return null; // caps lock etc.
	if (codepoint >= 57364 && codepoint <= 57398) {
		// F1-F35 -> legacy \x1b[11~ .. \x1b[26~, \x1b[15;17~ style with mods
		const f = codepoint - 57363;
		const legacyNum = f <= 5 ? f + 10 : f === 6 ? 16 : f + 10; // rough mapping for F1..F12
		const n = Math.min(legacyNum, 24);
		return mods > 1 ? `\x1b[${n};${mods}~` : `\x1b[${n}~`;
	}

	const func = FUNCTIONAL_LEGACY[codepoint];
	if (func) return alt ? `\x1b${func}` : func;

	if (TILDE_KEYS[codepoint]) {
		const n = TILDE_KEYS[codepoint];
		return mods > 1 ? `\x1b[${n};${mods}~` : `\x1b[${n}~`;
	}

	const arrow = ARROW_KEYS[codepoint];
	if (arrow) {
		return mods > 1 ? `\x1b[1;${mods}${arrow}` : `\x1b[${arrow}`;
	}

	const he = HOME_END[codepoint];
	if (he) {
		return mods > 1 ? `\x1b[1;${mods}${he}` : `\x1b[${he}`;
	}

	if (codepoint < 32 || codepoint > 0x10ffff) return null;

	let ch = "";
	try {
		ch = String.fromCodePoint(codepoint);
	} catch {
		return null;
	}

	if (ctrl) {
		const lower = ch.toLowerCase();
		if (lower === "@") return "\x00";
		if (lower >= "a" && lower <= "z") {
			const seq = String.fromCharCode(lower.charCodeAt(0) - 0x60);
			return alt ? `\x1b${seq}` : seq;
		}
		if (ch === "/") return alt ? "\x1b\x1f" : "\x1f";
		if (ch === "_") return alt ? "\x1b\x1f" : "\x1f";
		if (ch === "[") return alt ? "\x1b\x1b" : "\x1b";
		if (ch === "\\") return "\x1c";
		if (ch === "]") return "\x1d";
		return shift ? ch : null; // best effort
	}

	if (alt) return `\x1b${ch}`;

	// Shifted symbol handling is left to the terminal's alternate-key report,
	// which we ignore; plain codepoint is the common case.
	return ch;
}

/**
 * Translate a chunk of possibly-Kitty-encoded input into legacy bytes for
 * the PTY. Non-CSI-u chunks pass through untouched.
 */
export function translateInput(data: string): string {
	// CSI <code(:sub)*> [;<mods(:sub)*>] u   (also handles multiple trailing params)
	return data.replace(
		/\x1b\[(\d+(?::\d+)*)(?:;(\d+(?::\d+)*))*u/g,
		(match, codeStr: string, modsStr?: string) => {
			const parts = match.split(/[;u]/).filter((p) => p !== "");
			// parts[0] starts with \x1b[
			const code = Number.parseInt(parts[0]!.slice(2).split(":")[0]!, 10);
			if (Number.isNaN(code)) return match;
			const modsPart = parts.find((p, i) => i > 0 && !p.includes(":") && Number.parseInt(p, 10) > 1);
			const modsRaw = modsStr ?? modsPart ?? "1";
			const mods = Number.parseInt(String(modsRaw).split(":")[0]!, 10);
			if (Number.isNaN(mods)) return match;
			// Release/repeat events carry event types; only forward presses (type absent or 1)
			const eventType = (modsStr ?? modsRaw).toString().split(":")[1];
			if (eventType === "3") return ""; // key release

			const translated = kittyToLegacy(code, mods);
			return translated ?? match;
		},
	);
}

// ---------------------------------------------------------------------------
// Buffer rendering: xterm headless buffer rows -> ANSI strings
// ---------------------------------------------------------------------------

export function renderRow(term: Terminal, y: number, cursorX: number, cursorY: number): string {
	const line = term.buffer.active.getLine(y);
	if (!line) return "";

	const cell: IBufferCell = term.buffer.active.getNullCell();
	let out = "";
	let currentSgr = "";
	let markerWritten = false;

	const sgrFor = (c: IBufferCell): string => {
		const parts: string[] = [];
		if (c.isBold()) parts.push("1");
		if (c.isDim()) parts.push("2");
		if (c.isItalic()) parts.push("3");
		if (c.isUnderline()) parts.push("4");
		if (c.isBlink()) parts.push("5");
		if (c.isInverse()) parts.push("7");
		if (c.isInvisible()) parts.push("8");
		if (c.isStrikethrough()) parts.push("9");

		if (c.isFgRGB()) {
			const color = c.getFgColor();
			parts.push(`38;2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`);
		} else if (c.isFgPalette()) {
			const n = c.getFgColor();
			parts.push(n < 8 ? `3${n}` : n < 16 ? `9${n - 8}` : `38;5;${n}`);
		}

		if (c.isBgRGB()) {
			const color = c.getBgColor();
			parts.push(`48;2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`);
		} else if (c.isBgPalette()) {
			const n = c.getBgColor();
			parts.push(n < 8 ? `4${n}` : n < 16 ? `10${n - 8}` : `48;5;${n}`);
		}

		const sgr = parts.length > 0 ? `\x1b[${parts.join(";")}m` : "\x1b[0m";
		if (sgr === currentSgr) return "";
		currentSgr = sgr;
		return sgr;
	};

	for (let x = 0; x < term.cols; ) {
		line.getCell(x, cell);
		const width = cell.getWidth();

		if (!markerWritten && y === cursorY && x === cursorX) {
			out += CURSOR_MARKER;
			markerWritten = true;
		}

		if (width === 0) {
			x++;
			continue;
		}

		out += sgrFor(cell);
		out += cell.getChars() || " ";
		x += width;
	}

	return out;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Locate node-pty's spawn-helper binary and make sure it is executable.
 * npm can strip the exec bit when install scripts are blocked, which makes
 * pty.spawn() fail with a cryptic "posix_spawnp failed.".
 */
export function ensureSpawnHelperExecutable(): void {
	const platformArch = `${process.platform}-${process.arch}`;
	const candidates = [
		pathJoin("prebuilds", platformArch, "spawn-helper"),
		pathJoin("build", "Release", "spawn-helper"),
	];

	for (const base of moduleSearchPaths()) {
		for (const rel of candidates) {
			const helper = join(base, rel);
			if (!existsSync(helper)) continue;
			try {
				chmodSync(helper, 0o755); // idempotent, cheap
			} catch {
				// best effort; spawn will report the real error if it persists
			}
			return;
		}
	}
}

/** Candidate directories that may contain the node-pty package. */
function moduleSearchPaths(): string[] {
	const paths: string[] = [];
	// Next to this extension file (works under jiti: __dirname is shimmed)
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const code = typeof __dirname !== "undefined";
		if (code && typeof __dirname === "string") {
			paths.push(join(__dirname, "node_modules", "node-pty"));
		}
	} catch {
		// no __dirname available
	}
	// Relative to the running node executable's default global layout
	paths.push(join(execPath, "..", "..", "lib", "node_modules", "node-pty"));
	// Anything on NODE_PATH
	for (const p of (process.env.NODE_PATH ?? "").split(delimiter)) {
		if (p) paths.push(join(p, "node-pty"));
	}
	return paths.filter((p) => !p.includes("\0"));
}

function pathJoin(...parts: string[]): string {
	return parts.join(sep);
}

function createSession(ctx: ExtensionContext, entry: TerminalEntry): TerminalSession {
	ensureSpawnHelperExecutable();

	const shell = process.env.SHELL || "/bin/zsh";
	const cols = 120;
	const rows = 24;

	const term = new Terminal({
		cols,
		rows,
		scrollback: 2000,
		allowProposedApi: true, // needed for buffer.getNullCell()
	});

	const pty = spawn(shell, [], {
		name: "xterm-256color",
		cols,
		rows,
		cwd: ctx.cwd,
		env: {
			...process.env,
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		},
	});

	return { entry, term, pty, handle: null, done: null, visible: false, cols, rows };
}

function destroySession(s: TerminalSession): void {
	try {
		s.pty.kill();
	} catch {
		// already dead
	}
	s.term.dispose();
}

async function openTerminal(ctx: ExtensionContext, entry: TerminalEntry): Promise<void> {
	const s = createSession(ctx, entry);
	sessions.set(entry.id, s);

	// Run the configured command (if any) once the shell is up. Input written
	// before the shell reads it is buffered by the tty line discipline.
	if (entry.command) {
		s.pty.write(`${entry.command}\r`);
	}

	await ctx.ui.custom(
		(tui, _theme, _keybindings, done) => {
			s.done = () => done(undefined);

			s.pty.onData((data) => {
				s.term.write(data, () => tui.requestRender());
			});
			s.pty.onExit(() => {
				if (sessions.get(entry.id) === s) {
					sessions.delete(entry.id);
					ctx.ui.notify(`${s.entry.name} exited`, "info");
					s.done?.();
				}
			});

			return {
				render(width: number): string[] {
					const rows = desiredRows(tui.terminal.rows);
					if (width !== s.cols || rows !== s.rows) {
						try {
							s.term.resize(width, rows);
							s.pty.resize(width, rows);
						} catch {
							// resize can race with writes; retry next render
						}
						s.cols = width;
						s.rows = rows;
					}

					const buf = s.term.buffer.active;
					const base = Math.max(0, Math.min(buf.viewportY, buf.length - rows));
					const lines: string[] = [];
					for (let y = base; y < base + rows; y++) {
						lines.push(renderRow(s.term, y, buf.cursorX, buf.cursorY));
					}
					return lines;
				},

				invalidate(): void {
					tui.requestRender(true);
				},

				handleInput(data: string): void {
					const hit = matchEntry(data);
					if (hit) {
						if (hit.id === entry.id) {
							// Same terminal's hotkey while focused -> hide it
							hideTerminal(s, ctx);
						} else {
							// Another terminal's hotkey -> hide this one and switch
							hideTerminal(s, ctx);
							setTimeout(() => {
								void entryHandlers.get(hit.id)?.(ctx);
							}, 0);
						}
						return;
					}
					s.pty.write(translateInput(data));
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "center",
			},
			onHandle: (handle) => {
				s.handle = handle as OverlayHandleLike;
				s.visible = true;
			},
		},
	);

	// done() fired (pty exited or shutdown): clean up remaining state
	if (sessions.get(entry.id) === s) {
		sessions.delete(entry.id);
		destroySession(s);
	}
}

function hideTerminal(s: TerminalSession, ctx: ExtensionContext): void {
	s.visible = false;
	s.handle?.setHidden(true);
	s.handle?.unfocus({ target: null });
	ctx.ui.notify(`${s.entry.name} hidden (${s.entry.key} to show)`, "info");
}

export default function (pi: ExtensionAPI) {
	async function handler(ctx: ExtensionContext, entry: TerminalEntry) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Terminal requires interactive mode", "error");
			return;
		}

		const session = sessions.get(entry.id);

		// Hidden but alive -> show it again
		if (session && !session.visible && session.handle) {
			session.visible = true;
			session.handle.setHidden(false);
			session.handle.focus();
			return;
		}

		// Visible shouldn't normally reach here (overlay captures input)
		if (session?.visible) {
			hideTerminal(session, ctx);
			return;
		}

		// No terminal yet -> create and show it, running any configured command
		await openTerminal(ctx, entry);
	}

	for (const entry of entries) {
		entryHandlers.set(entry.id, (ctx) => handler(ctx, entry));
		const description = entry.command
			? `${entry.name} terminal (${entry.command})`
			: `Toggle embedded ${entry.name.toLowerCase()} terminal`;
		for (const key of [entry.key, ...entry.aliases]) {
			pi.registerShortcut(asKeyId(key), { description, handler: (ctx) => handler(ctx, entry) });
		}
	}

	pi.on("session_shutdown", async (event) => {
		if (sessions.size === 0) return;
		// Keep the terminals across /new, /resume, /fork; kill them when quitting.
		if (event.reason !== "quit") return;
		const all = [...sessions.values()];
		sessions.clear();
		for (const s of all) {
			s.done = null; // don't resolve the custom UI during shutdown
			destroySession(s);
		}
	});
}
