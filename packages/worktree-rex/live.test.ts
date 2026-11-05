/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

// Explicit opt-in: opens real tabs, but only inside a disposable session, never the user's tabs.
test("live Rex: create an interactive Pi tab, discover, rename, switch, and remove it", {
	skip: process.env.REX_LIVE_TEST !== "1", timeout: 60_000,
}, async () => {
	const rex = (...args: string[]) => execFileSync("rex", ["--autostart=false", ...args], { encoding: "utf8", timeout: 15_000 });
	const identity = JSON.parse(rex("whoami", "--json"));
	assert.match(identity.endpoint, /^unix:\/\//);
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-rex-live-")));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
	const previous = { REX_SESSION: process.env.REX_SESSION, REX_BLOCK: process.env.REX_BLOCK };
	let sessionId: string | undefined;
	try {
		sessionId = JSON.parse(rex("new", `worktree-rex-smoke-${process.pid}`, "-c", root, "--window", "keep", "--json", "--", "sleep", "120")).session_id;
		assert.ok(sessionId);
		process.env.REX_SESSION = sessionId;
		delete process.env.REX_BLOCK;
		const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		extension({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
			on: () => () => {} } as unknown as ExtensionAPI);
		const invoke = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!
			.execute("smoke", params, new AbortController().signal, undefined, { cwd: root } as ExtensionContext);
		const created = await invoke("worktree_create", { branchName: "topic/cli-smoke", baseBranch: "main" });
		assert.notEqual(created.isError, true, JSON.stringify(created));
		const target = created.details.terminalTarget;
		assert.equal(target.sessionId, sessionId);
		let processInfo;
		for (let attempt = 0; attempt < 40; attempt++) {
			processInfo = JSON.parse(rex("block", "call", "-s", sessionId, "-b", target.blockId, "process"));
			if (processInfo.foreground?.name === "node") break;
			await setTimeout(250);
		}
		assert.equal(processInfo.foreground?.name, "node", JSON.stringify(processInfo));
		assert.equal(processInfo.foreground.cwd, created.details.worktreePath);
		assert.match((await invoke("worktree_list")).content[0].text, /Rex:active/);
		assert.notEqual((await invoke("worktree_rename", { oldBranch: "topic/cli-smoke", newBranch: "renamed" })).isError, true);
		const notifications: Array<{ message: string; level?: string }> = [];
		await commands.get("worktree")!.handler("switch renamed", { cwd: root,
			ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) } } as unknown as ExtensionCommandContext);
		assert.equal(notifications.at(-1)?.level, "info", JSON.stringify(notifications));
		const inspected = JSON.parse(rex("session", "inspect", sessionId, "--json"));
		assert.equal(inspected.active_window_id, target.windowId);
		assert.equal(inspected.windows.find((window: { window_id: string }) => window.window_id === target.windowId).label, "wt:renamed");
		assert.notEqual((await invoke("worktree_remove", { branchName: "renamed" })).isError, true);
		assert.equal(fs.existsSync(created.details.worktreePath), false);
		assert.equal(JSON.parse(rex("session", "inspect", sessionId, "--json")).windows.length, 1, "the shared session and unrelated keep tab survive");
	} finally {
		if (sessionId) rex("kill", sessionId);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
