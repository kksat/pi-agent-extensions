/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { clear, installHooks, mark, MARKER, windowForPane } from "./tmux-attention.mjs";
import extension from "./index.ts";

// Use a separate server: tests must not change the user's live windows/hooks.
const directory = mkdtempSync(join(tmpdir(), "pi-tmux-'attention "));
const socket = join(directory, "server.sock");
function tmux(...args) {
	return execFileSync("tmux", ["-S", socket, ...args], {
		encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\n$/, "");
}
function name(window) {
	return tmux("display-message", "-p", "-t", window, "#{window_name}");
}
function option(window, key) {
	return tmux("show-options", "-wqv", "-t", window, key);
}
async function waitFor(predicate) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await sleep(20);
	}
	assert.fail("tmux hook did not complete");
}

try {
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "first", "/bin/sh");
	const first = tmux("display-message", "-p", "-t", "test:0", "#{window_id}");
	const pane = tmux("display-message", "-p", "-t", first, "#{pane_id}");
	const second = tmux("new-window", "-P", "-F", "#{window_id}", "-t", "test", "-n", "second", "/bin/sh");
	tmux("set-option", "-g", "automatic-rename", "off");

	await test("resolves the actual owning window, not the active window", () => {
		assert.equal(windowForPane(socket, pane), first);
		assert.throws(() => windowForPane(socket, "test:0"), /Invalid/);
	});

	await test("marks once and restores the exact name and inherited options", () => {
		const original = "task ' ; $HOME #{window_id}  ";
		tmux("rename-window", "-t", first, original.replace(/#/g, "##"));
		tmux("set-option", "-wu", "-t", first, "automatic-rename");
		tmux("set-option", "-wu", "-t", first, "allow-rename");
		mark(socket, first, "pi1");
		mark(socket, first, "pi1");
		assert.equal(name(first), MARKER + original);
		assert.equal(option(first, "automatic-rename"), "off");
		assert.equal(option(first, "allow-rename"), "off");
		clear(socket, first, "pi1");
		assert.equal(name(first), original);
		assert.equal(option(first, "automatic-rename"), "");
		assert.equal(option(first, "allow-rename"), "");
		assert.equal(option(first, "@pi_attention"), "");
		clear(socket, first);
	});

	await test("preserves explicit rename options, including automatic-rename on", () => {
		tmux("set-option", "-w", "-t", first, "automatic-rename", "on");
		tmux("set-option", "-w", "-t", first, "allow-rename", "on");
		mark(socket, first, "pi1");
		assert.equal(option(first, "automatic-rename"), "off");
		clear(socket, first);
		assert.equal(option(first, "automatic-rename"), "on");
		assert.equal(option(first, "allow-rename"), "on");
		tmux("rename-window", "-t", first, "first");
	});

	await test("does not overwrite a manual rename while marked", () => {
		mark(socket, first, "pi1");
		tmux("rename-window", "-t", first, "new custom name");
		clear(socket, first);
		assert.equal(name(first), "new custom name");
		assert.equal(option(first, "automatic-rename"), "off");
	});

	await test("one agent cannot clear another agent's attention in the same window", () => {
		mark(socket, first, "pi1");
		mark(socket, first, "pi2");
		clear(socket, first, "pi1");
		assert.equal(name(first), MARKER + "new custom name");
		clear(socket, first, "pi2");
		assert.equal(name(first), "new custom name");
	});

	await test("selection hooks clear only the selected window and preserve existing hooks", async () => {
		tmux("set-hook", "-g", "session-window-changed[12]", "set-option -g @test-existing-hook yes");
		installHooks(socket);
		installHooks(socket); // Reloads do not duplicate hooks.
		assert.match(tmux("show-hooks", "-g", "session-window-changed"), /\[12\]/);
		mark(socket, first, "pi1");
		mark(socket, second, "pi2");
		tmux("select-window", "-t", first);
		await waitFor(() => option(first, "@pi_attention") === "");
		assert.equal(name(first), "new custom name");
		assert.equal(name(second), MARKER + "second");
		assert.equal(tmux("show-options", "-gqv", "@test-existing-hook"), "yes");
		tmux("select-window", "-t", second);
		await waitFor(() => name(second) === "second");
	});

	await test("client focus hook clears the currently selected window", async () => {
		mark(socket, second, "pi2");
		tmux("set-hook", "-R", "-t", second, "client-focus-in");
		await waitFor(() => name(second) === "second");
	});

	await test("Pi lifecycle marks settled turns/dialogs and cleans up focus, input, aborts and reload", () => {
		const previousTmux = process.env.TMUX;
		const previousPane = process.env.TMUX_PANE;
		process.env.TMUX = `${socket},${process.pid},0`;
		process.env.TMUX_PANE = pane;
		const handlers = new Map();
		let terminalInput;
		let unsubscribed = false;
		const ctx = { mode: "tui", ui: {
			notify: (message) => assert.fail(message),
			onTerminalInput: (handler) => {
				terminalInput = handler;
				return () => { unsubscribed = true; };
			},
		} };
		extension({ on: (event, handler) => handlers.set(event, handler) });
		const emit = (event, data = {}) => handlers.get(event)(data, ctx);
		try {
			emit("session_start");
			emit("agent_settled", { aborted: false });
			assert.equal(name(first), MARKER + "new custom name");
			emit("input", { source: "extension" });
			assert.ok(name(first).startsWith(MARKER));
			emit("input", { source: "interactive" });
			assert.equal(name(first), "new custom name");
			emit("ui_prompt_start");
			assert.ok(name(first).startsWith(MARKER));
			emit("ui_prompt_end");
			assert.equal(name(first), "new custom name");
			emit("agent_settled", { aborted: true });
			assert.equal(name(first), "new custom name");
			emit("agent_settled", { aborted: false });
			assert.equal(terminalInput("\x1b[O"), undefined); // Focus-out must not acknowledge.
			assert.ok(name(first).startsWith(MARKER));
			assert.equal(terminalInput("\x1b[I"), undefined);
			assert.equal(name(first), "new custom name");
			emit("agent_settled", { aborted: false });
			emit("agent_start");
			assert.equal(name(first), "new custom name");
			emit("agent_settled", { aborted: false });
			emit("session_shutdown", { reason: "reload" });
			assert.equal(name(first), "new custom name");
			assert.ok(unsubscribed);
			emit("session_shutdown", { reason: "quit" }); // Idempotent.
		} finally {
			clear(socket, first);
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
			if (previousPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = previousPane;
		}
	});

	await test("non-interactive Pi sessions do not install hooks or mark windows", () => {
		const handlers = new Map();
		extension({ on: (event, handler) => handlers.set(event, handler) });
		handlers.get("session_start")({}, { mode: "rpc" });
		handlers.get("agent_settled")({ aborted: false });
		assert.equal(name(first), "new custom name");
	});

	await test("refuses to replace an occupied hook slot", () => {
		tmux("set-hook", "-g", "client-focus-in[777001]", "display-message occupied");
		assert.throws(() => installHooks(socket), /occupied/);
	});
} finally {
	try { tmux("kill-server"); } catch {}
	rmSync(directory, { recursive: true, force: true });
}
