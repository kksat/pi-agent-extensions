/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerWorktree from "../worktree/index.ts";
import extension from "./index.ts";
import { RexTerminal, type RexRun } from "./rex.ts";

const target = { sessionId: "session:host", windowId: "window:topic", blockId: "block:topic" };

function server() {
	const calls: string[][] = [];
	const windows = new Map<string, { session: string; cwd: string; block: string; host?: string }>();
	const state = { session: "session:host" as string | undefined, endpoint: "unix:///tmp/rex-test.sock", active: "window:keep", fail: "" };
	const run: RexRun = async (args) => {
		calls.push(args);
		if (state.fail && args.join(" ").includes(state.fail)) throw new Error("denied");
		const option = (name: string) => args[args.indexOf(name) + 1];
		if (args[0] === "whoami") return JSON.stringify({ endpoint: state.endpoint, session_id: state.session, host_id: "local" });
		if (args[0] === "ls") return JSON.stringify({ sessions: [...new Set(["session:host", ...[...windows.values()].map((w) => w.session)])].map((session_id) => ({ session_id })) });
		if (args[0] === "session") return JSON.stringify({ session_id: args[2], active_window_id: state.active,
			windows: [...windows].filter(([, w]) => w.session === args[2]).map(([window_id, w]) => ({ window_id,
				layers: [{ blocks: [{ block_id: w.block, creator_name: "com.superlogical.terminal", host_id: w.host ?? "local" }] }] })) });
		if (args[0] === "block") {
			const window = [...windows.values()].find((w) => w.block === option("-b"));
			return JSON.stringify({ foreground: { cwd: window?.cwd } });
		}
		if (args[0] === "new" || args[0] === "window" && args[1] === "new") {
			const session = args[0] === "new" ? "session:dedicated" : option("-s");
			windows.set(target.windowId, { session, cwd: option("-c"), block: target.blockId });
			const window = { window_id: target.windowId, block_ids: [target.blockId] };
			return JSON.stringify(args[0] === "new" ? { session_id: session, initial_windows: [window] } : window);
		}
		if (args[0] === "focus") state.active = args[args.length - 1];
		if (args[0] === "window" && args[1] === "close") windows.delete(args[args.length - 1]);
		return "";
	};
	return { calls, windows, state, run, terminal: new RexTerminal(run, { REX_SESSION: "session:host", REX_BLOCK: "block:keep" }) };
}

test("spawn creates a background Rex tab with argv-safe pi name, cwd, and no prompt", async () => {
	const f = server();
	const branch = 'feature/$HOME;echo-unsafe';
	assert.deepEqual(await f.terminal.spawn("/tmp/repo with spaces", branch), target);
	assert.deepEqual(f.calls[1], ["window", "new", "-s", "session:host", "wt:feature-$HOME;echo-unsafe", "--focus=false",
		"-c", "/tmp/repo with spaces", "--keep-open", "--json", "--", "pi", "--name", `wt:${branch}`]);
});

test("outside Rex creates one dedicated session rather than choosing an unrelated session", async () => {
	const f = server();
	f.state.session = undefined;
	const terminal = new RexTerminal(f.run, {});
	assert.equal((await terminal.spawn("/tmp/repo", "topic")).sessionId, "session:dedicated");
	assert.deepEqual(f.calls[1].slice(0, 4), ["new", "pi-wt-topic", "--window", "wt:topic"]);
});

test("stale inherited sessions and remote servers fail before creating tabs", async () => {
	const f = server();
	f.state.session = "session:other";
	await assert.rejects(f.terminal.spawn("/tmp/repo", "topic"), /stale/);
	f.state.endpoint = "https://remote.invalid";
	await assert.rejects(f.terminal.spawn("/tmp/repo", "topic"), /local Rex server/);
	assert.equal(f.calls.some((c) => c.includes("new")), false);
});

