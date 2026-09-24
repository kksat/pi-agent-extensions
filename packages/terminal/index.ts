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
 *     "gracePeriodMs": 350,
 *     "terminals": [
 *       { "key": "alt+t", "width": "100%", "height": "100%" },
 *       { "key": "alt+e", "command": "nvim", "name": "editor", "mode": "passthrough", "gracePeriodMs": 350 }
 *     ]
 *   }
 *
 * Commands:
 * - /terminal: Manage terminals attached to the current session (interactive menu with [x] kill, [r] restart, [Enter/f] focus).
 * - /terminals: Manage all terminals across all sessions and folders globally.
 */

import { execPath } from "node:process";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { basename, delimiter, join, sep } from "node:path";
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
	/** Cooldown grace period (ms) to avoid immediately re-suspending on key repeat/release. */
	gracePeriodMs: number;
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
	sessionId: string;
	sessionName: string;
	cwd: string;
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
	sessionId: string;
	sessionName: string;
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

	await new Promise((r) => setTimeout(r, 300));

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
// Terminal State Normalization (Fixes Terminal Scrolling in Pi)
// ---------------------------------------------------------------------------

/**
 * Resets all terminal emulator modes after running an interactive TUI like Neovim.
 * Explicitly disables mouse tracking, bracketed paste, application cursor keys,
 * exits alternate screen buffer, and restores the cursor.
 */
function resetHostTerminalAfterPassthrough(): void {
	// 1. Disable all mouse tracking modes:
	// 1000: normal, 1002: button-event, 1003: any-event, 1006: SGR extended mode
	const disableMouse = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
	// 2. Disable bracketed paste
	const disableBracketedPaste = "\x1b[?2004l";
	// 3. Reset application cursor keys and keypad
	const resetCursorKeys = "\x1b[?1l\x1b>";
	// 4. Exit alternate screen back to normal screen buffer
	const exitAltScreen = "\x1b[?1049l";
	// 5. Ensure cursor is visible
	const showCursor = "\x1b[?25h";

	try {
		process.stdout.write(disableMouse + disableBracketedPaste + resetCursorKeys + exitAltScreen + showCursor);
	} catch {}
}

// ---------------------------------------------------------------------------
// Configuration Loading
// ---------------------------------------------------------------------------

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

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

let defaultGracePeriodMs = 350;

