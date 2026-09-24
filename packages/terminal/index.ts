/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * pi-terminal - embedded and native terminals inside pi
 *
 * Toggle real PTY-backed terminal panes and zero-overhead native editors inside pi.
 * - First press: creates the session and shows it (optionally running a
 *   configured command inside it)
 * - Later presses: shows/hides or resumes/suspends the existing session (state is preserved)
 * - While a terminal has focus, its hotkey hides/suspends it and returns to pi;
 *   a different terminal's hotkey switches straight to that terminal
 *
 * Terminals and their hotkeys are configured in ~/.pi/agent/pi-terminal.json:
 *
 *   {
 *     "terminals": [
 *       { "key": "alt+t", "width": "100%", "height": "100%" },
 *       { "key": "alt+e", "command": "nvim", "name": "editor", "mode": "passthrough" }
 *     ]
 *   }
 *
 * Modes:
 * - "passthrough" (default for interactive editors like nvim/vim and heavy TUIs):
 *   Runs outside Pi's DOM/render tree directly on the host terminal with raw I/O.
 *   Eliminates 100% of the transcript re-rendering lag in long conversations.
 *   Pressing alt+e inside the editor suspends it and returns to Pi; pressing alt+e
 *   in Pi wakes it back up without losing open files, buffers, or undo trees.
 * - "overlay" (default for general shells):
 *   Runs in a persistent PTY rendered as a floating overlay pane. Hidden background
 *   tasks are throttled so they never trigger Pi chat transcript re-renders.
 *
 * Session Persistence:
 * - Terminals and editors survive /new, /resume, /fork, and /reload via a global
 *   state bridge, seamlessly reattaching to the active session.
 * - Clean teardown on quit: sends SIGHUP to the entire process group (letting editors
 *   flush buffers cleanly) and escalates to SIGKILL, preventing orphan leaks.
 */

import { execPath } from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { Terminal } from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { KeyId, TUI } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Configuration & Types
// ---------------------------------------------------------------------------

export interface TerminalEntry {
	id: string;
	key: string;
	/** Legacy aliases registered alongside the main key. */
	aliases: string[];
	/** Optional command run inside the terminal when it is first created. */
	command?: string;
	/** Human-readable label for notifications and status. */
	name: string;
	/** Raw byte sequences this key can arrive as (matched in handleInput). */
	raw: string[];
	/**
	 * Execution mode:
	 * - "overlay": persistent embedded PTY rendered in a Pi overlay pane.
	 * - "passthrough": runs directly on native terminal with raw I/O and zero lag.
	 *   Pressing the hotkey suspends it back to Pi; pressing it in Pi resumes it.
	 */
	mode: "overlay" | "passthrough";
	/** Overlay width percentage or cell count (defaults to "100%"). */
	width: string;
	/** Overlay height percentage or cell count (defaults to "100%"). */
	height: string;
}

interface OverlayHandleLike {
	focus(): void;
	unfocus(options?: { target?: unknown | null }): void;
	setHidden(hidden: boolean): void;
	hide(): void;
}

export interface OverlaySession {
	entry: TerminalEntry;
	term: Terminal;
	pty: IPty;
	pid: number;
	handle: OverlayHandleLike | null;
	done: (() => void) | null;
	visible: boolean;
	cols: number;
	rows: number;
	tui: TUI | null;
	prevShowHardwareCursor: boolean;
	startedAt: number;
	ptyDataDisposable?: { dispose(): void };
}

export interface PassthroughSession {
	entry: TerminalEntry;
	term: Terminal;
	pty: IPty;
	pid: number;
	paused: boolean;
	cwd: string;
	startedAt: number;
	detachResolver: (() => void) | null;
}

interface GlobalTerminalState {
	overlaySessions: Map<string, OverlaySession>;
	passthroughSessions: Map<string, PassthroughSession>;
	exitHookInstalled: boolean;
}

declare global {
	// eslint-disable-next-line no-var
	var __PI_TERMINAL_STATE__: GlobalTerminalState | undefined;
}

const globalState: GlobalTerminalState = (globalThis.__PI_TERMINAL_STATE__ ??= {
	overlaySessions: new Map(),
	passthroughSessions: new Map(),
	exitHookInstalled: false,
});

// ---------------------------------------------------------------------------
// Process Tree & Signal Hygiene
// ---------------------------------------------------------------------------

