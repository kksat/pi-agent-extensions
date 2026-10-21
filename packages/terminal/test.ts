/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Terminal } from "@xterm/headless";

// Exercise the registered shortcut and real Neovim PTY, using a second terminal
// emulator as the host screen. No user's Neovim config or buffers are touched.
const home = mkdtempSync(join(tmpdir(), "pi-terminal-test-"));
const previousHome = process.env.HOME;
let hostWrites = 0;
const stdinListeners = process.stdin.listenerCount("data");
const resizeListeners = process.stdout.listenerCount("resize");
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const stdinMethods = ["read", "resume", "pause", "setRawMode"] as const;
const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
let state: typeof globalThis.__PI_TERMINAL_STATE__;
let detach: Promise<void> | undefined;

function patch(object: object, name: string, value: unknown) {
	const key = `${object === process.stdout ? "stdout" : "stdin"}.${name}`;
	descriptors.set(key, Object.getOwnPropertyDescriptor(object, name));
	Object.defineProperty(object, name, { configurable: true, writable: true, value });
}

async function flush(term: Terminal) {
	await new Promise<void>((resolve) => term.write("", resolve));
}

async function waitFor(predicate: () => boolean, message: string) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert(Date.now() < deadline, message);
		await delay(10);
	}
	await delay(100);
	await flush(host);
}

function snapshot(term: Terminal) {
	const buffer = term.buffer.active;
	return Array.from({ length: term.rows }, (_, y) => {
		const line = buffer.getLine(buffer.viewportY + y)!;
		return Array.from({ length: term.cols }, (_, x) => {
			const cell = line.getCell(x)!;
			return {
				text: cell.getChars() || " ", width: cell.getWidth(),
				fgMode: cell.getFgColorMode(), fg: cell.getFgColor(),
				bgMode: cell.getBgColorMode(), bg: cell.getBgColor(),
				bold: cell.isBold(), dim: cell.isDim(), italic: cell.isItalic(),
				underline: cell.isUnderline(), inverse: cell.isInverse(),
			};
		});
	});
}

