/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * pi-vim - Full-featured Vim modal editing for the Pi prompt editor
 *
 * Inspired by pi-vimmode with extensive prompt-native capabilities:
 * - Modes: NORMAL, INSERT, VISUAL (char/line/block), REPLACE, COMMAND (:), SEARCH (/)
 * - Motions: h, j, k, l, w, W, b, B, e, E, ge, gE, 0, ^, $, gg, G, f, F, t, T, ;, ,, %, {, }, H, M, L
 * - Text Objects: iw, aw, iW, aW, i", a", i', a', i`, a`, i(, a(, i[, a[, i{, a{, i<, a<, ip, ap
 * - Operators: d, c, y, >, <, =, g~, gu, gU with doubling (dd, cc, yy, >>, <<)
 * - Editing: i, I, a, A, o, O, s, S, C, D, x, X, r, R, ~, J, p, P, u, Ctrl+R, . (dot repeat)
 * - Ex Commands:
 *     :%s/old/new/g, :s/old/new/g (regex/string substitution)
 *     :d / :delete, :y / :yank, :pu / :put, :m / :move, :t / :copy, :j / :join
 *     :quote, :unquote, :fence [lang], :reflow [width], :bullet
 *     :w / :submit, :q / :quit, :q!, :c / :clear, :noh, :set vim / novim, :help
 * - Search: /pattern, ?pattern, n, N, :noh to clear highlight
 * - Marks: m{a-z}, '{a-z}, `{a-z}
 * - Macros: q{a-z}, q (stop), @{a-z}, @@
 * - Hardware cursor styling: Block in Normal, Bar in Insert, Underline in Replace
 * - Fast exit: jk or jj in Insert mode switches instantly to Normal mode
 * - Custom bottom border with mode badges, pending keys, and cursor positions
 * - System clipboard sync via "+ / "* registers or automatic sync
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types & Configuration
// ---------------------------------------------------------------------------

export type VimMode =
	| "normal"
	| "insert"
	| "visual"
	| "visual_line"
	| "visual_block"
	| "replace"
	| "command"
	| "search";

export interface Position {
	line: number;
	col: number;
}

export interface Range {
	start: Position;
	end: Position;
	linewise?: boolean;
	block?: boolean;
	inclusive?: boolean;
}

export interface CharFind {
	char: string;
	forward: boolean;
	till: boolean;
}

export interface RegisterEntry {
	text: string;
	linewise: boolean;
	block?: boolean;
}

export interface VimConfig {
	enabled?: boolean;
	startMode?: "normal" | "insert";
	enableJkEscape?: boolean;
	syncClipboard?: boolean;
	cursorShape?: boolean;
	showModeBadge?: boolean;
	showPosition?: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "vim.json");

function loadConfig(): VimConfig {
	const defaults: VimConfig = {
		enabled: true,
		startMode: "normal",
		enableJkEscape: true,
		syncClipboard: true,
		cursorShape: true,
		showModeBadge: true,
		showPosition: true,
	};
	try {
		if (existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return { ...defaults, ...parsed };
		}
	} catch {
		// fallback to defaults
	}
	return defaults;
}

function saveConfig(cfg: VimConfig): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Terminal Hardware Cursor Shapes
// ---------------------------------------------------------------------------

function setTerminalCursorShape(mode: VimMode, enabled = true): void {
	if (!enabled || !process.stdout.isTTY) return;
	try {
		if (mode === "insert") {
			process.stdout.write("\x1b[6 q"); // Steady bar
		} else if (mode === "replace") {
			process.stdout.write("\x1b[4 q"); // Steady underline
		} else {
			process.stdout.write("\x1b[2 q"); // Steady block
		}
	} catch {
		// ignore
	}
}

function resetTerminalCursorShape(): void {
	if (!process.stdout.isTTY) return;
	try {
		process.stdout.write("\x1b[0 q"); // Reset to default
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Text & Motion Utilities
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function isWordChar(ch: string): boolean {
	return /[a-zA-Z0-9_]/.test(ch);
}

function getCharType(ch: string, isBigWord: boolean): "ws" | "word" | "punct" {
	if (!ch || isWhitespace(ch)) return "ws";
	if (isBigWord) return "word";
	return isWordChar(ch) ? "word" : "punct";
}

function comparePositions(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.col - b.col;
}

function findWordForward(
	lines: string[],
	pos: Position,
	count = 1,
	isBigWord = false,
): Position {
	let { line, col } = pos;
	for (let c = 0; c < count; c++) {
		if (line >= lines.length) break;
		const curLine = lines[line] || "";
		const startType = getCharType(curLine[col] || "", isBigWord);

		if (startType !== "ws") {
			while (
				col < curLine.length &&
				getCharType(curLine[col] || "", isBigWord) === startType
			) {
				col++;
			}
		}

		while (line < lines.length) {
			const lText = lines[line] || "";
			if (col >= lText.length) {
				line++;
				col = 0;
				if (line < lines.length && lines[line]!.length === 0) {
					break; // Empty line counts as word
				}
				continue;
			}
			if (getCharType(lText[col] || "", isBigWord) !== "ws") {
				break;
			}
			col++;
		}
	}
	if (line >= lines.length) {
		line = Math.max(0, lines.length - 1);
		col = Math.max(0, (lines[line] || "").length - 1);
	}
	return { line, col };
}

function findWordEnd(
	lines: string[],
	pos: Position,
	count = 1,
	isBigWord = false,
): Position {
	let { line, col } = pos;
	for (let c = 0; c < count; c++) {
		col++;
		while (line < lines.length) {
			const curLine = lines[line] || "";
			if (col >= curLine.length) {
				line++;
				col = 0;
				if (line >= lines.length) {
					line = Math.max(0, lines.length - 1);
					col = Math.max(0, (lines[line] || "").length - 1);
					return { line, col };
				}
				if (lines[line]!.length === 0) {
					col = 0;
					break;
				}
				continue;
			}
			if (getCharType(curLine[col] || "", isBigWord) !== "ws") {
				break;
			}
			col++;
		}
		const curLine = lines[line] || "";
		const type = getCharType(curLine[col] || "", isBigWord);
		if (type !== "ws") {
			while (
				col + 1 < curLine.length &&
				getCharType(curLine[col + 1] || "", isBigWord) === type
			) {
				col++;
			}
		}
	}
	return { line, col };
}

function findWordBackward(
	lines: string[],
	pos: Position,
	count = 1,
	isBigWord = false,
): Position {
	let { line, col } = pos;
	for (let c = 0; c < count; c++) {
		col--;
		while (line >= 0) {
			const curLine = lines[line] || "";
			if (col < 0) {
				line--;
				if (line < 0) {
					line = 0;
					col = 0;
					return { line, col };
				}
				col = lines[line]!.length - 1;
				if (lines[line]!.length === 0) {
					col = 0;
					break;
				}
				continue;
			}
			if (getCharType(curLine[col] || "", isBigWord) !== "ws") {
				break;
			}
			col--;
		}
		const curLine = lines[line] || "";
		const type = getCharType(curLine[col] || "", isBigWord);
		if (type !== "ws") {
			while (col > 0 && getCharType(curLine[col - 1] || "", isBigWord) === type) {
				col--;
			}
		}
	}
	return { line: Math.max(0, line), col: Math.max(0, col) };
}

function findWordEndBackward(
	lines: string[],
	pos: Position,
	count = 1,
	isBigWord = false,
): Position {
	let { line, col } = pos;
	for (let c = 0; c < count; c++) {
		col--;
		while (line >= 0) {
			if (col < 0) {
				line--;
				if (line < 0) {
					line = 0;
					col = 0;
					return { line, col };
				}
				col = Math.max(0, lines[line]!.length - 1);
				if (lines[line]!.length === 0) break;
				continue;
			}
			if (getCharType((lines[line] || "")[col] || "", isBigWord) !== "ws") {
				break;
			}
			col--;
		}
	}
	return { line: Math.max(0, line), col: Math.max(0, col) };
}

function findFirstNonBlank(lines: string[], line: number): number {
	const text = lines[line] || "";
	for (let i = 0; i < text.length; i++) {
		if (!isWhitespace(text[i]!)) return i;
	}
	return 0;
}

function findMatchingBracket(lines: string[], pos: Position): Position | null {
	const pairs: Record<string, string> = {
		"(": ")",
		")": "(",
		"[": "]",
		"]": "[",
		"{": "}",
		"}": "{",
		"<": ">",
		">": "<",
	};
	const lineText = lines[pos.line] || "";
	let startCol = pos.col;
	let bracket = lineText[startCol] || "";

	if (!(bracket in pairs)) {
		for (let i = startCol + 1; i < lineText.length; i++) {
			if (lineText[i]! in pairs) {
				startCol = i;
				bracket = lineText[i]!;
				break;
			}
		}
	}
	if (!(bracket in pairs)) return null;

	const target = pairs[bracket]!;
	const isOpen = bracket === "(" || bracket === "[" || bracket === "{" || bracket === "<";
	const dir = isOpen ? 1 : -1;
	let depth = 1;

	let l = pos.line;
	let c = startCol + dir;

	while (l >= 0 && l < lines.length) {
		const curLine = lines[l] || "";
		while (c >= 0 && c < curLine.length) {
			const ch = curLine[c];
			if (ch === bracket) depth++;
			else if (ch === target) {
				depth--;
				if (depth === 0) return { line: l, col: c };
			}
			c += dir;
		}
		l += dir;
		if (l >= 0 && l < lines.length) {
			c = dir === 1 ? 0 : Math.max(0, lines[l]!.length - 1);
		}
	}
	return null;
}

function findParagraph(
	lines: string[],
	pos: Position,
	direction: 1 | -1,
	count = 1,
): Position {
	let line = pos.line;
	for (let c = 0; c < count; c++) {
		line += direction;
		while (line >= 0 && line < lines.length) {
			const isBlank = (lines[line] || "").trim().length === 0;
			if (isBlank) break;
			line += direction;
		}
	}
	line = Math.max(0, Math.min(line, lines.length - 1));
	return { line, col: 0 };
}

// ---------------------------------------------------------------------------
// Text Objects
// ---------------------------------------------------------------------------

function findTextObjectWord(
	lines: string[],
	pos: Position,
	around: boolean,
	isBigWord = false,
): Range {
	const lineText = lines[pos.line] || "";
	if (lineText.length === 0) {
		return { start: pos, end: pos, inclusive: true };
	}
	const col = Math.min(pos.col, Math.max(0, lineText.length - 1));
	const type = getCharType(lineText[col] || "", isBigWord);

	let startCol = col;
	while (startCol > 0 && getCharType(lineText[startCol - 1] || "", isBigWord) === type) {
		startCol--;
	}

	let endCol = col;
	while (
		endCol + 1 < lineText.length &&
		getCharType(lineText[endCol + 1] || "", isBigWord) === type
	) {
		endCol++;
	}

	if (around && type !== "ws") {
		if (endCol + 1 < lineText.length && isWhitespace(lineText[endCol + 1]!)) {
			while (endCol + 1 < lineText.length && isWhitespace(lineText[endCol + 1]!)) {
				endCol++;
			}
		} else if (startCol > 0 && isWhitespace(lineText[startCol - 1]!)) {
			while (startCol > 0 && isWhitespace(lineText[startCol - 1]!)) {
				startCol--;
			}
		}
	}

	return {
		start: { line: pos.line, col: startCol },
		end: { line: pos.line, col: endCol },
		inclusive: true,
	};
}

function findTextObjectQuote(
	lines: string[],
	pos: Position,
	quoteChar: string,
	around: boolean,
): Range | null {
	const lineText = lines[pos.line] || "";
	const quoteIndices: number[] = [];
	for (let i = 0; i < lineText.length; i++) {
		if (lineText[i] === quoteChar && (i === 0 || lineText[i - 1] !== "\\")) {
			quoteIndices.push(i);
		}
	}

	for (let i = 0; i < quoteIndices.length - 1; i += 2) {
		const q1 = quoteIndices[i]!;
		const q2 = quoteIndices[i + 1]!;
		if (pos.col >= q1 && pos.col <= q2) {
			if (around) {
				return {
					start: { line: pos.line, col: q1 },
					end: { line: pos.line, col: q2 },
					inclusive: true,
				};
			} else {
				return {
					start: { line: pos.line, col: q1 + 1 },
					end: { line: pos.line, col: Math.max(q1, q2 - 1) },
					inclusive: true,
				};
			}
		}
	}
	if (quoteIndices.length >= 2 && pos.col < quoteIndices[0]!) {
		const q1 = quoteIndices[0]!;
		const q2 = quoteIndices[1]!;
		if (around) {
			return {
				start: { line: pos.line, col: q1 },
				end: { line: pos.line, col: q2 },
				inclusive: true,
			};
		} else {
			return {
				start: { line: pos.line, col: q1 + 1 },
				end: { line: pos.line, col: Math.max(q1, q2 - 1) },
				inclusive: true,
			};
		}
	}
	return null;
}

function findTextObjectBracket(
	lines: string[],
	pos: Position,
	openChar: string,
	closeChar: string,
	around: boolean,
): Range | null {
	let depth = 0;
	let openPos: Position | null = null;

	for (let l = pos.line; l >= 0; l--) {
		const line = lines[l] || "";
		const startC = l === pos.line ? Math.min(pos.col, line.length - 1) : line.length - 1;
		for (let c = startC; c >= 0; c--) {
			const ch = line[c];
			if (ch === closeChar && !(l === pos.line && c === pos.col)) {
				depth++;
			} else if (ch === openChar) {
				if (depth === 0) {
					openPos = { line: l, col: c };
					break;
				} else {
					depth--;
				}
			}
		}
		if (openPos) break;
	}

	if (!openPos) return null;

	depth = 1;
	let closePos: Position | null = null;
	for (let l = openPos.line; l < lines.length; l++) {
		const line = lines[l] || "";
		const startC = l === openPos.line ? openPos.col + 1 : 0;
		for (let c = startC; c < line.length; c++) {
			const ch = line[c];
			if (ch === openChar) {
				depth++;
			} else if (ch === closeChar) {
				depth--;
				if (depth === 0) {
					closePos = { line: l, col: c };
					break;
				}
			}
		}
		if (closePos) break;
	}

	if (!closePos) return null;

	if (around) {
		return { start: openPos, end: closePos, inclusive: true };
	} else {
		return {
			start: { line: openPos.line, col: openPos.col + 1 },
			end: { line: closePos.line, col: Math.max(0, closePos.col - 1) },
			inclusive: true,
		};
	}
}

function findTextObjectParagraph(lines: string[], pos: Position, around: boolean): Range {
	let startLine = pos.line;
	while (startLine > 0 && (lines[startLine - 1] || "").trim().length > 0) {
		startLine--;
	}

	let endLine = pos.line;
	while (endLine < lines.length - 1 && (lines[endLine + 1] || "").trim().length > 0) {
		endLine++;
	}

	if (around && endLine < lines.length - 1 && (lines[endLine + 1] || "").trim().length === 0) {
		endLine++;
	}

	return {
		start: { line: startLine, col: 0 },
		end: { line: endLine, col: (lines[endLine] || "").length },
		linewise: true,
		inclusive: true,
	};
}

// ---------------------------------------------------------------------------
// Range Extraction & Deletion
// ---------------------------------------------------------------------------

function getTextRange(lines: string[], range: Range): string {
	let { start, end, linewise, inclusive, block } = range;
	if (comparePositions(start, end) > 0) {
		const tmp = start;
		start = end;
		end = tmp;
	}
	if (linewise) {
		return lines.slice(start.line, end.line + 1).join("\n") + "\n";
	}
	if (block) {
		const minC = Math.min(start.col, end.col);
		const maxC = Math.max(start.col, end.col) + (inclusive ? 1 : 0);
		const rows: string[] = [];
		for (let l = start.line; l <= end.line; l++) {
			rows.push((lines[l] || "").slice(minC, maxC));
		}
		return rows.join("\n");
	}
	if (start.line === end.line) {
		const endCol = inclusive ? end.col + 1 : end.col;
		return (lines[start.line] || "").slice(start.col, endCol);
	}
	const parts: string[] = [];
	parts.push((lines[start.line] || "").slice(start.col));
	for (let l = start.line + 1; l < end.line; l++) {
		parts.push(lines[l] || "");
	}
	const endCol = inclusive ? end.col + 1 : end.col;
	parts.push((lines[end.line] || "").slice(0, endCol));
	return parts.join("\n");
}

function deleteRange(
	lines: string[],
	range: Range,
): { lines: string[]; cursor: Position } {
	let { start, end, linewise, inclusive, block } = range;
	if (comparePositions(start, end) > 0) {
		const tmp = start;
		start = end;
		end = tmp;
	}
	const newLines = [...lines];
	if (linewise) {
		newLines.splice(start.line, end.line - start.line + 1);
		if (newLines.length === 0) newLines.push("");
		const targetLine = Math.min(start.line, newLines.length - 1);
		const targetCol = findFirstNonBlank(newLines, targetLine);
		return { lines: newLines, cursor: { line: targetLine, col: targetCol } };
	}

	if (block) {
		const minC = Math.min(start.col, end.col);
		const maxC = Math.max(start.col, end.col) + (inclusive ? 1 : 0);
		for (let l = start.line; l <= end.line; l++) {
			const lineText = newLines[l] || "";
			newLines[l] = lineText.slice(0, minC) + lineText.slice(maxC);
		}
		return { lines: newLines, cursor: { line: start.line, col: minC } };
	}

	const startLineText = newLines[start.line] || "";
	const endLineText = newLines[end.line] || "";
	const before = startLineText.slice(0, start.col);
	const endCol = inclusive ? end.col + 1 : end.col;
	const after = endLineText.slice(endCol);

	if (start.line === end.line) {
		newLines[start.line] = before + after;
	} else {
		newLines.splice(start.line, end.line - start.line + 1, before + after);
	}

	const targetLine = start.line;
	const maxCol = Math.max(0, (newLines[targetLine] || "").length);
	const targetCol = Math.min(start.col, maxCol);
	return { lines: newLines, cursor: { line: targetLine, col: targetCol } };
}

// ---------------------------------------------------------------------------
// System Clipboard Helpers
// ---------------------------------------------------------------------------

function getSystemClipboard(): string {
	try {
		if (process.platform === "darwin") {
			return execSync("pbpaste", { encoding: "utf8", timeout: 500 });
		} else if (process.platform === "win32") {
			return execSync("powershell.exe -Command Get-Clipboard", {
				encoding: "utf8",
				timeout: 500,
			});
		} else {
			try {
				return execSync("wl-paste -n", { encoding: "utf8", timeout: 500 });
			} catch {
				return execSync("xclip -selection clipboard -o", {
					encoding: "utf8",
					timeout: 500,
				});
			}
		}
	} catch {
		return "";
	}
}

function setSystemClipboard(text: string): void {
	try {
		if (process.platform === "darwin") {
			execSync("pbcopy", { input: text, timeout: 500 });
		} else if (process.platform === "win32") {
			execSync("clip.exe", { input: text, timeout: 500 });
		} else {
			try {
				execSync("wl-copy", { input: text, timeout: 500 });
			} catch {
				execSync("xclip -selection clipboard", { input: text, timeout: 500 });
			}
		}
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Vim Editor Implementation
// ---------------------------------------------------------------------------

export class VimEditor extends CustomEditor {
	public mode: VimMode = "normal";
	public visualAnchor: Position = { line: 0, col: 0 };
	public operator: string | null = null;
	public countStr = "";
	public operatorCountStr = "";
	public pendingKeys = "";
	public selectedRegister = "";
	public registers = new Map<string, RegisterEntry>();
	public marks = new Map<string, Position>();
	public lastCharFind: CharFind | null = null;
	public lastSearch: { query: string; forward: boolean } | null = null;
	public searchQuery: string | null = null;
	public commandBuffer = "";
	public commandPrompt = ":";
	public redoStack: Array<{ lines: string[]; cursorLine: number; cursorCol: number }> = [];
	public dotCommand: (() => void) | null = null;
	public recordedInsertKeys: string[] = [];
	public isRecordingInsert = false;
	public recordingMacroReg: string | null = null;
	public recordedMacroKeys: string[] = [];
	public lastPlayedMacroReg: string | null = null;
	private lastInsertChar: string | null = null;
	private lastInsertTime = 0;
	private config: VimConfig;
	private vimTheme: EditorTheme;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.vimTheme = theme;
		this.config = loadConfig();
		this.mode = this.config.startMode || "normal";
		setTerminalCursorShape(this.mode, this.config.cursorShape);
	}

	public getCursorPosition(): Position {
		return {
			line: (this as any).state.cursorLine,
			col: (this as any).state.cursorCol,
		};
	}

	public setCursorPosition(pos: Position): void {
		const lines = (this as any).state.lines as string[];
		const line = Math.max(0, Math.min(pos.line, lines.length - 1));
		const lineText = lines[line] || "";
		let maxCol = lineText.length;
		if (this.mode === "normal" && lineText.length > 0) {
			maxCol = lineText.length - 1;
		}
		const col = Math.max(0, Math.min(pos.col, maxCol));
		(this as any).state.cursorLine = line;
		(this as any).setCursorCol(col);
	}

	public pushUndo(): void {
		this.redoStack = [];
		(this as any).pushUndoSnapshot();
	}

	public updateTextAndCursor(lines: string[], cursor: Position): void {
		(this as any).state.lines = lines.length === 0 ? [""] : lines;
		(this as any).exitHistoryBrowsing();
		(this as any).lastAction = null;
		this.setCursorPosition(cursor);
		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.tui.requestRender();
	}

	public yankToRegister(text: string, linewise: boolean, block = false): void {
		const reg = this.selectedRegister || '"';
		this.registers.set(reg, { text, linewise, block });
		if (reg !== '"') {
			this.registers.set('"', { text, linewise, block });
		}
		if (this.config.syncClipboard || reg === "+" || reg === "*") {
			setSystemClipboard(text);
		}
		this.selectedRegister = "";
	}

	public getRegister(): RegisterEntry | null {
		const reg = this.selectedRegister || '"';
		if (this.config.syncClipboard || reg === "+" || reg === "*") {
			const clip = getSystemClipboard();
			if (clip) {
				const isLine = clip.endsWith("\n");
				return { text: clip, linewise: isLine };
			}
		}
		if (this.registers.has(reg)) {
			return this.registers.get(reg)!;
		}
		if (this.registers.has('"')) {
			return this.registers.get('"')!;
		}
		return null;
	}

	public resetPending(): void {
		this.operator = null;
		this.countStr = "";
		this.operatorCountStr = "";
		this.pendingKeys = "";
		this.selectedRegister = "";
	}

	public getCount(): number {
		const c1 = this.operatorCountStr ? Number.parseInt(this.operatorCountStr, 10) : 1;
		const c2 = this.countStr ? Number.parseInt(this.countStr, 10) : 1;
		return (Number.isFinite(c1) ? c1 : 1) * (Number.isFinite(c2) ? c2 : 1);
	}

	public enterInsertMode(targetCursor?: Position, recordEntry?: () => void): void {
		this.mode = "insert";
		setTerminalCursorShape(this.mode, this.config.cursorShape);
		this.resetPending();
		this.isRecordingInsert = true;
		this.recordedInsertKeys = [];
		if (targetCursor) {
			this.setCursorPosition(targetCursor);
		}
		if (recordEntry) {
			this.dotCommand = () => {
				recordEntry();
				for (const k of this.recordedInsertKeys) {
					super.handleInput(k);
				}
				if ((this as any).state.cursorCol > 0) {
					this.setCursorPosition({
						line: (this as any).state.cursorLine,
						col: (this as any).state.cursorCol - 1,
					});
				}
			};
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		// Macro recording capture
		if (this.recordingMacroReg && data !== "q") {
			this.recordedMacroKeys.push(data);
		}

		// 1. If autocomplete popup is active, delegate all navigation to default editor
		if (this.isShowingAutocomplete()) {
			super.handleInput(data);
			return;
		}

		// 2. INSERT MODE
		if (this.mode === "insert") {
			// Escape or Ctrl+[ returns to Normal mode
			if (matchesKey(data, "escape") || data === "\x1b") {
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.isRecordingInsert = false;
				const cur = this.getCursorPosition();
				if (cur.col > 0) {
					this.setCursorPosition({ line: cur.line, col: cur.col - 1 });
				}
				this.tui.requestRender();
				return;
			}

			// Fast jk / jj escape sequence
			if (this.config.enableJkEscape) {
				const now = Date.now();
				if (
					this.lastInsertChar === "j" &&
					now - this.lastInsertTime < 250 &&
					(data === "k" || data === "j")
				) {
					(this as any).handleBackspace();
					this.mode = "normal";
					setTerminalCursorShape(this.mode, this.config.cursorShape);
					this.isRecordingInsert = false;
					this.lastInsertChar = null;
					const cur = this.getCursorPosition();
					if (cur.col > 0) {
						this.setCursorPosition({ line: cur.line, col: cur.col - 1 });
					}
					this.tui.requestRender();
					return;
				}
				if (data === "j") {
					this.lastInsertChar = "j";
					this.lastInsertTime = now;
				} else {
					this.lastInsertChar = null;
				}
			}

			if (this.isRecordingInsert) {
				this.recordedInsertKeys.push(data);
			}

			super.handleInput(data);
			return;
		}

		// 3. REPLACE MODE
		if (this.mode === "replace") {
			if (matchesKey(data, "escape") || data === "\x1b") {
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f" || data === "\x08") {
				const cur = this.getCursorPosition();
				if (cur.col > 0) {
					this.setCursorPosition({ line: cur.line, col: cur.col - 1 });
				}
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.pushUndo();
				const lines = [...((this as any).state.lines as string[])];
				const cur = this.getCursorPosition();
				const lineText = lines[cur.line] || "";
				if (cur.col < lineText.length) {
					lines[cur.line] = lineText.slice(0, cur.col) + data + lineText.slice(cur.col + 1);
				} else {
					lines[cur.line] = lineText + data;
				}
				this.updateTextAndCursor(lines, { line: cur.line, col: cur.col + 1 });
				return;
			}
			super.handleInput(data);
			return;
		}

		// 4. COMMAND / SEARCH MODE (: / ?)
		if (this.mode === "command" || this.mode === "search") {
			if (matchesKey(data, "escape") || data === "\x1b") {
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.commandBuffer = "";
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f" || data === "\x08") {
				if (this.commandBuffer.length > 0) {
					this.commandBuffer = this.commandBuffer.slice(0, -1);
					this.tui.requestRender();
				} else {
					this.mode = "normal";
					setTerminalCursorShape(this.mode, this.config.cursorShape);
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
				const buf = this.commandBuffer;
				const prompt = this.commandPrompt;
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.commandBuffer = "";

				if (prompt === ":") {
					this.executeExCommand(buf);
				} else {
					this.executeSearch(buf, prompt === "/");
				}
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.commandBuffer += data;
				this.tui.requestRender();
				return;
			}
			return;
		}

		// 5. VISUAL & VISUAL LINE & VISUAL BLOCK MODE
		if (
			this.mode === "visual" ||
			this.mode === "visual_line" ||
			this.mode === "visual_block"
		) {
			if (matchesKey(data, "escape") || data === "\x1b") {
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.tui.requestRender();
				return;
			}
			if (data === "v") {
				if (this.mode === "visual_line" || this.mode === "visual_block") this.mode = "visual";
				else this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.tui.requestRender();
				return;
			}
			if (data === "V") {
				if (this.mode === "visual" || this.mode === "visual_block") this.mode = "visual_line";
				else this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.tui.requestRender();
				return;
			}
			if (data === "\x16" || data === "\x1bb") {
				// Ctrl+V or Alt+B for Visual Block
				if (this.mode !== "visual_block") this.mode = "visual_block";
				else this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.tui.requestRender();
				return;
			}
			if (data === "o") {
				// Swap cursor and anchor
				const cur = this.getCursorPosition();
				const tmp = this.visualAnchor;
				this.visualAnchor = cur;
				this.setCursorPosition(tmp);
				this.tui.requestRender();
				return;
			}

			// Operators in Visual mode
			if (data === "d" || data === "x") {
				this.pushUndo();
				const range = this.getVisualRange();
				const text = getTextRange((this as any).state.lines, range);
				this.yankToRegister(text, !!range.linewise, !!range.block);
				const res = deleteRange((this as any).state.lines, range);
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.updateTextAndCursor(res.lines, res.cursor);
				return;
			}
			if (data === "c" || data === "s") {
				this.pushUndo();
				const range = this.getVisualRange();
				const text = getTextRange((this as any).state.lines, range);
				this.yankToRegister(text, !!range.linewise, !!range.block);
				const res = deleteRange((this as any).state.lines, range);
				this.updateTextAndCursor(res.lines, res.cursor);
				this.enterInsertMode(res.cursor);
				return;
			}
			if (data === "y") {
				const range = this.getVisualRange();
				const text = getTextRange((this as any).state.lines, range);
				this.yankToRegister(text, !!range.linewise, !!range.block);
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.tui.requestRender();
				return;
			}
			if (data === "p" || data === "P") {
				const reg = this.getRegister();
				if (reg) {
					this.pushUndo();
					const range = this.getVisualRange();
					const delRes = deleteRange((this as any).state.lines, range);
					const lines = delRes.lines;
					let cursor = delRes.cursor;
					if (reg.linewise) {
						const pasteLines = reg.text.replace(/\n$/, "").split("\n");
						lines.splice(cursor.line, 0, ...pasteLines);
						cursor = { line: cursor.line, col: findFirstNonBlank(lines, cursor.line) };
					} else {
						const lineText = lines[cursor.line] || "";
						lines[cursor.line] =
							lineText.slice(0, cursor.col) + reg.text + lineText.slice(cursor.col);
						cursor = { line: cursor.line, col: cursor.col + reg.text.length };
					}
					this.mode = "normal";
					setTerminalCursorShape(this.mode, this.config.cursorShape);
					this.updateTextAndCursor(lines, cursor);
				}
				return;
			}
			if (data === ">" || data === "<") {
				this.pushUndo();
				const range = this.getVisualRange();
				const lines = [...((this as any).state.lines as string[])];
				const startL = Math.min(range.start.line, range.end.line);
				const endL = Math.max(range.start.line, range.end.line);
				for (let l = startL; l <= endL; l++) {
					if (data === ">") {
						lines[l] = "    " + (lines[l] || "");
					} else {
						lines[l] = (lines[l] || "").replace(/^( {1,4}|\t)/, "");
					}
				}
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.updateTextAndCursor(lines, {
					line: startL,
					col: findFirstNonBlank(lines, startL),
				});
				return;
			}
			if (data === "~" || data === "u" || data === "U") {
				this.pushUndo();
				const range = this.getVisualRange();
				const lines = [...((this as any).state.lines as string[])];
				const transform = (str: string) => {
					if (data === "u") return str.toLowerCase();
					if (data === "U") return str.toUpperCase();
					return str
						.split("")
						.map((ch) =>
							ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
						)
						.join("");
				};
				if (range.linewise) {
					for (let l = range.start.line; l <= range.end.line; l++) {
						lines[l] = transform(lines[l] || "");
					}
				} else if (range.start.line === range.end.line) {
					const lineText = lines[range.start.line] || "";
					const b = lineText.slice(0, range.start.col);
					const mid = transform(lineText.slice(range.start.col, range.end.col + 1));
					const a = lineText.slice(range.end.col + 1);
					lines[range.start.line] = b + mid + a;
				}
				this.mode = "normal";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.updateTextAndCursor(lines, range.start);
				return;
			}

			// Visual Mode Motions
			const motionPos = this.evalMotion(data);
			if (motionPos) {
				this.setCursorPosition(motionPos);
				this.tui.requestRender();
				return;
			}
		}

		// 6. NORMAL MODE
		if (this.mode === "normal") {
			// Escape: cancel pending state or pass to App (abort / tree)
			if (matchesKey(data, "escape") || data === "\x1b") {
				if (
					this.operator ||
					this.countStr ||
					this.operatorCountStr ||
					this.pendingKeys ||
					this.selectedRegister
				) {
					this.resetPending();
					this.tui.requestRender();
					return;
				}
				super.handleInput(data);
				return;
			}

			// Enter: submit prompt in normal mode
			if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
				if ((this as any).disableSubmit) {
					const cur = this.getCursorPosition();
					this.setCursorPosition({ line: cur.line + 1, col: 0 });
					this.tui.requestRender();
				} else {
					(this as any).submitValue();
				}
				return;
			}

			// Text object pending (i / a after operator) - highest priority
			if (
				(this.pendingKeys === "i" || this.pendingKeys === "a") &&
				this.operator
			) {
				const around = this.pendingKeys === "a";
				const key = data;
				this.pendingKeys = "";
				const range = this.evalTextObject(key, around);
				if (range) {
					this.applyOperator(range);
				} else {
					this.resetPending();
					this.tui.requestRender();
				}
				return;
			}

			// If operator is active and user presses 'i' or 'a', set pendingKeys = data
			if (this.operator && (data === "i" || data === "a")) {
				this.pendingKeys = data;
				this.tui.requestRender();
				return;
			}

			// Mark creation (m{a-z})
			if (this.pendingKeys === "m") {
				this.marks.set(data, this.getCursorPosition());
				this.pendingKeys = "";
				this.tui.requestRender();
				return;
			}
			if (data === "m") {
				this.pendingKeys = "m";
				this.tui.requestRender();
				return;
			}

			// Jump to mark ('{a-z} or `{a-z})
			if (this.pendingKeys === "'" || this.pendingKeys === "`") {
				const isExact = this.pendingKeys === "`";
				this.pendingKeys = "";
				const mark = this.marks.get(data);
				if (mark) {
					if (isExact) {
						this.setCursorPosition(mark);
					} else {
						const col = findFirstNonBlank((this as any).state.lines, mark.line);
						this.setCursorPosition({ line: mark.line, col });
					}
					this.tui.requestRender();
				}
				return;
			}
			if (data === "'" || data === "`") {
				this.pendingKeys = data;
				this.tui.requestRender();
				return;
			}

			// Macro recording (q{a-z} or q to stop)
			if (data === "q") {
				if (this.recordingMacroReg) {
					this.registers.set(this.recordingMacroReg, {
						text: JSON.stringify(this.recordedMacroKeys),
						linewise: false,
					});
					this.recordingMacroReg = null;
					this.recordedMacroKeys = [];
					this.tui.requestRender();
				} else {
					this.pendingKeys = "q";
					this.tui.requestRender();
				}
				return;
			}
			if (this.pendingKeys === "q") {
				this.recordingMacroReg = data;
				this.recordedMacroKeys = [];
				this.pendingKeys = "";
				this.tui.requestRender();
				return;
			}

			// Macro replay (@{a-z} or @@)
			if (this.pendingKeys === "@") {
				const reg = data === "@" ? this.lastPlayedMacroReg : data;
				this.pendingKeys = "";
				if (reg && this.registers.has(reg)) {
					this.lastPlayedMacroReg = reg;
					try {
						const keys = JSON.parse(this.registers.get(reg)!.text) as string[];
						for (const k of keys) {
							this.handleInput(k);
						}
					} catch {
						// ignore
					}
				}
				return;
			}
			if (data === "@") {
				this.pendingKeys = "@";
				this.tui.requestRender();
				return;
			}

			// Numeric count prefix (1-9, or 0 if count already started)
			if (/^[1-9]$/.test(data) || (data === "0" && this.countStr.length > 0)) {
				this.countStr += data;
				this.tui.requestRender();
				return;
			}

			// Register selection: "a .. "z, "+, "*
			if (this.pendingKeys === '"') {
				this.selectedRegister = data;
				this.pendingKeys = "";
				this.tui.requestRender();
				return;
			}
			if (data === '"') {
				this.pendingKeys = '"';
				this.tui.requestRender();
				return;
			}

			// Char search pending (f, F, t, T)
			if (
				this.pendingKeys === "f" ||
				this.pendingKeys === "F" ||
				this.pendingKeys === "t" ||
				this.pendingKeys === "T"
			) {
				const char = data;
				const fType = this.pendingKeys;
				this.pendingKeys = "";
				this.lastCharFind = {
					char,
					forward: fType === "f" || fType === "t",
					till: fType === "t" || fType === "T",
				};
				const targetPos = this.evalCharFind(this.lastCharFind, this.getCount());
				if (targetPos) {
					if (this.operator) {
						this.applyOperator({
							start: this.getCursorPosition(),
							end: targetPos,
							inclusive: true,
						});
					} else {
						this.setCursorPosition(targetPos);
						this.tui.requestRender();
					}
				} else {
					this.resetPending();
					this.tui.requestRender();
				}
				return;
			}

			// Replace char pending (r)
			if (this.pendingKeys === "r") {
				this.pendingKeys = "";
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					const count = this.getCount();
					const replaceChar = data;
					const doReplace = () => {
						this.pushUndo();
						const lines = [...((this as any).state.lines as string[])];
						const cur = this.getCursorPosition();
						const lineText = lines[cur.line] || "";
						if (lineText.length > 0) {
							const rep = replaceChar.repeat(
								Math.min(count, lineText.length - cur.col),
							);
							lines[cur.line] =
								lineText.slice(0, cur.col) + rep + lineText.slice(cur.col + rep.length);
							this.updateTextAndCursor(lines, {
								line: cur.line,
								col: cur.col + rep.length - 1,
							});
						}
					};
					doReplace();
					this.dotCommand = doReplace;
				}
				this.resetPending();
				return;
			}

			// g prefix (gg, ge, gE, g~, gu, gU, gJ)
			if (this.pendingKeys === "g") {
				this.pendingKeys = "";
				if (data === "g") {
					const targetLine = this.countStr ? Number.parseInt(this.countStr, 10) - 1 : 0;
					const pos = {
						line: targetLine,
						col: findFirstNonBlank((this as any).state.lines, targetLine),
					};
					if (this.operator) {
						this.applyOperator({
							start: this.getCursorPosition(),
							end: pos,
							linewise: true,
						});
					} else {
						this.setCursorPosition(pos);
						this.tui.requestRender();
					}
					this.resetPending();
					return;
				}
				if (data === "e" || data === "E") {
					const pos = findWordEndBackward(
						(this as any).state.lines,
						this.getCursorPosition(),
						this.getCount(),
						data === "E",
					);
					if (this.operator) {
						this.applyOperator({
							start: this.getCursorPosition(),
							end: pos,
							inclusive: true,
						});
					} else {
						this.setCursorPosition(pos);
						this.tui.requestRender();
					}
					this.resetPending();
					return;
				}
				if (data === "~" || data === "u" || data === "U") {
					this.operator = `g${data}`;
					this.operatorCountStr = this.countStr;
					this.countStr = "";
					this.tui.requestRender();
					return;
				}
				if (data === "J") {
					this.pushUndo();
					this.joinLines(false);
					this.resetPending();
					return;
				}
			}

			// Operators: d, c, y, >, <, =
			if (data === "d" || data === "c" || data === "y" || data === ">" || data === "<" || data === "=") {
				if (this.operator === data) {
					// Doubled operator: dd, cc, yy, >>, <<
					const count = this.getCount();
					const cur = this.getCursorPosition();
					const start = { line: cur.line, col: 0 };
					const end = { line: cur.line + count - 1, col: 0 };
					this.applyOperator({ start, end, linewise: true });
					return;
				}
				this.operator = data;
				this.operatorCountStr = this.countStr;
				this.countStr = "";
				this.tui.requestRender();
				return;
			}

			// Mode switches
			if (data === "i") {
				this.enterInsertMode();
				return;
			}
			if (data === "I") {
				const cur = this.getCursorPosition();
				const col = findFirstNonBlank((this as any).state.lines, cur.line);
				this.enterInsertMode({ line: cur.line, col });
				return;
			}
			if (data === "a") {
				const cur = this.getCursorPosition();
				const lineText = ((this as any).state.lines as string[])[cur.line] || "";
				const col = lineText.length > 0 ? cur.col + 1 : 0;
				this.enterInsertMode({ line: cur.line, col });
				return;
			}
			if (data === "A") {
				const cur = this.getCursorPosition();
				const lineText = ((this as any).state.lines as string[])[cur.line] || "";
				this.enterInsertMode({ line: cur.line, col: lineText.length });
				return;
			}
			if (data === "o") {
				this.pushUndo();
				const lines = [...((this as any).state.lines as string[])];
				const cur = this.getCursorPosition();
				lines.splice(cur.line + 1, 0, "");
				this.updateTextAndCursor(lines, { line: cur.line + 1, col: 0 });
				this.enterInsertMode();
				return;
			}
			if (data === "O") {
				this.pushUndo();
				const lines = [...((this as any).state.lines as string[])];
				const cur = this.getCursorPosition();
				lines.splice(cur.line, 0, "");
				this.updateTextAndCursor(lines, { line: cur.line, col: 0 });
				this.enterInsertMode();
				return;
			}
			if (data === "s") {
				// cl
				this.pushUndo();
				const cur = this.getCursorPosition();
				const range = { start: cur, end: cur, inclusive: true };
				const res = deleteRange((this as any).state.lines, range);
				this.updateTextAndCursor(res.lines, res.cursor);
				this.enterInsertMode(res.cursor);
				return;
			}
			if (data === "S") {
				// cc
				this.pushUndo();
				const cur = this.getCursorPosition();
				const range = { start: cur, end: cur, linewise: true };
				const res = deleteRange((this as any).state.lines, range);
				this.updateTextAndCursor(res.lines, res.cursor);
				this.enterInsertMode(res.cursor);
				return;
			}
			if (data === "C") {
				// c$
				this.pushUndo();
				const cur = this.getCursorPosition();
				const lineText = ((this as any).state.lines as string[])[cur.line] || "";
				const end = { line: cur.line, col: Math.max(0, lineText.length - 1) };
				const res = deleteRange((this as any).state.lines, {
					start: cur,
					end,
					inclusive: true,
				});
				this.updateTextAndCursor(res.lines, res.cursor);
				this.enterInsertMode(res.cursor);
				return;
			}
			if (data === "D") {
				// d$
				this.pushUndo();
				const cur = this.getCursorPosition();
				const lineText = ((this as any).state.lines as string[])[cur.line] || "";
				const end = { line: cur.line, col: Math.max(0, lineText.length - 1) };
				const text = getTextRange((this as any).state.lines, {
					start: cur,
					end,
					inclusive: true,
				});
				this.yankToRegister(text, false);
				const res = deleteRange((this as any).state.lines, {
					start: cur,
					end,
					inclusive: true,
				});
				this.updateTextAndCursor(res.lines, res.cursor);
				this.resetPending();
				return;
			}
			if (data === "v") {
				this.mode = "visual";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.visualAnchor = this.getCursorPosition();
				this.resetPending();
				this.tui.requestRender();
				return;
			}
			if (data === "V") {
				this.mode = "visual_line";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.visualAnchor = this.getCursorPosition();
				this.resetPending();
				this.tui.requestRender();
				return;
			}
			if (data === "\x16" || data === "\x1bb") {
				// Ctrl+V / Alt+B for Visual Block
				this.mode = "visual_block";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.visualAnchor = this.getCursorPosition();
				this.resetPending();
				this.tui.requestRender();
				return;
			}
			if (data === "R") {
				this.mode = "replace";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.resetPending();
				this.tui.requestRender();
				return;
			}

			// Deletion / character actions
			if (data === "x") {
				const count = this.getCount();
				const doX = () => {
					this.pushUndo();
					const cur = this.getCursorPosition();
					const lineText = ((this as any).state.lines as string[])[cur.line] || "";
					if (lineText.length > 0) {
						const endCol = Math.min(lineText.length - 1, cur.col + count - 1);
						const text = getTextRange((this as any).state.lines, {
							start: cur,
							end: { line: cur.line, col: endCol },
							inclusive: true,
						});
						this.yankToRegister(text, false);
						const res = deleteRange((this as any).state.lines, {
							start: cur,
							end: { line: cur.line, col: endCol },
							inclusive: true,
						});
						this.updateTextAndCursor(res.lines, res.cursor);
					}
				};
				doX();
				this.dotCommand = doX;
				this.resetPending();
				return;
			}
			if (data === "X") {
				const count = this.getCount();
				const doXBack = () => {
					this.pushUndo();
					const cur = this.getCursorPosition();
					if (cur.col > 0) {
						const startCol = Math.max(0, cur.col - count);
						const text = getTextRange((this as any).state.lines, {
							start: { line: cur.line, col: startCol },
							end: { line: cur.line, col: cur.col - 1 },
							inclusive: true,
						});
						this.yankToRegister(text, false);
						const res = deleteRange((this as any).state.lines, {
							start: { line: cur.line, col: startCol },
							end: { line: cur.line, col: cur.col - 1 },
							inclusive: true,
						});
						this.updateTextAndCursor(res.lines, { line: cur.line, col: startCol });
					}
				};
				doXBack();
				this.dotCommand = doXBack;
				this.resetPending();
				return;
			}
			if (data === "r") {
				this.pendingKeys = "r";
				this.tui.requestRender();
				return;
			}
			if (data === "~") {
				const doToggle = () => {
					this.pushUndo();
					const lines = [...((this as any).state.lines as string[])];
					const cur = this.getCursorPosition();
					const lineText = lines[cur.line] || "";
					if (lineText.length > 0 && cur.col < lineText.length) {
						const ch = lineText[cur.col]!;
						const nextCh = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
						lines[cur.line] =
							lineText.slice(0, cur.col) + nextCh + lineText.slice(cur.col + 1);
						const nextCol = Math.min(lineText.length - 1, cur.col + 1);
						this.updateTextAndCursor(lines, { line: cur.line, col: nextCol });
					}
				};
				doToggle();
				this.dotCommand = doToggle;
				this.resetPending();
				return;
			}
			if (data === "J") {
				this.pushUndo();
				this.joinLines(true);
				this.resetPending();
				return;
			}

			// Put / Paste (p, P)
			if (data === "p" || data === "P") {
				const isBefore = data === "P";
				const reg = this.getRegister();
				if (reg) {
					const doPaste = () => {
						this.pushUndo();
						const lines = [...((this as any).state.lines as string[])];
						const cur = this.getCursorPosition();
						if (reg.linewise) {
							const pasteLines = reg.text.replace(/\n$/, "").split("\n");
							const targetLine = isBefore ? cur.line : cur.line + 1;
							lines.splice(targetLine, 0, ...pasteLines);
							this.updateTextAndCursor(lines, {
								line: targetLine,
								col: findFirstNonBlank(lines, targetLine),
							});
						} else {
							const lineText = lines[cur.line] || "";
							const insertCol = isBefore
								? cur.col
								: lineText.length === 0
									? 0
									: cur.col + 1;
							lines[cur.line] =
								lineText.slice(0, insertCol) + reg.text + lineText.slice(insertCol);
							this.updateTextAndCursor(lines, {
								line: cur.line,
								col: Math.max(0, insertCol + reg.text.length - 1),
							});
						}
					};
					doPaste();
					this.dotCommand = doPaste;
				}
				this.resetPending();
				return;
			}

			// Undo & Redo
			if (data === "u") {
				this.pushRedo();
				(this as any).undo();
				this.setCursorPosition(this.getCursorPosition());
				this.resetPending();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "ctrl+r") || data === "\x12") {
				this.popRedo();
				this.resetPending();
				return;
			}

			// Dot Repeat (.)
			if (data === ".") {
				if (this.dotCommand) {
					this.dotCommand();
				}
				this.resetPending();
				return;
			}

			// Search & Ex Command
			if (data === "/" || data === "?") {
				this.mode = "search";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.commandPrompt = data;
				this.commandBuffer = "";
				this.resetPending();
				this.tui.requestRender();
				return;
			}
			if (data === ":") {
				this.mode = "command";
				setTerminalCursorShape(this.mode, this.config.cursorShape);
				this.commandPrompt = ":";
				this.commandBuffer = "";
				this.resetPending();
				this.tui.requestRender();
				return;
			}
			if (data === "n" || data === "N") {
				if (this.lastSearch) {
					const forward = data === "n" ? this.lastSearch.forward : !this.lastSearch.forward;
					this.executeSearch(this.lastSearch.query, forward);
				}
				this.resetPending();
				return;
			}

			// Standalone / Operator Motions
			if (data === "f" || data === "F" || data === "t" || data === "T") {
				this.pendingKeys = data;
				this.tui.requestRender();
				return;
			}
			if (data === "g") {
				this.pendingKeys = "g";
				this.tui.requestRender();
				return;
			}

			// Evaluate motion
			let motionPos: Position | null = null;
			let isLinewise = false;
			let isInclusive = false;

			if (this.operator === "c" && (data === "w" || data === "W")) {
				motionPos = findWordEnd(
					(this as any).state.lines,
					this.getCursorPosition(),
					this.getCount(),
					data === "W",
				);
				isInclusive = true;
			} else {
				motionPos = this.evalMotion(data);
				isLinewise =
					data === "j" ||
					data === "k" ||
					data === "G" ||
					data === "gg" ||
					data === "{" ||
					data === "}";
				isInclusive =
					data === "$" ||
					data === "e" ||
					data === "E" ||
					data === "%" ||
					data === ";" ||
					data === ",";
			}

			if (motionPos) {
				if (this.operator) {
					const recordedOp = this.operator;
					const recordedKey = data;
					const recordedCount = this.getCount();
					this.applyOperator({
						start: this.getCursorPosition(),
						end: motionPos,
						linewise: isLinewise,
						inclusive: isInclusive,
					});
					if (recordedOp === "d") {
						this.dotCommand = () => {
							this.operator = recordedOp;
							this.countStr = recordedCount > 1 ? String(recordedCount) : "";
							const m = this.evalMotion(recordedKey);
							if (m) {
								this.applyOperator({
									start: this.getCursorPosition(),
									end: m,
									linewise: isLinewise,
									inclusive: isInclusive,
								});
							}
						};
					}
				} else {
					this.setCursorPosition(motionPos);
					this.resetPending();
					this.tui.requestRender();
				}
				return;
			}

			// Let super handle unhandled control actions (Ctrl+C, Ctrl+D on empty, Ctrl+P, etc.)
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				// Ignore unmapped printable keys in Normal mode
				this.resetPending();
				return;
			}
			super.handleInput(data);
		}
	}

	private evalMotion(key: string): Position | null {
		const lines = (this as any).state.lines as string[];
		const cur = this.getCursorPosition();
		const count = this.getCount();

		switch (key) {
			case "h":
			case "\x1b[D":
				return { line: cur.line, col: Math.max(0, cur.col - count) };
			case "l":
			case "\x1b[C":
				return { line: cur.line, col: cur.col + count };
			case "j":
			case "\x1b[B":
				return { line: Math.min(lines.length - 1, cur.line + count), col: cur.col };
			case "k":
			case "\x1b[A":
				return { line: Math.max(0, cur.line - count), col: cur.col };
			case "0":
			case "\x01":
				return { line: cur.line, col: 0 };
			case "^":
			case "_":
				return { line: cur.line, col: findFirstNonBlank(lines, cur.line) };
			case "$":
			case "\x05": {
				const lineText = lines[cur.line] || "";
				const maxCol = this.mode === "normal" ? Math.max(0, lineText.length - 1) : lineText.length;
				return { line: cur.line, col: maxCol };
			}
			case "w":
				return findWordForward(lines, cur, count, false);
			case "W":
				return findWordForward(lines, cur, count, true);
			case "e":
				return findWordEnd(lines, cur, count, false);
			case "E":
				return findWordEnd(lines, cur, count, true);
			case "b":
			case "\x1b[1;5D":
				return findWordBackward(lines, cur, count, false);
			case "B":
				return findWordBackward(lines, cur, count, true);
			case "G": {
				const targetLine = this.countStr ? Number.parseInt(this.countStr, 10) - 1 : lines.length - 1;
				const line = Math.max(0, Math.min(lines.length - 1, targetLine));
				return { line, col: findFirstNonBlank(lines, line) };
			}
			case "%":
				return findMatchingBracket(lines, cur);
			case "{":
				return findParagraph(lines, cur, -1, count);
			case "}":
				return findParagraph(lines, cur, 1, count);
			case ";":
				if (this.lastCharFind) return this.evalCharFind(this.lastCharFind, count);
				return null;
			case ",":
				if (this.lastCharFind) {
					return this.evalCharFind(
						{ ...this.lastCharFind, forward: !this.lastCharFind.forward },
						count,
					);
				}
				return null;
			case "H":
				return { line: 0, col: findFirstNonBlank(lines, 0) };
			case "M": {
				const mid = Math.floor(lines.length / 2);
				return { line: mid, col: findFirstNonBlank(lines, mid) };
			}
			case "L": {
				const last = Math.max(0, lines.length - 1);
				return { line: last, col: findFirstNonBlank(lines, last) };
			}
			case "\x06": // Ctrl+F (Page Down)
			case "\x04": // Ctrl+D (Half Page Down)
				return { line: Math.min(lines.length - 1, cur.line + 10), col: cur.col };
			case "\x02": // Ctrl+B (Page Up)
			case "\x15": // Ctrl+U (Half Page Up)
				return { line: Math.max(0, cur.line - 10), col: cur.col };
		}
		return null;
	}

	private evalCharFind(find: CharFind, count: number): Position | null {
		const lines = (this as any).state.lines as string[];
		const cur = this.getCursorPosition();
		const lineText = lines[cur.line] || "";
		let col = cur.col;

		for (let i = 0; i < count; i++) {
			if (find.forward) {
				const idx = lineText.indexOf(find.char, col + 1);
				if (idx === -1) return null;
				col = find.till ? Math.max(0, idx - 1) : idx;
			} else {
				const idx = lineText.lastIndexOf(find.char, col - 1);
				if (idx === -1) return null;
				col = find.till ? Math.min(lineText.length - 1, idx + 1) : idx;
			}
		}
		return { line: cur.line, col };
	}

	private evalTextObject(key: string, around: boolean): Range | null {
		const lines = (this as any).state.lines as string[];
		const cur = this.getCursorPosition();

		switch (key) {
			case "w":
				return findTextObjectWord(lines, cur, around, false);
			case "W":
				return findTextObjectWord(lines, cur, around, true);
			case '"':
			case "'":
			case "`":
				return findTextObjectQuote(lines, cur, key, around);
			case "(":
			case ")":
			case "b":
				return findTextObjectBracket(lines, cur, "(", ")", around);
			case "[":
			case "]":
				return findTextObjectBracket(lines, cur, "[", "]", around);
			case "{":
			case "}":
			case "B":
				return findTextObjectBracket(lines, cur, "{", "}", around);
			case "<":
			case ">":
				return findTextObjectBracket(lines, cur, "<", ">", around);
			case "p":
				return findTextObjectParagraph(lines, cur, around);
		}
		return null;
	}

	private applyOperator(range: Range): void {
		const op = this.operator;
		this.resetPending();
		if (!op) return;

		this.pushUndo();
		const lines = (this as any).state.lines as string[];

		if (op === "y") {
			const text = getTextRange(lines, range);
			this.yankToRegister(text, !!range.linewise, !!range.block);
			this.tui.requestRender();
			return;
		}

		if (op === "d") {
			const text = getTextRange(lines, range);
			this.yankToRegister(text, !!range.linewise, !!range.block);
			const res = deleteRange(lines, range);
			this.updateTextAndCursor(res.lines, res.cursor);
			return;
		}

		if (op === "c") {
			const text = getTextRange(lines, range);
			this.yankToRegister(text, !!range.linewise, !!range.block);
			const res = deleteRange(lines, range);
			this.updateTextAndCursor(res.lines, res.cursor);
			this.enterInsertMode(res.cursor);
			return;
		}

		if (op === ">" || op === "<") {
			const startL = Math.min(range.start.line, range.end.line);
			const endL = Math.max(range.start.line, range.end.line);
			const newLines = [...lines];
			for (let l = startL; l <= endL; l++) {
				if (op === ">") {
					newLines[l] = "    " + (newLines[l] || "");
				} else {
					newLines[l] = (newLines[l] || "").replace(/^( {1,4}|\t)/, "");
				}
			}
			this.updateTextAndCursor(newLines, {
				line: startL,
				col: findFirstNonBlank(newLines, startL),
			});
			return;
		}

		if (op === "g~" || op === "gu" || op === "gU") {
			const transform = (str: string) => {
				if (op === "gu") return str.toLowerCase();
				if (op === "gU") return str.toUpperCase();
				return str
					.split("")
					.map((ch) =>
						ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
					)
					.join("");
			};
			const newLines = [...lines];
			if (range.linewise) {
				const startL = Math.min(range.start.line, range.end.line);
				const endL = Math.max(range.start.line, range.end.line);
				for (let l = startL; l <= endL; l++) {
					newLines[l] = transform(newLines[l] || "");
				}
			} else if (range.start.line === range.end.line) {
				const lineText = newLines[range.start.line] || "";
				const startCol = Math.min(range.start.col, range.end.col);
				const endCol = Math.max(range.start.col, range.end.col);
				const b = lineText.slice(0, startCol);
				const mid = transform(lineText.slice(startCol, endCol + 1));
				const a = lineText.slice(endCol + 1);
				newLines[range.start.line] = b + mid + a;
			}
			this.updateTextAndCursor(newLines, range.start);
		}
	}

	private getVisualRange(): Range {
		const anchor = this.visualAnchor;
		const cur = this.getCursorPosition();
		if (this.mode === "visual_line") {
			const startL = Math.min(anchor.line, cur.line);
			const endL = Math.max(anchor.line, cur.line);
			return {
				start: { line: startL, col: 0 },
				end: {
					line: endL,
					col: ((this as any).state.lines[endL] || "").length,
				},
				linewise: true,
				inclusive: true,
			};
		}
		if (this.mode === "visual_block") {
			const startL = Math.min(anchor.line, cur.line);
			const endL = Math.max(anchor.line, cur.line);
			const minC = Math.min(anchor.col, cur.col);
			const maxC = Math.max(anchor.col, cur.col);
			return {
				start: { line: startL, col: minC },
				end: { line: endL, col: maxC },
				block: true,
				inclusive: true,
			};
		}
		let start = anchor;
		let end = cur;
		if (comparePositions(start, end) > 0) {
			start = cur;
			end = anchor;
		}
		return { start, end, inclusive: true };
	}

	private joinLines(addSpace: boolean): void {
		const lines = [...((this as any).state.lines as string[])];
		const cur = this.getCursorPosition();
		if (cur.line < lines.length - 1) {
			const line1 = lines[cur.line] || "";
			const line2 = (lines[cur.line + 1] || "").trimStart();
			const joinCol = line1.length;
			const space = addSpace && line1.length > 0 && !line1.endsWith(" ") ? " " : "";
			lines[cur.line] = line1 + space + line2;
			lines.splice(cur.line + 1, 1);
			this.updateTextAndCursor(lines, { line: cur.line, col: joinCol });
		}
	}

	private pushRedo(): void {
		this.redoStack.push({
			lines: [...((this as any).state.lines as string[])],
			cursorLine: (this as any).state.cursorLine,
			cursorCol: (this as any).state.cursorCol,
		});
	}

	private popRedo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		this.pushUndo();
		(this as any).state.lines = snapshot.lines;
		this.setCursorPosition({ line: snapshot.cursorLine, col: snapshot.cursorCol });
		if (this.onChange) this.onChange(this.getText());
		this.tui.requestRender();
	}

	private executeSearch(query: string, forward: boolean): void {
		if (!query) return;
		this.lastSearch = { query, forward };
		this.searchQuery = query;
		const lines = (this as any).state.lines as string[];
		const cur = this.getCursorPosition();
		let found: Position | null = null;

		if (forward) {
			for (let l = cur.line; l < lines.length; l++) {
				const startC = l === cur.line ? cur.col + 1 : 0;
				const idx = (lines[l] || "").indexOf(query, startC);
				if (idx !== -1) {
					found = { line: l, col: idx };
					break;
				}
			}
			if (!found) {
				for (let l = 0; l <= cur.line; l++) {
					const idx = (lines[l] || "").indexOf(query, 0);
					if (idx !== -1) {
						found = { line: l, col: idx };
						break;
					}
				}
			}
		} else {
			for (let l = cur.line; l >= 0; l--) {
				const startC = l === cur.line ? cur.col - 1 : (lines[l] || "").length;
				if (startC >= 0) {
					const idx = (lines[l] || "").lastIndexOf(query, startC);
					if (idx !== -1) {
						found = { line: l, col: idx };
						break;
					}
				}
			}
			if (!found) {
				for (let l = lines.length - 1; l >= cur.line; l--) {
					const idx = (lines[l] || "").lastIndexOf(query);
					if (idx !== -1) {
						found = { line: l, col: idx };
						break;
					}
				}
			}
		}

		if (found) {
			this.setCursorPosition(found);
			this.tui.requestRender();
		}
	}

	private executeExCommand(cmd: string): void {
		const clean = cmd.trim();
		if (!clean) return;

		// 1. Submit / Exit / Clear
		if (clean === "w" || clean === "submit" || clean === "x") {
			(this as any).submitValue();
			return;
		}
		if (clean === "q" || clean === "quit") {
			if (this.getText().trim().length === 0) {
				const handler = (this as any).actionHandlers?.get("app.exit");
				handler?.();
			} else {
				(this as any).setText("");
			}
			return;
		}
		if (clean === "q!" || clean === "clear" || clean === "c") {
			(this as any).setText("");
			return;
		}

		// 2. Clear search highlight
		if (clean === "noh" || clean === "nohlsearch") {
			this.searchQuery = null;
			this.tui.requestRender();
			return;
		}

		// 3. Settings
		if (clean === "set vim") {
			this.config.enabled = true;
			saveConfig(this.config);
			return;
		}
		if (clean === "set novim") {
			this.config.enabled = false;
			saveConfig(this.config);
			return;
		}

		// 4. Substitution: :s/old/new/[flags] or :%s/old/new/[flags]
		const subMatch = clean.match(/^%?s\/([^/]+)\/([^/]*)(?:\/([gi]*))?$/);
		if (subMatch) {
			const [, oldPattern, newReplacement = "", flags = "g"] = subMatch;
			if (oldPattern) {
				this.pushUndo();
				const lines = [...((this as any).state.lines as string[])];
				const isGlobalBuffer = clean.startsWith("%");
				const regex = new RegExp(oldPattern, flags);
				if (isGlobalBuffer) {
					for (let i = 0; i < lines.length; i++) {
						lines[i] = (lines[i] || "").replace(regex, newReplacement);
					}
				} else {
					const cur = this.getCursorPosition();
					lines[cur.line] = (lines[cur.line] || "").replace(regex, newReplacement);
				}
				this.updateTextAndCursor(lines, this.getCursorPosition());
				return;
			}
		}

		// 5. Prompt Transforms: :quote, :unquote, :fence [lang], :reflow [width], :bullet
		if (clean === "quote") {
			this.pushUndo();
			const lines = ((this as any).state.lines as string[]).map((l) => `> ${l}`);
			this.updateTextAndCursor(lines, { line: 0, col: 2 });
			return;
		}
		if (clean === "unquote") {
			this.pushUndo();
			const lines = ((this as any).state.lines as string[]).map((l) =>
				l.replace(/^>\s?/, ""),
			);
			this.updateTextAndCursor(lines, { line: 0, col: 0 });
			return;
		}
		if (clean === "bullet" || clean === "list") {
			this.pushUndo();
			const lines = ((this as any).state.lines as string[]).map((l) =>
				l.trim().length > 0 && !l.startsWith("- ") ? `- ${l}` : l,
			);
			this.updateTextAndCursor(lines, { line: 0, col: 2 });
			return;
		}
		if (clean.startsWith("fence")) {
			const lang = clean.slice(5).trim();
			this.pushUndo();
			const lines = [
				`\`\`\`${lang}`,
				...((this as any).state.lines as string[]),
				"```",
			];
			this.updateTextAndCursor(lines, { line: 1, col: 0 });
			return;
		}
		if (clean.startsWith("reflow")) {
			const widthStr = clean.slice(6).trim();
			const targetWidth = widthStr ? Number.parseInt(widthStr, 10) : 80;
			if (Number.isFinite(targetWidth) && targetWidth > 10) {
				this.pushUndo();
				const text = this.getText();
				const words = text.split(/\s+/);
				const reflowed: string[] = [];
				let curLine = "";
				for (const w of words) {
					if (curLine.length + w.length + 1 <= targetWidth) {
						curLine = curLine ? `${curLine} ${w}` : w;
					} else {
						if (curLine) reflowed.push(curLine);
						curLine = w;
					}
				}
				if (curLine) reflowed.push(curLine);
				this.updateTextAndCursor(reflowed, { line: 0, col: 0 });
				return;
			}
		}

		// 6. Delete (:d, :delete) & Yank (:y, :yank) & Put (:pu, :put)
		if (clean === "d" || clean === "delete") {
			this.pushUndo();
			const cur = this.getCursorPosition();
			const res = deleteRange((this as any).state.lines, {
				start: cur,
				end: cur,
				linewise: true,
			});
			this.updateTextAndCursor(res.lines, res.cursor);
			return;
		}
		if (clean === "y" || clean === "yank") {
			const cur = this.getCursorPosition();
			const text = getTextRange((this as any).state.lines, {
				start: cur,
				end: cur,
				linewise: true,
			});
			this.yankToRegister(text, true);
			return;
		}
		if (clean === "pu" || clean === "put") {
			const reg = this.getRegister();
			if (reg) {
				this.pushUndo();
				const lines = [...((this as any).state.lines as string[])];
				const cur = this.getCursorPosition();
				const pasteLines = reg.text.replace(/\n$/, "").split("\n");
				lines.splice(cur.line + 1, 0, ...pasteLines);
				this.updateTextAndCursor(lines, {
					line: cur.line + 1,
					col: findFirstNonBlank(lines, cur.line + 1),
				});
			}
			return;
		}
		if (clean === "j" || clean === "join") {
			this.pushUndo();
			this.joinLines(true);
			return;
		}
	}

	public getPendingDisplay(): string {
		let s = "";
		if (this.recordingMacroReg) s += `rec @${this.recordingMacroReg} `;
		if (this.selectedRegister) s += `"${this.selectedRegister} `;
		if (this.operatorCountStr) s += this.operatorCountStr;
		if (this.operator) s += this.operator;
		if (this.countStr) s += this.countStr;
		if (this.pendingKeys) s += this.pendingKeys;
		return s.trim();
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0 || !this.config.showModeBadge) return lines;

		// Format mode badge
		let badge = " NORMAL ";
		let badgeColor = "\x1b[1;34m"; // Blue

		if (this.mode === "insert") {
			badge = " INSERT ";
			badgeColor = "\x1b[1;32m"; // Green
		} else if (this.mode === "visual") {
			badge = " VISUAL ";
			badgeColor = "\x1b[1;33m"; // Yellow
		} else if (this.mode === "visual_line") {
			badge = " V-LINE ";
			badgeColor = "\x1b[1;33m"; // Yellow
		} else if (this.mode === "visual_block") {
			badge = " V-BLOCK ";
			badgeColor = "\x1b[1;33m"; // Yellow
		} else if (this.mode === "replace") {
			badge = " REPLACE ";
			badgeColor = "\x1b[1;35m"; // Magenta
		} else if (this.mode === "search") {
			badge = ` ${this.commandPrompt}${this.commandBuffer} `;
			badgeColor = "\x1b[1;36m"; // Cyan
		} else if (this.mode === "command") {
			badge = ` :${this.commandBuffer} `;
			badgeColor = "\x1b[1;36m"; // Cyan
		}

		const modeBadge = `${badgeColor}${badge}\x1b[0m`;

		// Format right status (pending keys + cursor line:col)
		const pending = this.getPendingDisplay();
		const pendingText = pending ? `[${pending}] ` : "";
		const cur = this.getCursorPosition();
		const posText = this.config.showPosition ? `${cur.line + 1}:${cur.col + 1}` : "";
		const rightBadge = `\x1b[90m${pendingText}${posText}\x1b[0m `;

		// Replace bottom border line
		const borderIdx = lines.length - 1;
		const borderLine = lines[borderIdx] || "";
		const modeVis = visibleWidth(modeBadge);
		const rightVis = visibleWidth(rightBadge);

		if (modeVis + rightVis + 4 <= width) {
			const midLen = width - modeVis - rightVis - 2;
			const mid = "─".repeat(Math.max(0, midLen));
			const borderColor = this.borderColor || ((s: string) => s);
			lines[borderIdx] = `${borderColor("─")}${modeBadge}${borderColor(mid)}${rightBadge}${borderColor("─")}`;
		} else {
			lines[borderIdx] = truncateToWidth(borderLine, width - modeVis, "") + modeBadge;
		}

		return lines;
	}
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config = loadConfig();

	const enableVim = (ctx: any) => {
		ctx.ui.setEditorComponent(
			(tui: TUI, theme: EditorTheme, kb: KeybindingsManager) =>
				new VimEditor(tui, theme, kb),
		);
	};

	const disableVim = (ctx: any) => {
		resetTerminalCursorShape();
		ctx.ui.setEditorComponent(undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		if (config.enabled !== false) {
			enableVim(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		resetTerminalCursorShape();
	});

	pi.registerCommand("vim", {
		description: "Toggle or configure Vim modal editing (e.g. /vim, /vim on, /vim off, /vim status, /vim help)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			config = loadConfig();

			if (arg === "on" || arg === "enable") {
				config.enabled = true;
				saveConfig(config);
				enableVim(ctx);
				ctx.ui.notify("Vim mode enabled", "info");
			} else if (arg === "off" || arg === "disable") {
				config.enabled = false;
				saveConfig(config);
				disableVim(ctx);
				ctx.ui.notify("Vim mode disabled", "info");
			} else if (arg === "status") {
				ctx.ui.notify(
					`Vim Mode: ${config.enabled !== false ? "ON" : "OFF"}\n` +
						`Start Mode: ${config.startMode || "normal"}\n` +
						`Fast JK Exit: ${config.enableJkEscape !== false ? "ON" : "OFF"}\n` +
						`Clipboard Sync: ${config.syncClipboard !== false ? "ON" : "OFF"}\n` +
						`Cursor Morphing: ${config.cursorShape !== false ? "ON" : "OFF"}`,
					"info",
				);
			} else if (arg === "help") {
				ctx.ui.notify(
					"Vim Mode Reference:\n\n" +
						"Modes: Normal (Esc), Insert (i, a, o, s, C), Visual (v, V, Ctrl+V), Replace (R)\n" +
						"Motions: h/j/k/l, w/b/e/ge, 0/^/$, gg/G, f/F/t/T, %, {/}, H/M/L\n" +
						"Text Objects: iw/aw, i\"/a\", i(/a(, i[/a[, i{/a{, i</a<, ip/ap\n" +
						"Operators: d (delete), c (change), y (yank), > (indent), < (unindent)\n" +
						"Editing: x/X, r, ~, J, p/P, u, Ctrl+R, . (repeat)\n" +
						"Marks & Macros: m{a-z}, '{a-z}, q{a-z}, @{a-z}, @@\n" +
						"Ex Commands: :%s/old/new/g, :quote, :unquote, :fence [lang], :reflow 80, :w (submit), :q (exit), :noh\n" +
						"Fast exit: jk or jj in Insert mode",
					"info",
				);
			} else {
				// Toggle
				config.enabled = !config.enabled;
				saveConfig(config);
				if (config.enabled) {
					enableVim(ctx);
					ctx.ui.notify("Vim mode enabled", "info");
				} else {
					disableVim(ctx);
					ctx.ui.notify("Vim mode disabled", "info");
				}
			}
		},
	});

	// Register /vimmode alias
	pi.registerCommand("vimmode", {
		description: "Alias for /vim command",
		handler: async (args, ctx) => {
			const commands = pi.getCommands?.();
			const vimCmd = commands?.find((c) => c.name === "vim");
			if (vimCmd) {
				// execute /vim
				pi.sendUserMessage(`/vim ${args || ""}`, { expandPromptTemplates: true });
			}
		},
	});

	pi.registerShortcut("ctrl+alt+v", {
		description: "Toggle Vim mode",
		handler: async (ctx) => {
			config = loadConfig();
			config.enabled = !config.enabled;
			saveConfig(config);
			if (config.enabled) {
				enableVim(ctx);
				ctx.ui.notify("Vim mode enabled", "info");
			} else {
				disableVim(ctx);
				ctx.ui.notify("Vim mode disabled", "info");
			}
		},
	});
}