/** Get all recursive child process IDs of a given parent PID. */
function getChildPids(parentPid: number): number[] {
	try {
		const out = execFileSync("pgrep", ["-P", String(parentPid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const pids = out
			.trim()
			.split(/\s+/)
			.map(Number)
			.filter((n) => !Number.isNaN(n) && n > 0);
		const all: number[] = [...pids];
		for (const pid of pids) {
			all.push(...getChildPids(pid));
		}
		return all;
	} catch {
		return [];
	}
}

/** Get the foreground command name running under a given PID tree. */
function getForegroundProcess(pid: number): string | null {
	try {
		const children = getChildPids(pid);
		const targetPid = children.length > 0 ? children[children.length - 1]! : pid;
		const out = execFileSync("ps", ["-o", "comm=", "-p", String(targetPid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.split("/").pop() || out || null;
	} catch {
		return null;
	}
}

/** Gracefully kill a process group and all its descendant processes with escalation. */
async function killProcessTreeGraceful(pid: number): Promise<void> {
	const childPids = getChildPids(pid);

	// 1. Send SIGHUP to process group and individual descendants
	try {
		process.kill(-pid, "SIGHUP");
	} catch {
		try {
			process.kill(pid, "SIGHUP");
		} catch {}
	}
	for (const cPid of childPids) {
		try {
			process.kill(cPid, "SIGHUP");
		} catch {}
	}

	// 2. Allow brief grace period for editors/programs to flush buffers & clean up
	await new Promise((r) => setTimeout(r, 300));

	// 3. Escalate to SIGKILL for any remaining processes
	const remaining = getChildPids(pid);
	const toKill = [pid, ...remaining];
	try {
		process.kill(-pid, "SIGKILL");
	} catch {}
	for (const p of toKill) {
		try {
			process.kill(p, "SIGKILL");
		} catch {}
	}
}

/** Synchronous hard kill for process.on("exit") emergency cleanup. */
function killProcessTreeSync(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const cPid of getChildPids(pid)) {
		try {
			process.kill(cPid, "SIGKILL");
		} catch {}
	}
}

/** Kill all active sessions across both overlay and passthrough pools gracefully. */
async function killAllSessionsGraceful(): Promise<void> {
	const promises: Promise<void>[] = [];

	for (const s of globalState.overlaySessions.values()) {
		s.ptyDataDisposable?.dispose();
		s.ptyDataDisposable = undefined;
		s.tui?.setShowHardwareCursor(s.prevShowHardwareCursor);
		s.done = null;
		s.handle = null;
		promises.push(
			(async () => {
				await killProcessTreeGraceful(s.pid);
				try {
					s.pty.kill();
				} catch {}
				try {
					s.term.dispose();
				} catch {}
			})(),
		);
	}

	for (const ps of globalState.passthroughSessions.values()) {
		ps.detachResolver = null;
		promises.push(
			(async () => {
				await killProcessTreeGraceful(ps.pid);
				try {
					ps.pty.kill();
				} catch {}
				try {
					ps.term.dispose();
				} catch {}
			})(),
		);
	}

	await Promise.allSettled(promises);
}

/** Kill all sessions synchronously on process exit. */
function killAllSessionsSync(): void {
	for (const s of globalState.overlaySessions.values()) {
		killProcessTreeSync(s.pid);
		try {
			s.pty.kill();
		} catch {}
	}
	for (const ps of globalState.passthroughSessions.values()) {
		killProcessTreeSync(ps.pid);
		try {
			ps.pty.kill();
		} catch {}
	}
}

if (!globalState.exitHookInstalled) {
	globalState.exitHookInstalled = true;
	process.once("exit", () => {
		killAllSessionsSync();
	});
}

// ---------------------------------------------------------------------------
// Configuration Loading
// ---------------------------------------------------------------------------

/** Known interactive commands that benefit from native terminal passthrough mode. */
const INTERACTIVE_COMMANDS = new Set([
	"nvim",
	"vim",
	"vi",
	"nano",
	"emacs",
	"helix",
	"hx",
	"micro",
	"pico",
	"kak",
	"lazygit",
	"gitui",
	"tig",
	"ranger",
	"nnn",
	"yazi",
	"lf",
	"htop",
	"top",
	"btop",
]);

function isInteractiveCommand(command?: string): boolean {
	if (!command) return false;
	const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	const bin = firstWord.split("/").pop() ?? firstWord;
	return INTERACTIVE_COMMANDS.has(bin);
}

function parseDimension(dim: string | undefined, total: number, fallback: number): number {
	if (!dim) return fallback;
	const trimmed = dim.trim();
	if (trimmed.endsWith("%")) {
		const pct = Number.parseFloat(trimmed) / 100;
		if (!Number.isNaN(pct) && pct > 0 && pct <= 1) {
			return Math.max(4, Math.floor(total * pct));
		}
	}
	const num = Number.parseInt(trimmed, 10);
	if (!Number.isNaN(num) && num > 0) {
		return Math.min(total, Math.max(4, num));
	}
	return fallback;
}

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

function loadEntries(): TerminalEntry[] {
	let list:
		| Array<{
				key?: string;
				command?: string;
				name?: string;
				mode?: "overlay" | "passthrough" | "suspend";
				width?: string;
				height?: string;
		  }>
		| undefined;

	try {
		const configPath = join(homedir(), ".pi", "agent", "pi-terminal.json");
		if (existsSync(configPath)) {
			const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			if (Array.isArray(parsed)) list = parsed;
			else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { terminals?: unknown }).terminals)) {
				list = (
					parsed as {
						terminals: Array<{
							key?: string;
							command?: string;
							name?: string;
							mode?: "overlay" | "passthrough" | "suspend";
							width?: string;
							height?: string;
						}>;
					}
				).terminals;
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
		const rawMode = raw.mode?.toLowerCase();
		const mode: "overlay" | "passthrough" =
			rawMode === "passthrough" || rawMode === "suspend"
				? "passthrough"
				: rawMode === "overlay"
					? "overlay"
					: isInteractiveCommand(raw.command)
						? "passthrough"
						: "overlay";

		out.push({
			id: raw.name ?? raw.command ?? `terminal-${i + 1}`,
			key: raw.key,
			aliases: raw.key === "ctrl+/" ? ["ctrl+_"] : [],
			command: typeof raw.command === "string" && raw.command !== "" ? raw.command : undefined,
			name: label,
			raw: rawSequencesFor(raw.key),
			mode,
			width: raw.width ?? "100%",
			height: raw.height ?? "100%",
		});
	}
	if (out.length === 0) {
		out.push({
			id: "default",
			key: "ctrl+/",
			aliases: ["ctrl+_"],
			name: "Terminal",
			raw: ["\x1f"],
			mode: "overlay",
			width: "100%",
			height: "100%",
		});
	}
	return out;
}

function asKeyId(key: string): KeyId {
	return key as KeyId;
}

const entries = loadEntries();

function matchEntry(data: string): TerminalEntry | null {
	if (isKeyRelease(data)) return null;
	for (const entry of entries) {
		if (entry.raw.includes(data)) return entry;
		if (matchesKey(data, asKeyId(entry.key))) return entry;
		if (entry.aliases.some((alias) => matchesKey(data, asKeyId(alias)))) return entry;
	}
	return null;
}

function isDetachKey(data: string, entry: TerminalEntry): boolean {
	if (isKeyRelease(data)) return false;
	if (matchesKey(data, asKeyId(entry.key))) return true;
	if (entry.aliases.some((alias) => matchesKey(data, asKeyId(alias)))) return true;
	if (entry.raw.includes(data)) return true;
	if (matchesKey(data, "ctrl+z") || data === "\x1a") return true;
	return false;
}

const entryHandlers = new Map<string, (ctx: ExtensionContext) => Promise<void>>();

function desiredRows(tuiHeight: number, configuredHeight?: string): number {
	return parseDimension(configuredHeight, tuiHeight, tuiHeight);
}

// ---------------------------------------------------------------------------
// Kitty keyboard protocol -> legacy sequence translation
// ---------------------------------------------------------------------------

const FUNCTIONAL_LEGACY: Record<number, string> = {
	27: "\x1b",
	13: "\r",
	9: "\t",
	127: "\x7f",
	57344: "\x1b",
	57345: "\r",
	57346: "\t",
	57347: "\x7f",
};

const TILDE_KEYS: Record<number, string> = {
	57348: "2",
	57349: "3",
	57354: "5",
	57355: "6",
};

const ARROW_KEYS: Record<number, string> = {
	57350: "D",
	57351: "C",
	57352: "B",
	57353: "A",
};

const HOME_END: Record<number, string> = {
	57356: "H",
	57357: "F",
};

function kittyToLegacy(codepoint: number, mods: number): string | null {
	const shift = (mods & 1) !== 0;
	const alt = (mods & 2) !== 0;
	const ctrl = (mods & 4) !== 0;

	if (codepoint >= 57358 && codepoint <= 57363) return null;
	if (codepoint >= 57364 && codepoint <= 57398) {
		const f = codepoint - 57363;
		const legacyNum = f <= 5 ? f + 10 : f === 6 ? 16 : f + 10;
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
		return shift ? ch : null;
	}

	if (alt) return `\x1b${ch}`;
	return ch;
}

export function translateInput(data: string): string {
	return data.replace(
		/\x1b\[(\d+(?::\d+)*)(?:;(\d+(?::\d+)*))*u/g,
		(match, _codeStr: string, modsStr?: string) => {
			const parts = match.split(/[;u]/).filter((p) => p !== "");
			const code = Number.parseInt(parts[0]!.slice(2).split(":")[0]!, 10);
			if (Number.isNaN(code)) return match;
			const modsPart = parts.find((p, i) => i > 0 && !p.includes(":") && Number.parseInt(p, 10) > 1);
			const modsRaw = modsStr ?? modsPart ?? "1";
			const mods = Number.parseInt(String(modsRaw).split(":")[0]!, 10);
			if (Number.isNaN(mods)) return match;
			const eventType = (modsStr ?? modsRaw).toString().split(":")[1];
			if (eventType === "3") return "";

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

	if (!markerWritten && y === cursorY) {
		out += CURSOR_MARKER;
		markerWritten = true;
	}

	return out;
}

// ---------------------------------------------------------------------------
// Node-PTY spawn-helper self-healing
// ---------------------------------------------------------------------------

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
				chmodSync(helper, 0o755);
			} catch {}
			return;
		}
	}
}

function moduleSearchPaths(): string[] {
	const paths: string[] = [];
	try {
		const code = typeof __dirname !== "undefined";
		if (code && typeof __dirname === "string") {
			paths.push(join(__dirname, "node_modules", "node-pty"));
		}
	} catch {}
	paths.push(join(execPath, "..", "..", "lib", "node_modules", "node-pty"));
	for (const p of (process.env.NODE_PATH ?? "").split(delimiter)) {
		if (p) paths.push(join(p, "node-pty"));
	}
	return paths.filter((p) => !p.includes("\0"));
}

function pathJoin(...parts: string[]): string {
	return parts.join(sep);
}

// ---------------------------------------------------------------------------
// Overlay Session Management (Decoupled Model & View)
// ---------------------------------------------------------------------------

function createOverlaySession(ctx: ExtensionContext, entry: TerminalEntry): OverlaySession {
	ensureSpawnHelperExecutable();

	const shell = process.env.SHELL || "/bin/zsh";
	const cols = process.stdout.columns || 120;
	const rows = desiredRows(process.stdout.rows || 24, entry.height);

	const term = new Terminal({
		cols,
		rows,
		scrollback: 2000,
		allowProposedApi: true,
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

	if (entry.command) {
		pty.write(`${entry.command}\r`);
	}

	return {
		entry,
		term,
		pty,
		pid: pty.pid,
		handle: null,
		done: null,
		visible: false,
		cols,
		rows,
		tui: null,
		prevShowHardwareCursor: false,
		startedAt: Date.now(),
	};
}

function destroyOverlaySession(s: OverlaySession): void {
	s.ptyDataDisposable?.dispose();
	s.ptyDataDisposable = undefined;
	try {
		s.pty.kill();
	} catch {}
	s.term.dispose();
}

async function attachOverlayUI(ctx: ExtensionContext, s: OverlaySession): Promise<void> {
	await ctx.ui.custom(
		(tui, _theme, _keybindings, done) => {
			s.tui = tui;
			s.prevShowHardwareCursor = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(true);

			s.done = () => {
				s.ptyDataDisposable?.dispose();
				s.ptyDataDisposable = undefined;
				tui.setShowHardwareCursor(s.prevShowHardwareCursor);
				s.handle = null;
				s.tui = null;
				s.done = null;
				s.visible = false;
				done(undefined);
				updateFooterStatus(ctx);
			};

			// Throttled data listener: only requests Pi TUI render when visible!
			s.ptyDataDisposable?.dispose();
			s.ptyDataDisposable = s.pty.onData((data) => {
				s.term.write(data, () => {
					if (s.visible) {
						tui.requestRender();
					}
				});
			});

			return {
				focused: true,

				render(width: number): string[] {
					const rows = desiredRows(tui.terminal.rows, s.entry.height);
					if (width !== s.cols || rows !== s.rows) {
						try {
							s.term.resize(width, rows);
							s.pty.resize(width, rows);
						} catch {}
						s.cols = width;
						s.rows = rows;
					}

					const buf = s.term.buffer.active;
					const base = Math.max(0, Math.min(buf.viewportY, Math.max(0, buf.length - rows)));
					const targetCursorY = buf.baseY + buf.cursorY;
					const lines: string[] = [];
					for (let y = base; y < base + rows; y++) {
						lines.push(renderRow(s.term, y, buf.cursorX, targetCursorY));
					}
					return lines;
				},

				invalidate(): void {
					tui.requestRender(true);
				},

				handleInput(data: string): void {
					if (isKeyRelease(data)) {
						return;
					}
					const hit = matchEntry(data);
					if (hit) {
						if (hit.id === s.entry.id) {
							hideOverlayTerminal(s, ctx);
						} else {
							hideOverlayTerminal(s, ctx);
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
				width: (s.entry.width ?? "100%") as any,
				maxHeight: (s.entry.height ?? "100%") as any,
				anchor: "center",
			},
			onHandle: (handle) => {
				s.handle = handle as OverlayHandleLike;
				s.visible = true;
				updateFooterStatus(ctx);
			},
		},
	);
}

async function openOverlayTerminal(ctx: ExtensionContext, entry: TerminalEntry): Promise<void> {
	let s = globalState.overlaySessions.get(entry.id);
	if (!s) {
		s = createOverlaySession(ctx, entry);
		globalState.overlaySessions.set(entry.id, s);

		s.pty.onExit(({ exitCode }) => {
			if (globalState.overlaySessions.get(entry.id) === s) {
				globalState.overlaySessions.delete(entry.id);
				s.tui?.setShowHardwareCursor(s.prevShowHardwareCursor);
				s.done?.();
				destroyOverlaySession(s);
				ctx.ui.notify(`${s.entry.name} exited${exitCode !== 0 ? ` (code ${exitCode})` : ""}`, "info");
				updateFooterStatus(ctx);
			}
		});
	}

	await attachOverlayUI(ctx, s);
}

function hideOverlayTerminal(s: OverlaySession, ctx: ExtensionContext): void {
	s.visible = false;
	s.tui?.setShowHardwareCursor(s.prevShowHardwareCursor);
	s.handle?.setHidden(true);
	s.handle?.unfocus({ target: null });
	ctx.ui.notify(`${s.entry.name} hidden (${s.entry.key} to show)`, "info");
	updateFooterStatus(ctx);
}

// ---------------------------------------------------------------------------
// Native Passthrough Mode (Zero-Lag Persistent Editors & TUIs)
// ---------------------------------------------------------------------------

async function runPassthroughTerminal(ctx: ExtensionContext, entry: TerminalEntry): Promise<void> {
	let session = globalState.passthroughSessions.get(entry.id);

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		tui.stop();

		const cols = process.stdout.columns || 120;
		const rows = process.stdout.rows || 24;
		const isNewSession = !session;

		if (isNewSession) {
			ensureSpawnHelperExecutable();
			const shell = process.env.SHELL || "/bin/zsh";

			const term = new Terminal({
				cols,
				rows,
				scrollback: 2000,
				allowProposedApi: true,
			});

			const pty = spawn(shell, entry.command ? ["-c", entry.command] : [], {
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

			session = {
				entry,
				term,
				pty,
				pid: pty.pid,
				paused: false,
				cwd: ctx.cwd,
				startedAt: Date.now(),
				detachResolver: null,
			};
			globalState.passthroughSessions.set(entry.id, session);

			pty.onExit(({ exitCode }) => {
				if (globalState.passthroughSessions.get(entry.id) === session) {
					globalState.passthroughSessions.delete(entry.id);
					try {
						session?.term.dispose();
					} catch {}
					updateFooterStatus(ctx);
					ctx.ui.notify(`${entry.name} exited${exitCode !== 0 ? ` (code ${exitCode})` : ""}`, "info");
					session?.detachResolver?.();
				}
			});
		}

		let isAttached = true;

		// Listen to PTY data: always keep virtual terminal buffer updated;
		// pipe directly to stdout only while attached
		const dataDisposable = session!.pty.onData((data) => {
			session!.term.write(data);
			if (isAttached) {
				process.stdout.write(data);
			}
		});

		if (!isNewSession && session!.paused) {
			session!.paused = false;

			// Resize PTY and buffer to match current terminal window
			if (session!.term.cols !== cols || session!.term.rows !== rows) {
				try {
					session!.pty.resize(cols, rows);
					session!.term.resize(cols, rows);
				} catch {}
			}

			// Restore entire screen from virtual terminal buffer in one atomic write
			const buf = session!.term.buffer.active;
			const lines: string[] = [];
			const targetRows = Math.min(rows, buf.length);
			for (let y = 0; y < targetRows; y++) {
				lines.push(renderRow(session!.term, y, buf.cursorX, buf.cursorY).replaceAll(CURSOR_MARKER, ""));
			}
			process.stdout.write(
				"\x1b[?1049h\x1b[H" +
					lines.join("\r\n") +
					`\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H\x1b[?25h`,
			);
		} else {
			process.stdout.write("\x1b[?25h");
		}

		const resizeHandler = () => {
			const c = process.stdout.columns || 120;
			const r = process.stdout.rows || 24;
			try {
				session!.pty.resize(c, r);
				session!.term.resize(c, r);
			} catch {}
		};
		process.stdout.on("resize", resizeHandler);

		let cleanedUp = false;
		const cleanup = (shouldPause: boolean) => {
			if (cleanedUp) return;
			cleanedUp = true;
			isAttached = false;
			session!.detachResolver = null;

			process.stdout.off("resize", resizeHandler);
			process.stdin.off("data", stdinHandler);
			dataDisposable.dispose();

			try {
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false);
				}
				process.stdin.pause();
			} catch {}

			if (shouldPause && globalState.passthroughSessions.get(entry.id) === session) {
				session!.paused = true;
			}

			// Exit alternate screen buffer back to main screen for Pi's TUI
			process.stdout.write("\x1b[?1049l\x1b[?25h");
			tui.start();
			tui.requestRender(true);
			updateFooterStatus(ctx);
			done(undefined);
		};

		session!.detachResolver = () => cleanup(false);

		const attachedAt = Date.now();
		const COOLDOWN_MS = 350;

		const stdinHandler = (chunk: Buffer | string) => {
			const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");

			// Discard key release events (especially from Kitty keyboard protocol)
			if (isKeyRelease(str)) {
				return;
			}

			const isInitialCooldown = Date.now() - attachedAt < COOLDOWN_MS;

			const hit = matchEntry(str);
			if (hit) {
				if (isInitialCooldown) {
					// Swallowed initial hotkey release / repeat from launching
					return;
				}
				if (hit.id === entry.id) {
					cleanup(true);
				} else {
					cleanup(true);
					setTimeout(() => {
						void entryHandlers.get(hit.id)?.(ctx);
					}, 10);
				}
				return;
			}

			if (isDetachKey(str, entry)) {
				if (isInitialCooldown) {
					// Swallowed initial hotkey release / repeat from launching
					return;
				}
				cleanup(true);
				return;
			}

			session!.pty.write(str);
		};

		// Flush any pending data in stdin buffer before attaching listener
		try {
			while (process.stdin.read() !== null) {}
		} catch {}

		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();
		process.stdin.on("data", stdinHandler);

		updateFooterStatus(ctx);

		return { render: () => [], invalidate: () => {} };
	});
}

// ---------------------------------------------------------------------------
// Footer Status & Inspection Helpers
// ---------------------------------------------------------------------------

interface SessionInfo {
	id: string;
	name: string;
	mode: "overlay" | "passthrough";
	pid: number;
	state: "active" | "hidden" | "suspended";
	key: string;
	foregroundCommand: string | null;
}

function getAllSessionsInfo(): SessionInfo[] {
	const result: SessionInfo[] = [];

	for (const s of globalState.overlaySessions.values()) {
		result.push({
			id: s.entry.id,
			name: s.entry.name,
			mode: "overlay",
			pid: s.pid,
			state: s.visible ? "active" : "hidden",
			key: s.entry.key,
			foregroundCommand: getForegroundProcess(s.pid),
		});
	}

	for (const ps of globalState.passthroughSessions.values()) {
		result.push({
			id: ps.entry.id,
			name: ps.entry.name,
			mode: "passthrough",
			pid: ps.pid,
			state: ps.paused ? "suspended" : "active",
			key: ps.entry.key,
			foregroundCommand: getForegroundProcess(ps.pid),
		});
	}

	return result;
}

function findSessionId(query: string): string | null {
	const trimmed = query.trim().toLowerCase();
	for (const s of globalState.overlaySessions.values()) {
		if (
			s.entry.id.toLowerCase() === trimmed ||
			s.entry.name.toLowerCase() === trimmed ||
			String(s.pid) === trimmed
		) {
			return s.entry.id;
		}
	}
	for (const ps of globalState.passthroughSessions.values()) {
		if (
			ps.entry.id.toLowerCase() === trimmed ||
			ps.entry.name.toLowerCase() === trimmed ||
			String(ps.pid) === trimmed
		) {
			return ps.entry.id;
		}
	}
	return null;
}

function getFooterStatusText(): string | undefined {
	const parts: string[] = [];

	for (const ps of globalState.passthroughSessions.values()) {
		const stateStr = ps.paused ? "suspended" : "active";
		parts.push(`Editor: ${ps.entry.name} (${stateStr})`);
	}

	let overlayCount = 0;
	for (const os of globalState.overlaySessions.values()) {
		if (os.visible) overlayCount++;
	}
	const totalOverlays = globalState.overlaySessions.size;
	if (totalOverlays > 0) {
		parts.push(`Terminals: ${totalOverlays} (${overlayCount} visible)`);
	}

	if (parts.length === 0) return undefined;
	return parts.join(" | ");
}

function updateFooterStatus(ctx?: ExtensionContext): void {
	if (!ctx) return;
	const text = getFooterStatusText();
	ctx.ui.setStatus("terminal", text);
}

async function killSingleSession(id: string): Promise<boolean> {
	const os = globalState.overlaySessions.get(id);
	if (os) {
		globalState.overlaySessions.delete(id);
		os.ptyDataDisposable?.dispose();
		os.tui?.setShowHardwareCursor(os.prevShowHardwareCursor);
		os.done?.();
		await killProcessTreeGraceful(os.pid);
		destroyOverlaySession(os);
		return true;
	}

	const ps = globalState.passthroughSessions.get(id);
	if (ps) {
		globalState.passthroughSessions.delete(id);
		ps.detachResolver?.();
		await killProcessTreeGraceful(ps.pid);
		try {
			ps.pty.kill();
		} catch {}
		try {
			ps.term.dispose();
		} catch {}
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// /terminal Slash Command
// ---------------------------------------------------------------------------

async function listTerminals(ctx: ExtensionContext): Promise<void> {
	const allSessions = getAllSessionsInfo();
	if (allSessions.length === 0) {
		ctx.ui.notify("No active terminals or editors running", "info");
		return;
	}

	const lines = allSessions.map((info) => {
		const cmdStr = info.foregroundCommand ? ` (process: ${info.foregroundCommand})` : "";
		return `• ${info.name} [${info.mode}] - PID ${info.pid}${cmdStr} | ${info.state} | hotkey: ${info.key}`;
	});

	ctx.ui.notify(`Active sessions:\n${lines.join("\n")}`, "info");
}

async function killTerminalCommand(ctx: ExtensionContext, target: string): Promise<void> {
	if (!target) {
		ctx.ui.notify("Specify a terminal name, PID, or 'all' (e.g. /terminal kill editor)", "error");
		return;
	}

	if (target.toLowerCase() === "all") {
		const count = globalState.overlaySessions.size + globalState.passthroughSessions.size;
		await killAllSessionsGraceful();
		globalState.overlaySessions.clear();
		globalState.passthroughSessions.clear();
		updateFooterStatus(ctx);
		ctx.ui.notify(`Terminated ${count} session(s)`, "info");
		return;
	}

	const foundId = findSessionId(target);
	if (!foundId) {
		ctx.ui.notify(`No active terminal found matching "${target}"`, "error");
		return;
	}

	const success = await killSingleSession(foundId);
	updateFooterStatus(ctx);
	if (success) {
		ctx.ui.notify(`Terminated terminal "${foundId}"`, "info");
	} else {
		ctx.ui.notify(`Failed to terminate terminal "${foundId}"`, "error");
	}
}

async function restartTerminalCommand(ctx: ExtensionContext, target: string): Promise<void> {
	const foundId = findSessionId(target);
	const entry = entries.find((e) => e.id === (foundId ?? target) || e.name === target);
	if (!entry) {
		ctx.ui.notify(`No terminal configured matching "${target}"`, "error");
		return;
	}

	if (foundId) {
		await killSingleSession(foundId);
	}
	ctx.ui.notify(`Restarting "${entry.name}"...`, "info");
	await handler(ctx, entry);
}

async function focusTerminalCommand(ctx: ExtensionContext, target: string): Promise<void> {
	const foundId = findSessionId(target);
	const entry = entries.find((e) => e.id === (foundId ?? target) || e.name === target);
	if (!entry) {
		ctx.ui.notify(`No terminal found matching "${target}"`, "error");
		return;
	}
	await handler(ctx, entry);
}

async function showInteractiveTerminalMenu(ctx: ExtensionContext): Promise<void> {
	const allSessions = getAllSessionsInfo();

	if (allSessions.length === 0) {
		const configured = entries.map(
			(e) => `${e.name} (${e.key}) - ${e.command ? e.command : "Shell"} [${e.mode}]`,
		);
		if (configured.length === 0) {
			ctx.ui.notify("No configured terminals found", "info");
			return;
		}
		const selected = await ctx.ui.select("No active terminals. Launch a configured terminal:", configured);
		if (selected) {
			const idx = configured.indexOf(selected);
			const entry = entries[idx];
			if (entry) {
				await handler(ctx, entry);
			}
		}
		return;
	}

	const items = allSessions.map((info) => {
		const cmd = info.foregroundCommand ? ` [${info.foregroundCommand}]` : "";
		return `${info.name} (PID ${info.pid}, ${info.state})${cmd} - hotkey: ${info.key}`;
	});

	const selected = await ctx.ui.select("Select terminal or editor to manage:", items);
	if (!selected) return;

	const selectedIdx = items.indexOf(selected);
	const selectedSession = allSessions[selectedIdx];
	if (!selectedSession) return;

	const action = await ctx.ui.select(`Action for "${selectedSession.name}":`, [
		"Focus / Switch to",
		"Restart session",
		"Kill session",
	]);

	if (action === "Focus / Switch to") {
		await focusTerminalCommand(ctx, selectedSession.id);
	} else if (action === "Restart session") {
		await restartTerminalCommand(ctx, selectedSession.id);
	} else if (action === "Kill session") {
		await killTerminalCommand(ctx, selectedSession.id);
	}
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

async function handler(ctx: ExtensionContext, entry: TerminalEntry) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Terminal requires interactive mode", "error");
		return;
	}

	if (entry.mode === "passthrough") {
		await runPassthroughTerminal(ctx, entry);
		return;
	}

	const session = globalState.overlaySessions.get(entry.id);

	if (session && session.handle) {
		if (!session.visible) {
			session.visible = true;
			session.tui?.setShowHardwareCursor(true);
			session.handle.setHidden(false);
			session.handle.focus();
			updateFooterStatus(ctx);
			return;
		}
		hideOverlayTerminal(session, ctx);
		return;
	}

	await openOverlayTerminal(ctx, entry);
}

export default function (pi: ExtensionAPI) {
	for (const entry of entries) {
		entryHandlers.set(entry.id, (ctx) => handler(ctx, entry));
		const description = entry.command
			? entry.mode === "passthrough"
				? `Open ${entry.name} (${entry.command}) with zero-lag native passthrough`
				: `${entry.name} terminal (${entry.command})`
			: `Toggle embedded ${entry.name.toLowerCase()} terminal`;
		for (const key of [entry.key, ...entry.aliases]) {
			pi.registerShortcut(asKeyId(key), { description, handler: (ctx) => handler(ctx, entry) });
		}
	}

	pi.registerCommand("terminal", {
		description: "Manage background terminals and editors (/terminal [list|kill|restart|focus] <name>)",
		handler: async (args, ctx) => {
			const rawArgs = (args ?? "").trim();
			const [subcommand, ...rest] = rawArgs.split(/\s+/);
			const target = rest.join(" ").trim();

			if (!subcommand || subcommand === "") {
				await showInteractiveTerminalMenu(ctx);
				return;
			}

			switch (subcommand.toLowerCase()) {
				case "list":
				case "ls":
					await listTerminals(ctx);
					break;
				case "kill":
					await killTerminalCommand(ctx, target);
					break;
				case "restart":
					await restartTerminalCommand(ctx, target);
					break;
				case "focus":
				case "open":
					await focusTerminalCommand(ctx, target);
					break;
				default:
					if (findSessionId(subcommand)) {
						await focusTerminalCommand(ctx, subcommand);
					} else {
						ctx.ui.notify(
							`Unknown subcommand "${subcommand}". Usage: /terminal [list|kill|restart|focus]`,
							"error",
						);
					}
					break;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateFooterStatus(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") {
			await killAllSessionsGraceful();
			globalState.overlaySessions.clear();
			globalState.passthroughSessions.clear();
			return;
		}

		// Keep sessions alive across /new, /resume, /fork, /reload.
		// Detach TUI view handles so they can re-attach cleanly in the new session.
		for (const s of globalState.overlaySessions.values()) {
			s.ptyDataDisposable?.dispose();
			s.ptyDataDisposable = undefined;
			s.tui?.setShowHardwareCursor(s.prevShowHardwareCursor);
			s.handle = null;
			s.tui = null;
			s.done = null;
			s.visible = false;
		}
	});
}