function loadEntries(): TerminalEntry[] {
	let list:
		| Array<{
				key?: string;
				command?: string;
				name?: string;
				mode?: "overlay" | "passthrough" | "suspend";
				width?: string;
				height?: string;
				gracePeriodMs?: number;
				cooldownMs?: number;
		  }>
		| undefined;

	try {
		const configPath = join(homedir(), ".pi", "agent", "pi-terminal.json");
		if (existsSync(configPath)) {
			const parsed: any = JSON.parse(readFileSync(configPath, "utf8"));
			if (typeof parsed?.gracePeriodMs === "number" && parsed.gracePeriodMs >= 0) {
				defaultGracePeriodMs = parsed.gracePeriodMs;
			} else if (typeof parsed?.cooldownMs === "number" && parsed.cooldownMs >= 0) {
				defaultGracePeriodMs = parsed.cooldownMs;
			}

			if (Array.isArray(parsed)) list = parsed;
			else if (parsed && typeof parsed === "object" && Array.isArray(parsed.terminals)) {
				list = parsed.terminals;
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

		const entryGrace = raw.gracePeriodMs ?? raw.cooldownMs ?? defaultGracePeriodMs;

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
			gracePeriodMs: entryGrace,
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
			gracePeriodMs: defaultGracePeriodMs,
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
			if (Number.isNaN(code)) return match;
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
		sessionId: ctx.sessionManager?.getSessionId?.() ?? "",
		sessionName: ctx.sessionManager?.getSessionName?.() || basename(ctx.cwd),
		cwd: ctx.cwd,
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

	if (s) {
		let isDead = false;
		if (!s.term || !s.pty) {
			isDead = true;
		} else {
			try {
				process.kill(s.pid, 0);
			} catch {
				isDead = true;
			}
		}

		if (isDead) {
			try {
				s.ptyDataDisposable?.dispose();
			} catch {}
			try {
				s.term?.dispose();
			} catch {}
			try {
				s.pty?.kill();
			} catch {}
			globalState.overlaySessions.delete(entry.id);
			s = undefined;
		}
	}

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

	if (session) {
		let isDead = false;
		if (!session.term || !session.pty) {
			isDead = true;
		} else {
			try {
				process.kill(session.pid, 0);
			} catch {
				isDead = true;
			}
		}

		if (isDead) {
			try {
				session.term?.dispose();
			} catch {}
			try {
				session.pty?.kill();
			} catch {}
			globalState.passthroughSessions.delete(entry.id);
			session = undefined;
		}
	}

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
				sessionId: ctx.sessionManager?.getSessionId?.() ?? "",
				sessionName: ctx.sessionManager?.getSessionName?.() || basename(ctx.cwd),
				detachResolver: null,
			};
			globalState.passthroughSessions.set(entry.id, session);

			pty.onExit(({ exitCode }) => {
				if (globalState.passthroughSessions.get(entry.id) === session) {
					globalState.passthroughSessions.delete(entry.id);
					try {
						session?.term.dispose();
					} catch {}
					resetHostTerminalAfterPassthrough();
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

			try {
				process.stdout.off("resize", resizeHandler);
			} catch {}
			try {
				process.stdin.off("data", stdinHandler);
			} catch {}
			try {
				dataDisposable.dispose();
			} catch {}

			try {
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false);
				}
				process.stdin.pause();
			} catch {}

			if (shouldPause && globalState.passthroughSessions.get(entry.id) === session) {
				session!.paused = true;
			}

			// FULL RESET OF TERMINAL: disable mouse tracking modes, exit alternate screen, restore cursor
			resetHostTerminalAfterPassthrough();

			try {
				tui.start();
				tui.requestRender(true);
			} catch {}

			updateFooterStatus(ctx);
			done(undefined);
		};

		session!.detachResolver = () => cleanup(false);

		const attachedAt = Date.now();
		const COOLDOWN_MS = entry.gracePeriodMs;

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
	sessionId: string;
	sessionName: string;
	cwd: string;
	startedAt: number;
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
			sessionId: s.sessionId || "",
			sessionName: s.sessionName || "unknown",
			cwd: s.cwd || "",
			startedAt: s.startedAt || 0,
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
			sessionId: ps.sessionId || "",
			sessionName: ps.sessionName || "unknown",
			cwd: ps.cwd || "",
			startedAt: ps.startedAt || 0,
		});
	}

	return result;
}

