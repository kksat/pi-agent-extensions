/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WORKTREE_ALIASES, loadWorktreeAliases, parseWorktreeAliases, registerWorktreeCommands } from "./aliases.ts";
import { routeWorktreeCommand } from "./route.ts";
import extension from "./index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function tempAgentDir(t: TestContext) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-aliases-")));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function collectCommands() {
	const commands = new Map<string, Command>();
	extension({
		registerCommand: (name, command) => { assert.ok(!commands.has(name)); commands.set(name, command); },
		registerTool: () => {}, on: () => () => {},
	} as Pick<ExtensionAPI, "registerCommand" | "registerTool" | "on"> as ExtensionAPI);
	return commands;
}

test("defaults include /wt and l, preserving every legacy alias", () => {
	const aliases = parseWorktreeAliases({});
	assert.deepEqual(aliases, DEFAULT_WORKTREE_ALIASES);
	assert.equal(aliases.commandAliases.wt, "worktree");
	assert.equal(aliases.subcommandAliases.l, "list");
	for (const [alias, target] of Object.entries(aliases.subcommandAliases)) {
		assert.deepEqual(routeWorktreeCommand(`${alias} topic`, "/repo"), routeWorktreeCommand(`${target} topic`, "/repo"), alias);
		assert.deepEqual(routeWorktreeCommand(alias, null), routeWorktreeCommand(target, null), alias);
	}
	assert.deepEqual(routeWorktreeCommand(" L ", "/repo"), { type: "list", gitRoot: "/repo" });
});

test("aliases can be added, remapped and disabled without changing canonical commands", () => {
	const aliases = parseWorktreeAliases({
		commandAliases: { wt: null, w: "worktree", worktrees: "sessions", topics: "list", "worktree-clean": null },
		subcommandAliases: { l: null, ls: "sessions", ll: "list", r: "rebase", s: "sessions" },
	});
	assert.equal(aliases.commandAliases.wt, undefined);
	assert.equal(aliases.commandAliases.w, "worktree");
	assert.equal(aliases.commandAliases.worktrees, "sessions");
	assert.equal(aliases.commandAliases["worktree-clean"], undefined);
	assert.equal(aliases.subcommandAliases.l, undefined);
	assert.deepEqual(routeWorktreeCommand("ll", "/repo", aliases.subcommandAliases), { type: "list", gitRoot: "/repo" });
	assert.deepEqual(routeWorktreeCommand("ls", "/repo", aliases.subcommandAliases), { type: "sessions", gitRoot: "/repo" });
	assert.deepEqual(routeWorktreeCommand("s", null, aliases.subcommandAliases), { type: "folder-sessions" });
	assert.deepEqual(routeWorktreeCommand("r Feature/KeepCase", "/repo", aliases.subcommandAliases), { type: "rebase", gitRoot: "/repo", args: "Feature/KeepCase" });
	assert.deepEqual(routeWorktreeCommand("l", "/repo", aliases.subcommandAliases), { type: "create", gitRoot: "/repo", args: "l" });
	assert.deepEqual(routeWorktreeCommand("list", "/repo", aliases.subcommandAliases), { type: "list", gitRoot: "/repo" });
	assert.equal(DEFAULT_WORKTREE_ALIASES.subcommandAliases.l, "list", "Default maps must not be mutated");
});

test("ordinary branch names/base arguments and explicit creation remain unchanged", () => {
	for (const args of ["Feature/KeepCase main", "release/1.2", "constructor", "toString"]) {
		assert.deepEqual(routeWorktreeCommand(args, "/repo"), { type: "create", gitRoot: "/repo", args });
	}
	assert.deepEqual(routeWorktreeCommand("create l main", "/repo"), { type: "create", gitRoot: "/repo", args: "l main" });
});

test("invalid config, alias chains, unsafe names, and canonical overrides are rejected", () => {
	for (const config of [
		null, [], "wt", { aliases: {} }, { commandAliases: [] }, { subcommandAliases: null },
		{ commandAliases: { "/wt": "worktree" } }, { commandAliases: { "wt list": "list" } },
		{ commandAliases: { wt: "unknown" } }, { commandAliases: { wt: "worktree list" } },
		{ commandAliases: { wt: 1 } }, { commandAliases: { worktree: null } },
		{ subcommandAliases: { list: "remove" } }, { subcommandAliases: { list: null } },
		{ subcommandAliases: { l: "ls" } }, { subcommandAliases: { l: "worktree" } },
		{ subcommandAliases: { "L": "list" } }, { subcommandAliases: { "/l": "list" } },
		JSON.parse('{"commandAliases":{"__proto__":"list"}}'),
	]) assert.throws(() => parseWorktreeAliases(config), Error, JSON.stringify(config));
});