try {
	execFileSync("nvim", ["--version"], { stdio: "ignore" });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const init = join(home, "init.vim");
	writeFileSync(init, [
		"set termguicolors noswapfile nobackup nowritebackup noshowmode noruler",
		"set laststatus=0 signcolumn=no foldcolumn=0 mouse=a",
		"call setline(1, ['rendering regression', 'bold plain italic plain', 'wide: 中文 end', 'background before hide'])",
		"hi Normal guifg=#ddeeff guibg=#112233",
		"hi TestBold gui=bold guifg=#ff6677 guibg=#334455",
		"hi TestItalic gui=italic guifg=#66ff77 guibg=#112233",
		"call matchadd('TestBold', 'bold')",
		"call matchadd('TestItalic', 'italic')",
	].join("\n"));
	writeFileSync(join(home, ".pi", "agent", "pi-terminal.json"), JSON.stringify({
		terminals: [{ key: "alt+e", name: "test-editor", command: `nvim --clean -n -i NONE -u '${init}'`, mode: "passthrough", gracePeriodMs: 0 }],
	}));
	process.env.HOME = home;
	patch(process.stdout, "columns", 80);
	patch(process.stdout, "rows", 24);
	patch(process.stdout, "write", (data: string | Buffer) => { hostWrites++; host.write(data); return true; });
	for (const name of stdinMethods) patch(process.stdin, name, () => name === "read" ? null : process.stdin);

	const { default: terminal } = await import("./index.ts");
	let shortcut: (ctx: any) => Promise<void>;
	terminal({
		registerShortcut: (_key: string, registration: any) => { shortcut = registration.handler; },
		registerCommand() {}, on() {},
	} as any);
	const ctx = {
		mode: "tui", cwd: home,
		sessionManager: { getSessionId: () => "test", getSessionName: () => "test" },
		ui: {
			notify() {}, setStatus() {},
			custom: (factory: any) => new Promise<void>((resolve, reject) => {
				Promise.resolve(factory({ stop() {}, start() {}, requestRender() {} }, {}, {}, resolve)).catch(reject);
			}),
		},
	};
	detach = shortcut!(ctx);
	state = globalThis.__PI_TERMINAL_STATE__!;
	const session = state.passthroughSessions.get("test-editor")!;
	await waitFor(() => host.buffer.active.getLine(0)?.translateToString(true).includes("rendering regression") === true, "Neovim did not draw its initial screen");
	const before = snapshot(host);
	const modesBefore = host.modes;
	process.stdin.emit("data", "\x1be");
	await detach;
	assert(session.paused, "hotkey hides the existing editor");
	detach = shortcut!(ctx);
	await delay(150);
	await flush(host);
	const after = snapshot(host);
	const differences = before.flatMap((row, y) => row.flatMap((cell, x) =>
		JSON.stringify(cell) === JSON.stringify(after[y][x]) ? [] : [{ row: y + 1, col: x + 1, before: cell, after: after[y][x] }],
	));
	assert.equal(differences.length, 0, `Neovim rendering changed after hide/reopen (${differences.length} cells): ${JSON.stringify(differences.filter((d) => d.before.text.trim() || d.after.text.trim() || d.before.bg !== d.after.bg).slice(0, 6))}`);
	console.error("PASS: Neovim screen and styling survive hide/reopen");
	const modesAfter = host.modes;

	process.stdin.emit("data", "\x1be");
	await detach;
	const writesWhileHidden = hostWrites;
	session.pty.write(":call setline(4, 'background after hide')\r");
	await waitFor(() => session.term.buffer.active.getLine(3)?.translateToString(true).includes("background after hide") === true, "Hidden output did not reach the saved screen");
	assert.equal(hostWrites, writesWhileHidden, "Hidden output must not reach Pi's host terminal");
	detach = shortcut!(ctx);
	await delay(150);
	await flush(host);
	assert(host.buffer.active.getLine(3)?.translateToString(true).includes("background after hide"), "Output produced while hidden was lost");
	console.error("PASS: Neovim screen includes output produced while hidden");
	assert.deepEqual(modesAfter, modesBefore, "Neovim terminal modes changed after hide/reopen");
	console.error("PASS: Neovim terminal modes survive hide/reopen");

	for (let cycle = 0; cycle < 10; cycle++) {
		process.stdin.emit("data", "\x1be");
		await detach;
		assert.equal(process.stdin.listenerCount("data"), stdinListeners, "No input listener leak on hide");
		assert.equal(process.stdout.listenerCount("resize"), resizeListeners, "No resize listener leak on hide");
		detach = shortcut!(ctx);
		await waitFor(() => !session.paused, "Editor did not reattach");
		assert.deepEqual(snapshot(host), snapshot(session.term), `Screen corrupted on reopen ${cycle + 1}`);
	}
	console.error("PASS: ten consecutive hide/reopen cycles without corruption or listener leaks");

	process.stdin.emit("data", "\x1be");
	await detach;
	Object.defineProperty(process.stdout, "columns", { value: 60 });
	Object.defineProperty(process.stdout, "rows", { value: 18 });
	host.resize(60, 18);
	detach = shortcut!(ctx);
	await waitFor(() => !session.paused && session.term.cols === 60, "Editor did not resize on reopen");
	await flush(session.term);
	await flush(host);
	const resizedHost = snapshot(host);
	const resizedSaved = snapshot(session.term);
	const resizeDifferences = resizedSaved.flatMap((row, y) => row.flatMap((cell, x) =>
		JSON.stringify(cell) === JSON.stringify(resizedHost[y][x]) ? [] : [{ row: y + 1, col: x + 1, expected: cell, actual: resizedHost[y][x] }],
	));
	assert.equal(resizeDifferences.length, 0, `Resized screen differs in ${resizeDifferences.length} cells: ${JSON.stringify(resizeDifferences.slice(0, 3))}`);
	console.error("PASS: resize while hidden");

	process.stdin.emit("data", "\x1be");
	await detach;
	const writesBeforeExit = hostWrites;
	session.pty.write(":qa!\r");
	await waitFor(() => !state!.passthroughSessions.has("test-editor"), "Hidden editor did not exit");
	assert.equal(hostWrites, writesBeforeExit, "A hidden editor exiting must not reset Pi's terminal");
	console.error("PASS: hidden editor exit leaves Pi's terminal untouched");
} finally {
	if (state) {
		for (const session of state.passthroughSessions.values()) {
			session.detachResolver?.();
			session.pty.kill();
			session.term.dispose();
		}
		state.passthroughSessions.clear();
	}
	await delay(100);
	for (const [key, descriptor] of descriptors) {
		const [stream, name] = key.split(".");
		const object = stream === "stdout" ? process.stdout : process.stdin;
		if (descriptor) Object.defineProperty(object, name, descriptor);
		else delete (object as any)[name];
	}
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	host.dispose();
	rmSync(home, { recursive: true, force: true });
}