function findSessionId(query: string, pool?: SessionInfo[]): string | null {
	const trimmed = query.trim().toLowerCase();
	const list = pool ?? getAllSessionsInfo();
	for (const s of list) {
		if (
			s.id.toLowerCase() === trimmed ||
			s.name.toLowerCase() === trimmed ||
			String(s.pid) === trimmed
		) {
			return s.id;
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
	try {
		const text = getFooterStatusText();
		ctx.ui.setStatus("terminal", text);
	} catch {}
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
// /terminal and /terminals Commands & Interactive Menu
// ---------------------------------------------------------------------------

async function listTerminals(ctx: ExtensionContext, scope: "current" | "all"): Promise<void> {
	const currentSessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	const currentCwd = ctx.cwd ?? "";

	const allSessions = getAllSessionsInfo();
	const filtered =
		scope === "current"
			? allSessions.filter((s) => s.sessionId === currentSessionId || s.cwd === currentCwd)
			: allSessions;

	if (filtered.length === 0) {
		const scopeLabel = scope === "current" ? "this session" : "any session";
		ctx.ui.notify(`No active terminals or editors running in ${scopeLabel}`, "info");
		return;
	}

	const scopeTitle =
		scope === "current"
			? `Active terminals in current session (${ctx.sessionManager?.getSessionName?.() || shortenPath(ctx.cwd)}):`
			: "All active terminals across sessions:";

	const lines = filtered.map((info) => {
		const cmdStr = info.foregroundCommand ? ` [proc: ${info.foregroundCommand}]` : "";
		return `• ${info.name} [${info.mode}] (PID ${info.pid}${cmdStr}) | ${info.state} | Folder: ${shortenPath(info.cwd)} | Session: ${info.sessionName} | Key: ${info.key}`;
	});

	ctx.ui.notify(`${scopeTitle}\n${lines.join("\n")}`, "info");
}

async function killTerminalCommand(ctx: ExtensionContext, target: string, scope: "current" | "all"): Promise<void> {
	if (!target) {
		ctx.ui.notify("Specify a terminal name, PID, or 'all' (e.g. /terminal kill editor)", "error");
		return;
	}

	const currentSessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	const currentCwd = ctx.cwd ?? "";

	if (target.toLowerCase() === "all") {
		const allSessions = getAllSessionsInfo();
		const toKill =
			scope === "current"
				? allSessions.filter((s) => s.sessionId === currentSessionId || s.cwd === currentCwd)
				: allSessions;

		for (const s of toKill) {
			await killSingleSession(s.id);
		}
		updateFooterStatus(ctx);
		ctx.ui.notify(`Terminated ${toKill.length} session(s)`, "info");
		return;
	}

	const allSessions = getAllSessionsInfo();
	const pool =
		scope === "current"
			? allSessions.filter((s) => s.sessionId === currentSessionId || s.cwd === currentCwd)
			: allSessions;

	const foundId = findSessionId(target, pool);
	if (!foundId) {
		const scopeLabel = scope === "current" ? "in this session" : "globally";
		ctx.ui.notify(`No active terminal found matching "${target}" ${scopeLabel}`, "error");
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

interface MenuAction {
	action: "focus" | "restart" | "launch" | "close";
	id?: string;
}

async function showInteractiveTerminalMenu(ctx: ExtensionContext, scope: "current" | "all"): Promise<void> {
	let currentScope = scope;

	const currentSessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	const currentCwd = ctx.cwd ?? "";

	const getSessionsForScope = (s: "current" | "all") => {
		const all = getAllSessionsInfo();
		return s === "current"
			? all.filter((item) => item.sessionId === currentSessionId || item.cwd === currentCwd)
			: all;
	};

	const menuResult = await ctx.ui.custom<MenuAction>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		let activeList = getSessionsForScope(currentScope);

		const renderContent = (width: number): string[] => {
			const lines: string[] = [];
			const border = (str: string) => theme.fg("accent", str);
			const hr = border("─".repeat(Math.max(1, width)));

			lines.push(hr);
			const scopeLabel =
				currentScope === "current"
					? `Session Terminals [${ctx.sessionManager?.getSessionName?.() || shortenPath(ctx.cwd)}]`
					: "All Terminals (Global)";
			const scopeToggleHint = currentScope === "current" ? "Tab: view all sessions" : "Tab: view session only";
			lines.push(
				`  ${theme.bold(theme.fg("accent", scopeLabel))}  ${theme.fg("dim", `(${activeList.length} active)`)}  ${theme.fg("dim", `[${scopeToggleHint}]`)}`,
			);
			lines.push(hr);

			if (activeList.length === 0) {
				const scopeMsg =
					currentScope === "current"
						? "No active terminals attached to this session."
						: "No active terminals running globally.";
				lines.push(`  ${theme.fg("muted", scopeMsg)}`);
				lines.push(`  ${theme.fg("dim", "Configured terminals (press [1-9] or Enter to launch):")}`);
				lines.push("");
				for (let i = 0; i < entries.length; i++) {
					const e = entries[i];
					const isSelected = i === selectedIndex;
					const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
					const num = theme.fg("dim", `[${i + 1}]`);
					const namePart = theme.bold(e.name);
					const cmdPart = e.command ? theme.fg("muted", `(${e.command})`) : theme.fg("dim", "(shell)");
					const keyPart = theme.fg("dim", `key: ${e.key}`);
					lines.push(`  ${pointer}${num} ${namePart} ${cmdPart} [${e.mode}]  ${keyPart}`);
				}
				lines.push("");
				lines.push(hr);
				lines.push(
					`  ${theme.fg("accent", "[Enter/1-9]")} ${theme.fg("dim", "Launch")}  ` +
						`${theme.fg("accent", "[Tab]")} ${theme.fg("dim", "Toggle scope")}  ` +
						`${theme.fg("dim", "[Esc/q]")} ${theme.fg("dim", "Close")}`,
				);
				lines.push(hr);
			} else {
				for (let i = 0; i < activeList.length; i++) {
					const s = activeList[i];
					const isSelected = i === selectedIndex;
					const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
					const namePart = theme.bold(s.name);
					const modeBadge = theme.fg("dim", `[${s.mode}]`);
					const stateColor = s.state === "active" ? "success" : s.state === "suspended" ? "warning" : "muted";
					const stateBadge = theme.fg(stateColor, `(${s.state})`);
					const pidPart = theme.fg("dim", `PID: ${s.pid}`);
					const procPart = s.foregroundCommand ? theme.fg("accent", `[${s.foregroundCommand}]`) : "";

					const line1 = `  ${pointer}${namePart} ${modeBadge} ${stateBadge} ${pidPart} ${procPart}`;
					const folderStr = shortenPath(s.cwd);
					const line2 = `     ${theme.fg("muted", "Folder:")} ${folderStr}  ${theme.fg("muted", "Session:")} ${s.sessionName}  ${theme.fg("muted", "Key:")} ${s.key}`;

					lines.push(line1);
					lines.push(line2);
					if (i < activeList.length - 1) {
						lines.push("");
					}
				}

				lines.push(hr);
				lines.push(
					`  ${theme.fg("accent", "[Enter/f]")} ${theme.fg("dim", "Focus")}  ` +
						`${theme.fg("error", "[x]")} ${theme.fg("dim", "Kill")}  ` +
						`${theme.fg("warning", "[r]")} ${theme.fg("dim", "Restart")}  ` +
						`${theme.fg("accent", "[Tab]")} ${theme.fg("dim", "Toggle scope")}  ` +
						`${theme.fg("dim", "[Esc/q]")} ${theme.fg("dim", "Close")}`,
				);
				lines.push(hr);
			}

			return lines;
		};

		return {
			render(width: number) {
				return renderContent(width);
			},
			invalidate() {
				tui.requestRender(true);
			},
			handleInput(data: string) {
				if (matchesKey(data, "escape") || data === "q" || data === "Q") {
					done({ action: "close" });
					return;
				}
				if (matchesKey(data, "tab") || data === "\t") {
					currentScope = currentScope === "current" ? "all" : "current";
					activeList = getSessionsForScope(currentScope);
					selectedIndex = 0;
					tui.requestRender(true);
					return;
				}

				const maxItems = activeList.length > 0 ? activeList.length : entries.length;

				if (matchesKey(data, "up") || data === "k" || data === "K") {
					if (maxItems > 0) {
						selectedIndex = (selectedIndex - 1 + maxItems) % maxItems;
						tui.requestRender();
					}
					return;
				}
				if (matchesKey(data, "down") || data === "j" || data === "J") {
					if (maxItems > 0) {
						selectedIndex = (selectedIndex + 1) % maxItems;
						tui.requestRender();
					}
					return;
				}

				if (activeList.length === 0) {
					// Launch configured terminal via number or Enter
					const num = Number.parseInt(data, 10);
					if (!Number.isNaN(num) && num >= 1 && num <= entries.length) {
						done({ action: "launch", id: entries[num - 1]!.id });
						return;
					}
					if (matchesKey(data, "enter") || data === "f" || data === "F") {
						if (entries[selectedIndex]) {
							done({ action: "launch", id: entries[selectedIndex]!.id });
						}
						return;
					}
					return;
				}

				// Active terminals list actions
				if (matchesKey(data, "enter") || data === "f" || data === "F") {
					if (activeList[selectedIndex]) {
						done({ action: "focus", id: activeList[selectedIndex]!.id });
					}
					return;
				}
				if (data === "r" || data === "R") {
					if (activeList[selectedIndex]) {
						done({ action: "restart", id: activeList[selectedIndex]!.id });
					}
					return;
				}
				if (data === "x" || data === "X") {
					if (activeList[selectedIndex]) {
						const toKillId = activeList[selectedIndex]!.id;
						void killSingleSession(toKillId).then(() => {
							activeList = getSessionsForScope(currentScope);
							if (selectedIndex >= activeList.length) {
								selectedIndex = Math.max(0, activeList.length - 1);
							}
							tui.requestRender(true);
						});
					}
					return;
				}
			},
		};
	});

	if (menuResult.action === "close") {
		return;
	}
	if (menuResult.action === "focus" && menuResult.id) {
		await focusTerminalCommand(ctx, menuResult.id);
		return;
	}
	if (menuResult.action === "restart" && menuResult.id) {
		await restartTerminalCommand(ctx, menuResult.id);
		return;
	}
	if (menuResult.action === "launch" && menuResult.id) {
		const entry = entries.find((e) => e.id === menuResult.id);
		if (entry) {
			await handler(ctx, entry);
		}
		return;
	}
}

async function handleTerminalCommandRoute(
	args: string | undefined,
	ctx: ExtensionContext,
	scope: "current" | "all",
): Promise<void> {
	const rawArgs = (args ?? "").trim();
	const [subcommand, ...rest] = rawArgs.split(/\s+/);
	const target = rest.join(" ").trim();

	if (!subcommand || subcommand === "") {
		await showInteractiveTerminalMenu(ctx, scope);
		return;
	}

	switch (subcommand.toLowerCase()) {
		case "list":
		case "ls":
			await listTerminals(ctx, scope);
			break;
		case "kill":
			await killTerminalCommand(ctx, target, scope);
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
				const cmd = scope === "current" ? "/terminal" : "/terminals";
				ctx.ui.notify(
					`Unknown subcommand "${subcommand}". Usage: ${cmd} [list|kill|restart|focus]`,
					"error",
				);
			}
			break;
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
	const currentEntries = loadEntries();
	entries.length = 0;
	entries.push(...currentEntries);
	entryHandlers.clear();

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
		description: "Manage terminals in the current session (/terminal [list|kill|restart|focus] <name>)",
		handler: async (args, ctx) => {
			await handleTerminalCommandRoute(args, ctx, "current");
		},
	});

	pi.registerCommand("terminals", {
		description: "Manage all background terminals globally (/terminals [list|kill|restart|focus] <name>)",
		handler: async (args, ctx) => {
			await handleTerminalCommandRoute(args, ctx, "all");
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

		for (const s of globalState.overlaySessions.values()) {
			s.ptyDataDisposable?.dispose();
			s.ptyDataDisposable = undefined;
			s.tui?.setShowHardwareCursor(s.prevShowHardwareCursor);
			s.handle = null;
			s.tui = null;
			s.done = null;
			s.visible = false;
		}

		for (const ps of globalState.passthroughSessions.values()) {
			ps.detachResolver?.();
			ps.detachResolver = null;
			ps.paused = true;
		}
	});
}