test("missing files use defaults, custom files merge, and malformed files fail with their path", (t) => {
	const dir = tempAgentDir(t);
	const file = path.join(dir, "worktree.json");
	assert.deepEqual(loadWorktreeAliases(dir), DEFAULT_WORKTREE_ALIASES);
	fs.writeFileSync(file, '\uFEFF{"commandAliases":{"wt":null,"w":"worktree"},"subcommandAliases":{"ll":"list"}}');
	const loaded = loadWorktreeAliases(dir);
	assert.equal(loaded.commandAliases.wt, undefined);
	assert.equal(loaded.commandAliases.w, "worktree");
	assert.equal(loaded.subcommandAliases.ll, "list");
	fs.writeFileSync(file, "{broken");
	assert.throws(() => loadWorktreeAliases(dir), (error: unknown) => error instanceof Error && error.message.includes(file));
	assert.throws(() => collectCommands(), /Invalid worktree alias configuration/);
});

test("slash aliases forward every argument and share root completion/handler behavior", async () => {
	const registered = new Map<string, Command>();
	const invocations: string[] = [];
	const prefixes: string[] = [];
	const command: Command = {
		handler: async (args) => { invocations.push(args); },
		getArgumentCompletions: async (prefix) => {
			prefixes.push(prefix);
			return [{ value: "remove feature/one", label: "feature/one", description: "/checkouts/one" }];
		},
	};
	registerWorktreeCommands({ registerCommand: (name, options) => registered.set(name, options) }, command, DEFAULT_WORKTREE_ALIASES.commandAliases);
	assert.equal(registered.get("wt")!.handler, command.handler);
	assert.equal(registered.get("wt")!.getArgumentCompletions, command.getArgumentCompletions);
	for (const args of ["", "l", "Feature/KeepCase main", "rename old new", "tip topic", "pr topic", "sessions", "help"]) {
		await registered.get("wt")!.handler(args, {} as ExtensionCommandContext);
		assert.equal(invocations.at(-1), args);
	}
	await registered.get("worktree-remove")!.handler("feature/one", {} as ExtensionCommandContext);
	assert.equal(invocations.at(-1), "remove feature/one");
	await registered.get("worktree-rename")!.handler("old new", {} as ExtensionCommandContext);
	assert.equal(invocations.at(-1), "rename old new");
	assert.deepEqual(await registered.get("worktree-remove")!.getArgumentCompletions!("feat"), [{ value: "feature/one", label: "feature/one", description: "/checkouts/one" }]);
	assert.equal(prefixes.at(-1), "remove feat");
});

test("custom slash registrations and shorthand completions use the configured agent directory", async (t) => {
	const dir = tempAgentDir(t);
	fs.writeFileSync(path.join(dir, "worktree.json"), JSON.stringify({
		commandAliases: { wt: null, w: "worktree", topics: "list", worktrees: null },
		subcommandAliases: { l: null, ll: "list", r: "rebase", pick: "sessions" },
	}));
	const commands = collectCommands();
	assert.ok(commands.has("worktree")); assert.ok(commands.has("w")); assert.ok(commands.has("topics"));
	assert.ok(!commands.has("wt")); assert.ok(!commands.has("worktrees"));
	const options = await commands.get("w")!.getArgumentCompletions!("l");
	assert.ok(options?.some((item) => item.value === "ll" && item.description?.includes("list")));
	assert.ok(!options?.some((item) => item.value === "l"));
	const messages: string[] = [];
	await commands.get("w")!.handler("help", { cwd: dir, ui: { notify: (text: string) => messages.push(text) } } as unknown as ExtensionCommandContext);
	assert.ok(messages[0].includes("Worktree Management Commands"));
	await commands.get("topics")!.handler("", { cwd: dir, ui: { notify: (text: string) => messages.push(text) } } as unknown as ExtensionCommandContext);
	assert.ok(messages.at(-1)?.includes("not inside a git repository"));
	// Registration snapshots config until reload; rebuilding picks up file edits.
	fs.writeFileSync(path.join(dir, "worktree.json"), "{}");
	assert.ok(!commands.has("wt"));
	assert.ok(collectCommands().has("wt"));
});

test("alias argument completions preserve the shorthand while targeting the real branch", async (t) => {
	const dir = tempAgentDir(t);
	const repo = path.join(dir, "repo"); const topic = path.join(dir, "topic");
	fs.mkdirSync(repo);
	const previous = process.cwd(); process.chdir(repo); t.after(() => process.chdir(previous));
	function git(args: string[]) {
		const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.equal(result.status, 0, result.stderr);
	}
	git(["init", "--initial-branch=main"]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"]);
	git(["worktree", "add", "-b", "feature/one", topic]);
	fs.writeFileSync(path.join(dir, "worktree.json"), '{"commandAliases":{"publish":"pr"},"subcommandAliases":{"r":"rebase"}}');
	const commands = collectCommands();
	assert.equal((await commands.get("wt")!.getArgumentCompletions!("r feat"))?.[0].value, "r feature/one");
	assert.equal((await commands.get("worktree-remove")!.getArgumentCompletions!("feat"))?.[0].value, "feature/one");
	assert.equal((await commands.get("publish")!.getArgumentCompletions!("feat"))?.[0].value, "feature/one");
});
