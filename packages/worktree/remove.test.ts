/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function fixture(t: TestContext) {
	const tmuxBinary = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout?.trim();
	if (!tmuxBinary) {
		t.skip("tmux is not installed");
		return;
	}
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-remove-")));
	const socket = `pi-worktree-remove-${process.pid}-${path.basename(dir)}`;
	const previous = { PATH: process.env.PATH, TMUX: process.env.TMUX, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	const tmux = (...args: string[]) => spawnSync(tmuxBinary, ["-L", socket, ...args], { encoding: "utf8" });
	t.after(() => {
		tmux("kill-server");
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\nexec '${tmuxBinary}' -L '${socket}' "$@"\n`, { mode: 0o755 });
	process.env.PATH = `${bin}${path.delimiter}${previous.PATH}`;
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
	delete process.env.TMUX;

	const root = path.join(dir, "repo");
	const checkout = path.join(dir, "repo-topic");
	fs.mkdirSync(root);
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
	git("worktree", "add", "-b", "topic", checkout);
	assert.equal(tmux("new-session", "-d", "-s", "host", "-n", "keep", "-c", root, "sleep 300").status, 0);
	const newWindow = (name: string, cwd = checkout, session = "host") => {
		const result = tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", `${session}:`, "-n", name, "-c", cwd, "sleep 300");
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const exists = (window: string) => tmux("list-windows", "-a", "-F", "#{window_id}").stdout.trim().split("\n").includes(window);
	const register = (metadata: Record<string, unknown>) => {
		fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(root, ".pi", "worktrees.json"), JSON.stringify({
			version: 1,
			worktrees: { topic: { branch: "topic", path: checkout, createdAt: Date.now(), ...metadata } },
			known: [{ branch: "topic", path: checkout, createdAt: Date.now() }],
		}));
	};
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	extension({
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		on: () => () => {},
	} as Pick<ExtensionAPI, "registerCommand" | "registerTool" | "on"> as ExtensionAPI);
	const invoke = (name = "worktree_remove", params = { branchName: "topic", deleteBranch: true }) =>
		tools.get(name)!.execute("test", params, new AbortController().signal, undefined, { cwd: root } as ExtensionContext);
	return { root, checkout, git, tmux, newWindow, exists, register, invoke, bin, commands };
}

test("remove closes an unrecorded worktree window with a colon in its name, preserving the host", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic");
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(fs.existsSync(f.checkout), false);
	assert.equal(f.exists(window), false, "the worktree's tmux window must be deleted");
	assert.equal(f.tmux("has-session", "-t", "host").status, 0, "the parent session must survive");
});

test("remove finds renamed windows across sessions and subdirectories without closing unrelated names", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const subdir = path.join(f.checkout, "subdir");
	fs.mkdirSync(subdir);
	assert.equal(f.tmux("new-session", "-d", "-s", "other", "-c", f.root, "sleep 300").status, 0);
	const first = f.newWindow("renamed");
	const second = f.newWindow("attention!", subdir, "other");
	const unrelated = f.newWindow("wt:topic", f.root);
	const sibling = `${f.checkout}-other`;
	fs.mkdirSync(sibling);
	const nearby = f.newWindow("wt:topic", sibling, "other");
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(f.exists(first), false);
	assert.equal(f.exists(second), false);
	assert.equal(f.exists(unrelated), true, "a matching name alone does not establish ownership");
	assert.equal(f.exists(nearby), true, "a path prefix alone does not establish ownership");
});

test("recorded window IDs close the worktree window but leave its shared session intact", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic", f.root); // Agent has changed its cwd.
	f.register({ tmuxWindowId: window, tmuxSession: "host" });
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(f.exists(window), false);
	assert.equal(f.tmux("has-session", "-t", "host").status, 0);
});

test("stale window IDs fall back to checkout paths, never the shared parent session", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("renamed");
	f.register({ tmuxWindowId: "@999999", tmuxSession: "host" });
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(f.exists(window), false);
	assert.equal(f.tmux("has-session", "-t", "host").status, 0);
});

test("legacy name records are matched literally within their recorded session", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic", f.root);
	assert.equal(f.tmux("new-session", "-d", "-s", "other", "-c", f.root, "sleep 300").status, 0);
	const unrelated = f.newWindow("wt:topic", f.root, "other");
	f.register({ tmuxWindowId: "wt:topic", tmuxSession: "host" });
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(f.exists(window), false);
	assert.equal(f.exists(unrelated), true);
	assert.equal(f.tmux("has-session", "-t", "host").status, 0);
});

test("legacy names without a session are not used to close unrelated windows", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic");
	const unrelated = f.newWindow("wt:topic", f.root);
	f.register({ tmuxWindowId: "wt:topic" });
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(f.exists(window), false);
	assert.equal(f.exists(unrelated), true);
});

test("clean closes managed windows without killing their shared parent session", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic");
	f.register({ tmuxWindowId: window, tmuxSession: "host" });
	const result = await f.invoke("worktree_clean");
	assert.deepEqual(result.details.failed, []);
	assert.equal(result.details.cleaned.length, 1);
	assert.equal(f.exists(window), false);
	assert.equal(f.tmux("has-session", "-t", "host").status, 0);
	const registry = JSON.parse(fs.readFileSync(path.join(f.root, ".pi", "worktrees.json"), "utf8"));
	assert.deepEqual(registry.worktrees, {});
	assert.equal(registry.known[0].path, f.checkout, "session history remains reachable");
});

test("dedicated worktree sessions disappear when their windows are closed", async (t) => {
	const f = fixture(t);
	if (!f) return;
	assert.equal(f.tmux("new-session", "-d", "-s", "pi-wt-topic", "-c", f.root, "sleep 300").status, 0);
	f.register({ tmuxSession: "pi-wt-topic" });
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.notEqual(f.tmux("has-session", "-t", "pi-wt-topic").status, 0);
	assert.equal(f.tmux("has-session", "-t", "host").status, 0);
});

test("window cleanup still runs when branch deletion is disabled", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic");
	const result = await f.invoke("worktree_remove", { branchName: "topic", deleteBranch: false });
	assert.notEqual(result.isError, true);
	assert.equal(f.exists(window), false);
	assert.equal(f.git("rev-parse", "--verify", "refs/heads/topic").length > 0, true);
});

test("failed window cleanup reports an error and preserves the worktree and metadata", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic");
	f.register({ tmuxWindowId: window, tmuxSession: "host" });
	const wrapper = path.join(f.bin, "tmux");
	const script = fs.readFileSync(wrapper, "utf8");
	fs.writeFileSync(wrapper, script.replace("exec ", 'if [ "$1" = "kill-window" ]; then echo "denied" >&2; exit 1; fi\nexec '));
	const result = await f.invoke();
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Cannot close tmux window.*denied/);
	assert.equal(f.exists(window), true);
	assert.equal(fs.existsSync(f.checkout), true);
	const registry = JSON.parse(fs.readFileSync(path.join(f.root, ".pi", "worktrees.json"), "utf8"));
	assert.ok(registry.worktrees.topic);
});

test("a stopped tmux server does not prevent worktree removal", async (t) => {
	const f = fixture(t);
	if (!f) return;
	f.tmux("kill-server");
	const result = await f.invoke();
	assert.notEqual(result.isError, true);
	assert.equal(fs.existsSync(f.checkout), false);
});

test("slash-command removal uses the same window cleanup", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const window = f.newWindow("wt:topic");
	const messages: string[] = [];
	await f.commands.get("worktree")!.handler("remove topic", {
		cwd: f.root,
		hasUI: true,
		ui: { confirm: async () => true, notify: (message: string) => messages.push(message) },
	} as ExtensionCommandContext);
	assert.equal(f.exists(window), false);
	assert.equal(fs.existsSync(f.checkout), false);
	assert.ok(messages.some((message) => message.includes("Successfully removed")));
});
