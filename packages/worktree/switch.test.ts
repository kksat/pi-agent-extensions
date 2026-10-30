/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Tmux window discovery for /worktree switch and list.
//   node --experimental-strip-types packages/worktree/switch.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

interface StatusRow {
	branch?: string;
	isMain: boolean;
	isManaged: boolean;
	tmuxActive: boolean;
	tmuxTarget?: string;
}

function fixture(t: TestContext) {
	const tmuxBinary = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout?.trim();
	if (!tmuxBinary) {
		t.skip("tmux is not installed");
		return;
	}
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-switch-")));
	const socket = `pi-worktree-switch-${process.pid}-${path.basename(dir)}`;
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
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nsleep 300\n`, { mode: 0o755 });
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
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
	git("worktree", "add", "-b", "topic", checkout);
	assert.equal(tmux("new-session", "-d", "-s", "host", "-n", "keep", "-c", root, "sleep 300").status, 0);
	const newWindow = (name: string, cwd = checkout, session = "host") => {
		const result = tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", `${session}:`, "-n", name, "-c", cwd, "sleep 300");
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const windowLines = (...args: string[]) => tmux("list-windows", ...args).stdout.trim().split("\n").filter(Boolean);
	const exists = (window: string) => windowLines("-a", "-F", "#{window_id}").includes(window);
	const activeWindow = (session = "host") => {
		const active = windowLines("-t", session, "-F", "#{window_id}\t#{window_active}").find((line) => line.endsWith("\t1"));
		return active ? active.slice(0, -2) : null;
	};
	const windowIdByName = (name: string, session = "host") => {
		const line = windowLines("-t", session, "-F", "#{window_id}\t#{window_name}").find((entry) => entry.endsWith(`\t${name}`));
		return line ? line.slice(0, -name.length - 1) : null;
	};
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
	const statuses = async (): Promise<StatusRow[]> => {
		const result = await tools.get("worktree_list")!.execute("test", {}, new AbortController().signal, undefined, { cwd: root } as ExtensionContext);
		assert.notEqual(result.isError, true, result.content?.[0]?.type === "text" ? result.content[0].text : undefined);
		return result.details.worktrees;
	};
	const runCommand = async (args: string, messages: string[]) => {
		await commands.get("worktree")!.handler(args, {
			cwd: root,
			hasUI: true,
			ui: { notify: (message: string) => messages.push(message) },
		} as ExtensionCommandContext);
	};
	return { root, checkout, git, tmux, newWindow, exists, activeWindow, windowIdByName, register, statuses, runCommand };
}

test("a stale window record does not borrow the shared parent session as its target", async (t) => {
	const f = fixture(t);
	if (!f) return;
	f.register({ tmuxSession: "host", tmuxWindowId: "@999999" });
	const topic = (await f.statuses()).find((status) => status.branch === "topic");
	assert.equal(topic?.tmuxActive, false, "the shared session must not masquerade as the worktree's window");
	assert.equal(topic?.tmuxTarget, undefined);
});

test("the window running inside the checkout is discovered despite a stale record", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const agent = f.newWindow("agent");
	f.register({ tmuxSession: "host", tmuxWindowId: "@999999" });
	const topic = (await f.statuses()).find((status) => status.branch === "topic");
	assert.equal(topic?.tmuxActive, true);
	assert.equal(topic?.tmuxTarget, agent);
});

test("discovery finds renamed and unmanaged worktree windows by checkout path", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const agent = f.newWindow("renamed");
	const topic = (await f.statuses()).find((status) => status.branch === "topic");
	assert.equal(topic?.isManaged, false);
	assert.equal(topic?.tmuxActive, true);
	assert.equal(topic?.tmuxTarget, agent);
});

test("the primary checkout's own windows are not reported as its tmux activity", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const main = (await f.statuses()).find((status) => status.branch === "main");
	assert.equal(main?.isMain, true);
	assert.equal(main?.tmuxActive, false);
});

test("a live recorded window stays the target even after its panes moved away", async (t) => {
	const f = fixture(t);
	if (!f) return;
	const agent = f.newWindow("wt:topic", f.root); // The agent has changed its cwd.
	f.register({ tmuxSession: "host", tmuxWindowId: agent });
	const topic = (await f.statuses()).find((status) => status.branch === "topic");
	assert.equal(topic?.tmuxActive, true);
	assert.equal(topic?.tmuxTarget, agent);
});

test("dedicated worktree sessions remain switch targets", async (t) => {
	const f = fixture(t);
	if (!f) return;
	assert.equal(f.tmux("new-session", "-d", "-s", "pi-wt-topic", "-c", f.checkout, "sleep 300").status, 0);
	f.register({ tmuxSession: "pi-wt-topic", tmuxWindowId: "@999999" });
	const topic = (await f.statuses()).find((status) => status.branch === "topic");
	assert.equal(topic?.tmuxActive, true);
	assert.equal(topic?.tmuxTarget, "pi-wt-topic");
});

test("a dedicated session is found by record even when its window left the checkout", async (t) => {
	const f = fixture(t);
	if (!f) return;
	assert.equal(f.tmux("new-session", "-d", "-s", "pi-wt-topic", "-c", f.root, "sleep 300").status, 0);
	f.register({ tmuxSession: "pi-wt-topic", tmuxWindowId: "@999999" });
	const topic = (await f.statuses()).find((status) => status.branch === "topic");
	assert.equal(topic?.tmuxActive, true);
	assert.equal(topic?.tmuxTarget, "pi-wt-topic");
});