test("failed or malformed creation is not retried, avoiding duplicate tabs", async () => {
	let attempts = 0;
	for (const response of ["not json", "{}"] ) {
		const run: RexRun = async (args) => {
			if (args[0] === "whoami") return JSON.stringify({ endpoint: "unix:///tmp/rex.sock" });
			attempts++;
			return response;
		};
		await assert.rejects(new RexTerminal(run, {}).spawn("/tmp/repo", "topic"));
	}
	assert.equal(attempts, 2);
});

test("discovery uses recorded IDs or checkout paths, not names or sibling prefixes", async () => {
	const f = server();
	f.windows.set("window:unrelated", { session: "session:host", cwd: "/tmp/repo-topic-sibling", block: "block:unrelated" });
	f.windows.set("window:discovered", { session: "session:other", cwd: "/tmp/repo-topic/src", block: "block:found" });
	const found = await f.terminal.find("/tmp/repo-topic", target);
	assert.equal(found?.windowId, "window:discovered");
	f.windows.set(target.windowId, { session: target.sessionId, cwd: "/tmp/elsewhere", block: target.blockId });
	assert.deepEqual(await f.terminal.find("/tmp/repo-topic", target), target);
	assert.equal(await f.terminal.find("/tmp/missing"), undefined);
});

test("list discovery takes one snapshot for all checkouts", async () => {
	const f = server();
	f.windows.set("window:first", { session: "session:host", cwd: "/tmp/first", block: "block:first" });
	f.windows.set("window:second", { session: "session:host", cwd: "/tmp/second/src", block: "block:second" });
	const found = await f.terminal.findMany([{ path: "/tmp/first" }, { path: "/tmp/second" }]);
	assert.equal(found.size, 2);
	assert.equal(f.calls.filter((args) => args[0] === "ls").length, 1);
});

test("discovery ignores directories on remote hosts", async () => {
	const f = server();
	f.windows.set("window:remote", { session: "session:host", cwd: "/tmp/repo-topic", block: "block:remote", host: "remote" });
	assert.equal(await f.terminal.find("/tmp/repo-topic"), undefined);
});

test("cleanup closes only owned tabs across sessions and never kills a shared session", async () => {
	const f = server();
	f.windows.set(target.windowId, { session: target.sessionId, cwd: "/tmp/elsewhere", block: target.blockId });
	f.windows.set("window:extra", { session: "session:other", cwd: "/tmp/repo-topic/src", block: "block:extra" });
	f.windows.set("window:keep", { session: "session:host", cwd: "/tmp/repo-topic-sibling", block: "block:keep" });
	await f.terminal.close("/tmp/repo-topic", target);
	assert.deepEqual([...f.windows.keys()], ["window:keep"]);
	assert.equal(f.calls.some((c) => c.includes("kill")), false);
});

test("cleanup refuses to close this agent's tab and propagates server failures", async () => {
	const f = server();
	f.windows.set("window:self", { session: "session:host", cwd: "/tmp/repo-topic", block: "block:keep" });
	await assert.rejects(f.terminal.close("/tmp/repo-topic"), /running this agent/);
	assert.equal(f.calls.some((c) => c.includes("close")), false);
	f.state.fail = "session inspect";
	await assert.rejects(f.terminal.close("/tmp/repo-topic"), /denied/);
	f.state.fail = "block call";
	await assert.rejects(f.terminal.close("/tmp/repo-topic"), /denied/);
});

test("rename targets stable session and window IDs", async () => {
	const f = server();
	f.windows.set(target.windowId, { session: target.sessionId, cwd: "/tmp/elsewhere", block: target.blockId });
	await f.terminal.rename("/tmp/repo-topic", "renamed/topic", target);
	assert.deepEqual(f.calls.at(-1), ["window", "rename", "-s", target.sessionId, target.windowId, "wt:renamed-topic"]);
});

test("switch verifies the active tab and selects a client only across sessions", async () => {
	const f = server();
	await f.terminal.switch(target);
	assert.equal(f.state.active, target.windowId);
	assert.equal(f.calls.some((c) => c.includes("do")), false);
	const terminal = new RexTerminal(f.run, { REX_SESSION: "session:other", REX_CLIENT: "client:app" });
	await terminal.switch(target);
	assert.deepEqual(f.calls.at(-1), ["-C", "client:app", "do", "session.select", `session_id=${target.sessionId}`, `window_id=${target.windowId}`]);
});

test("switch reports focus failure instead of claiming success", async () => {
	const f = server();
	f.state.fail = "focus";
	await assert.rejects(f.terminal.switch(target), /denied/);
	const run: RexRun = (args, signal) => args[0] === "focus" ? Promise.resolve("") : f.run(args, signal);
	await assert.rejects(new RexTerminal(run, {}).switch(target), /did not activate/);
});

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
function api() {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const pi = { registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerTool: (tool: Tool) => tools.set(tool.name, tool), on: () => () => {} } as unknown as ExtensionAPI;
	return { pi, tools, commands };
}

function fixture(t: TestContext) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-rex-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
	const f = server();
	const registered = api();
	registerWorktree(registered.pi, f.terminal);
	const invoke = (name: string, params: Record<string, unknown> = {}) => registered.tools.get(name)!
		.execute("test", params, new AbortController().signal, undefined, { cwd: root } as ExtensionContext);
	const registry = () => JSON.parse(fs.readFileSync(path.join(root, ".pi", "worktrees-rex.json"), "utf8"));
	const notifications: Array<{ message: string; level?: string }> = [];
	const context = { cwd: root, mode: "print", ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) } } as unknown as ExtensionCommandContext;
	return { ...f, ...registered, root, git, invoke, registry, notifications, context, checkout: path.join(dir, "repo-topic") };
}

test("Rex entry point preserves all original command, alias, and tool names without starting Rex", () => {
	const rex = api();
	const tmux = api();
	extension(rex.pi);
	registerWorktree(tmux.pi);
	assert.deepEqual([...rex.commands.keys()], [...tmux.commands.keys()]);
	assert.deepEqual([...rex.tools.keys()], [...tmux.tools.keys()]);
	assert.match(rex.tools.get("worktree_create")!.description, /Rex/);
	assert.match(tmux.tools.get("worktree_create")!.description, /tmux/);
});

test("Pi discovers the package manifest and loads its tools and commands without collisions", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-rex-loader-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL(".", import.meta.url))] });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.ok(loaded.extensions[0].commands.has("worktree"));
	assert.match(loaded.extensions[0].tools.get("worktree_create")!.definition.description, /Rex/);
});

test("tools create, list, rename, and remove with isolated registry and retained session history", async (t) => {
	const f = fixture(t);
	fs.mkdirSync(path.join(f.root, ".pi"));
	const tmuxRegistry = '{"version":1,"worktrees":{},"known":[]}';
	fs.writeFileSync(path.join(f.root, ".pi", "worktrees.json"), tmuxRegistry);
	const created = await f.invoke("worktree_create", { branchName: "topic", baseBranch: "main" });
	assert.notEqual(created.isError, true);
	assert.deepEqual(created.details.terminalTarget, target);
	assert.deepEqual(f.registry().worktrees.topic.terminal, target);
	const listed = await f.invoke("worktree_list");
	assert.match(listed.content[0].text, /Rex:active/);
	const renamed = await f.invoke("worktree_rename", { oldBranch: "topic", newBranch: "renamed" });
	assert.notEqual(renamed.isError, true);
	assert.deepEqual(f.registry().worktrees.renamed.terminal, target);
	const removed = await f.invoke("worktree_remove", { branchName: "renamed", deleteBranch: false });
	assert.notEqual(removed.isError, true);
	assert.equal(fs.existsSync(f.checkout), false);
	assert.equal(f.windows.size, 0);
	assert.deepEqual(f.registry().worktrees, {});
	assert.equal(f.registry().known[0].path, f.checkout);
	assert.ok(f.git("rev-parse", "--verify", "refs/heads/renamed"));
	assert.equal(fs.readFileSync(path.join(f.root, ".pi", "worktrees.json"), "utf8"), tmuxRegistry);
});

test("failed startup reports an error but keeps a recoverable checkout; switch records its replacement tab", async (t) => {
	const f = fixture(t);
	f.state.fail = "window new";
	const created = await f.invoke("worktree_create", { branchName: "topic" });
	assert.equal(created.isError, true);
	assert.match(created.content[0].text, /Checkout created.*startup failed/);
	assert.equal(fs.existsSync(f.checkout), true);
	assert.equal(f.registry().worktrees.topic.terminal, undefined);
	f.state.fail = "";
	await f.commands.get("worktree")!.handler("switch topic", f.context);
	assert.deepEqual(f.registry().worktrees.topic.terminal, target);
	assert.equal(f.state.active, target.windowId);
	assert.match(f.notifications.at(-1)!.message, /Switched to Rex tab/);
});

test("remove aborts on Rex cleanup failure and preserves checkout, branch, and registry", async (t) => {
	const f = fixture(t);
	await f.invoke("worktree_create", { branchName: "topic" });
	f.state.fail = "window close";
	const removed = await f.invoke("worktree_remove", { branchName: "topic" });
	assert.equal(removed.isError, true);
	assert.equal(fs.existsSync(f.checkout), true);
	assert.ok(f.registry().worktrees.topic);
	assert.ok(f.git("rev-parse", "--verify", "refs/heads/topic"));
});

test("switching an external or primary checkout never opts it into destructive clean", async (t) => {
	const f = fixture(t);
	const external = path.join(path.dirname(f.root), "external");
	f.git("worktree", "add", "-b", "external", external);
	await f.commands.get("worktree")!.handler("switch external", f.context);
	await f.commands.get("worktree")!.handler("switch main", f.context);
	assert.equal(fs.existsSync(path.join(f.root, ".pi", "worktrees-rex.json")), false);
	assert.equal((await f.invoke("worktree_clean")).details.cleaned.length, 0);
	assert.equal(fs.existsSync(f.root), true);
	assert.equal(fs.existsSync(external), true);
});

test("Rex registry stays in the primary checkout when invoked from a linked checkout", async (t) => {
	const f = fixture(t);
	await f.invoke("worktree_create", { branchName: "topic" });
	const result = await f.tools.get("worktree_list")!.execute("test", {}, new AbortController().signal,
		undefined, { cwd: f.checkout } as ExtensionContext);
	assert.match(result.content[0].text, /topic.*managed/);
	assert.equal(fs.existsSync(path.join(f.checkout, ".pi", "worktrees-rex.json")), false);
	assert.ok(f.registry().worktrees.topic);
});

test("spawn passes cancellation to both Rex discovery and creation", async () => {
	const f = server();
	const signal = new AbortController().signal;
	const received: Array<AbortSignal | undefined> = [];
	const run: RexRun = (args, provided) => { received.push(provided); return f.run(args, provided); };
	await new RexTerminal(run, {}).spawn("/tmp/repo", "topic", signal);
	assert.deepEqual(received, [signal, signal]);
});

test("clean removes managed Rex tabs and branches but retains history", async (t) => {
	const f = fixture(t);
	await f.invoke("worktree_create", { branchName: "topic" });
	const cleaned = await f.invoke("worktree_clean");
	assert.equal(cleaned.details.cleaned.length, 1);
	assert.deepEqual(cleaned.details.failed, []);
	assert.equal(f.windows.size, 0);
	assert.equal(fs.existsSync(f.checkout), false);
	assert.deepEqual(f.registry().worktrees, {});
	assert.equal(f.registry().known[0].path, f.checkout);
});
