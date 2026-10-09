/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { WorktreeList, browseWorktrees, unavailableAction, type ListedWorktree, type ListChoice } from "./worktree-list.ts";
import { WorktreeCommandMenu } from "./command-menu.ts";
import extension from "./index.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const rows: ListedWorktree[] = [
	{ branch: "main", path: "/repo", commit: "12345678abcd", isMain: true, isManaged: false, tmuxActive: false },
	{ branch: "fix/session-picker", path: "/checkouts/resume-ui", isMain: false, isManaged: true, tmuxActive: true },
	{ branch: "feature/rebase", path: "/checkouts/git-tools", isMain: false, isManaged: false, tmuxActive: false },
	{ path: "/detached", isMain: false, isManaged: false, tmuxActive: false },
];
const enter = "\r";
const escape = "\x1b";
const clear = "\x15";

function bindings(t: TestContext, config: KeybindingsConfig = {}) {
	const previous = getKeybindings();
	const kb = new KeybindingsManager(TUI_KEYBINDINGS, config);
	setKeybindings(kb);
	t.after(() => setKeybindings(previous));
	return kb;
}

function fixture(t: TestContext, config: KeybindingsConfig = {}, worktrees = rows) {
	const keybindings = bindings(t, config);
	const choices: ListChoice[] = [];
	let cancelled = 0;
	const menu = new WorktreeList({
		worktrees, theme, keybindings, maxVisible: 2,
		onSelect: (choice) => choices.push(choice), onCancel: () => { cancelled++; }, requestRender: () => {},
	});
	menu.focused = true;
	return { menu, choices, cancelled: () => cancelled, keybindings };
}
function rendered(menu: WorktreeList) { return menu.render(160).join("\n"); }

function customUI(keybindings: KeybindingsManager, batches: string[][], inspect?: (menu: WorktreeList, index: number) => void) {
	let calls = 0;
	return async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
		let result: unknown;
		const menu = await factory(
			{ terminal: { rows: 24 }, requestRender: () => {} } as Parameters<typeof factory>[0],
			theme, keybindings as Parameters<typeof factory>[2], (value) => { result = value; },
		);
		assert.ok(menu instanceof WorktreeList);
		const index = calls++;
		assert.ok(batches[index], "Unexpected browser re-entry");
		menu.focused = true;
		inspect?.(menu, index);
		for (const key of batches[index]) menu.handleInput(key);
		return result as never;
	};
}

test("normal mode lists status, selected path, and commit without an input cursor", (t) => {
	const f = fixture(t);
	const text = rendered(f.menu);
	assert.ok(text.includes("NORMAL"));
	assert.ok(text.includes("[main]"));
	assert.ok(text.includes("[managed]"));
	assert.ok(text.includes("tmux:active"));
	assert.ok(text.includes("Path: /repo"));
	assert.ok(text.includes("12345678"));
	assert.ok(!text.includes(CURSOR_MARKER));
});

test("Vim movement, arrows, top/bottom, and paging select exact rows", (t) => {
	const f = fixture(t);
	for (const [keys, branch] of [
		[["j", "r"], "fix/session-picker"], [["j", "t"], "feature/rebase"],
		[["k", "p"], "fix/session-picker"], [["g", enter], "main"],
		[["G", "k", "r"], "feature/rebase"], [["g", "\x04", "t"], "feature/rebase"],
		[["\x15", enter], "main"], [["\x1b[B", enter], "fix/session-picker"],
	] as Array<[string[], string]>) {
		for (const key of keys) f.menu.handleInput(key);
		assert.equal(f.choices.at(-1)?.worktree?.branch, branch);
	}
});

test("every worktree command has a default action binding", (t) => {
	const f = fixture(t);
	f.menu.handleInput("j");
	for (const [key, command] of Object.entries({ c: "create", l: "list", s: "sessions", w: "switch", r: "rebase", t: "tip", p: "pr", n: "rename", x: "remove", C: "clean", "?": "help" })) {
		f.menu.handleInput(key);
		assert.equal(f.choices.at(-1)?.command, command);
		assert.equal(f.choices.at(-1)?.worktree?.branch, "fix/session-picker");
	}
});

test("search consumes action keys as text and requires normal mode before execution", (t) => {
	const f = fixture(t);
	for (const key of ["/", ..."ssnpkr"]) f.menu.handleInput(key);
	assert.ok(rendered(f.menu).includes("SEARCH"));
	assert.ok(rendered(f.menu).includes(CURSOR_MARKER));
	assert.equal(f.choices.length, 0);
	f.menu.handleInput(enter);
	assert.equal(f.choices.length, 0);
	assert.ok(rendered(f.menu).includes("NORMAL"));
	f.menu.handleInput("x");
	assert.equal(f.choices[0].worktree?.branch, "fix/session-picker");
	assert.equal(f.choices[0].query, "ssnpkr");
	assert.ok(!rendered(f.menu).includes(CURSOR_MARKER));
	f.menu.handleInput("/");
	f.menu.handleInput(clear);
	f.menu.handleInput("GITTOOLS");
	f.menu.handleInput(escape);
	f.menu.handleInput("t");
	assert.equal(f.choices[1].worktree?.branch, "feature/rebase");
});

test("search edit/clear, no matches, and global actions never fall back to an unrelated row", (t) => {
	const f = fixture(t);
	for (const key of ["/", "zzzzzz", enter, "x", "r", "t", "n", "p", "w"]) f.menu.handleInput(key);
	assert.equal(f.choices.length, 0);
	assert.ok(rendered(f.menu).includes("Select a worktree first"));
	f.menu.handleInput("c");
	assert.equal(f.choices[0].command, "create");
	assert.equal(f.choices[0].worktree, undefined);
	for (const key of ["/", clear, "rebasex", "\x7f", enter, "t"]) f.menu.handleInput(key);
	assert.equal(f.choices[1].worktree?.branch, "feature/rebase");
});

test("primary/default, detached, locked, bare and prunable rows cannot trigger unsafe actions", (t) => {
	const f = fixture(t);
	for (const key of ["x", "n", "r", "t", "p", "G", "x", "n", "r", "t", "p", "w"]) f.menu.handleInput(key);
	assert.equal(f.choices.length, 0);
	assert.ok(unavailableAction("remove", { ...rows[1], locked: true }));
	assert.ok(unavailableAction("tip", { ...rows[1], prunable: true }));
	assert.ok(unavailableAction("switch", { ...rows[1], bare: true }));
	assert.equal(unavailableAction("rebase", { ...rows[1], isMain: true }), undefined);
});

test("bindings can be remapped, assigned multiple keys, disabled, and claim another default key", (t) => {
	const f = fixture(t, {
		"worktree.list.down": "ctrl+n", "worktree.list.remove": ["d", "ctrl+x"],
		"worktree.list.tip": [], "worktree.list.rename": "r", "worktree.list.cancel": "z",
	});
	for (const key of ["j", "x", "t", "q"]) f.menu.handleInput(key);
	assert.equal(f.choices.length, 0);
	assert.equal(f.cancelled(), 0);
	for (const key of ["\x0e", "d", "\x18", "r"]) f.menu.handleInput(key);
	assert.deepEqual(f.choices.map((choice) => choice.command), ["remove", "remove", "rename"]);
	f.menu.handleInput("z");
	assert.equal(f.cancelled(), 1);
	assert.ok(rendered(f.menu).includes("d/ctrl+x: Remove"));
	assert.ok(rendered(f.menu).includes("unbound: Tip"));
	assert.deepEqual(f.keybindings.getKeys("tui.select.down"), ["down"], "Local bindings must not mutate Pi's global manager");
});

test("Pi loads list action overrides from its actual keybindings.json", async (t) => {
	// Pi's file-backed manager is internal, unlike the TUI manager passed to components.
	const { KeybindingsManager: PiKeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-keybindings-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({ "worktree.list.remove": "d" }));
	const choices: ListChoice[] = [];
	const menu = new WorktreeList({
		worktrees: rows, theme, keybindings: PiKeybindingsManager.create(dir),
		onSelect: (choice) => choices.push(choice), onCancel: () => {}, requestRender: () => {},
	});
	menu.handleInput("j"); menu.handleInput("x");
	assert.equal(choices.length, 0);
	menu.handleInput("d");
	assert.equal(choices[0].command, "remove");
});

test("conflicting explicit assignments are visible and cannot execute", (t) => {
	const f = fixture(t, { "worktree.list.remove": "d", "worktree.list.rename": "d" });
	f.menu.handleInput("j"); f.menu.handleInput("d");
	assert.equal(f.choices.length, 0);
	assert.ok(rendered(f.menu).includes("conflicting bindings"));
});

test("Escape exits search first, and q/Escape/Ctrl+C close normal mode", (t) => {
	for (const cancel of ["q", escape, "\x03"]) {
		const f = fixture(t);
		f.menu.handleInput("/"); f.menu.handleInput("r"); f.menu.handleInput(escape);
		assert.equal(f.cancelled(), 0);
		f.menu.handleInput(cancel);
		assert.equal(f.cancelled(), 1);
	}
});

test("complete and chunked bracketed paste never executes shortcuts or pasted control keys", (t) => {
	for (const chunks of [["\x1b[200~xrt\x1b[201~"], ["\x1b[200~", "r", "\r", "t", "\x1b[201~"], ["\x1b[200~r\x1b[201~\r"]]) {
		const f = fixture(t);
		for (const chunk of chunks) f.menu.handleInput(chunk);
		assert.equal(f.choices.length, 0);
		assert.equal(f.cancelled(), 0);
	}
});

test("empty lists retain global actions; narrow Unicode rendering, resize and invalidation fit", (t) => {
	const f = fixture(t, {}, []);
	for (const key of ["j", "k", "G", "g", "x", enter]) f.menu.handleInput(key);
	assert.equal(f.choices.length, 0);
	f.menu.handleInput("c");
	assert.equal(f.choices[0].command, "create");
	const unicode = fixture(t, {}, [{ ...rows[1], branch: "feature/日本", path: "/目录/🌿" }]);
	for (const menu of [f.menu, unicode.menu]) {
		menu.handleInput("/");
		menu.invalidate();
		for (const width of [1, 8, 20, 40, 80, 160]) {
			for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
		menu.focused = false;
		assert.ok(!rendered(menu).includes(CURSOR_MARKER));
	}
});

test("resize keeps the highlighted checkout and all action hints fit an ordinary terminal", (t) => {
	let height = 24;
	const keybindings = bindings(t);
	const worktrees = Array.from({ length: 30 }, (_, i) => ({ ...rows[1], branch: `topic-${i}`, path: `/checkouts/topic-${i}` }));
	const menu = new WorktreeList({
		worktrees, theme, keybindings, maxVisible: 30, getRows: () => height,
		onSelect: () => {}, onCancel: () => {}, requestRender: () => {},
	});
	menu.handleInput("G");
	for (const width of [80, 120, 40]) {
		const lines = menu.render(width);
		assert.ok(lines.length <= height, `${width}: ${lines.length} > ${height}`);
		assert.ok(lines.join("\n").includes("Path: /checkouts/topic-29"));
	}
	height = 40;
	assert.ok(menu.render(120).length <= height);
	menu.handleInput("k");
	assert.ok(rendered(menu).includes("Path: /checkouts/topic-28"));
});

test("browser reloads after management actions and preserves selected path and search", async (t) => {
	const kb = bindings(t);
	let loads = 0;
	const ran: string[] = [];
	const ctx = { ui: { custom: customUI(kb, [["/", "ssnpkr", enter, "n"], ["l"], ["q"]], (menu, i) => {
		if (i) assert.ok(rendered(menu).includes("Path: /checkouts/resume-ui"));
	}), notify: () => {} } } as unknown as ExtensionCommandContext;
	await browseWorktrees(ctx, async () => { loads++; return rows; }, async (choice) => { ran.push(choice.command); });
	assert.deepEqual(ran, ["rename"]);
	assert.equal(loads, 4, "Three render loads and one pre-action revalidation");
});

test("stale branch/path selections are revalidated and never dispatched", async (t) => {
	const kb = bindings(t);
	let loads = 0;
	const warnings: string[] = [];
	const ctx = { ui: { custom: customUI(kb, [["j", "x"], ["q"]]), notify: (text: string) => warnings.push(text) } } as unknown as ExtensionCommandContext;
	await browseWorktrees(ctx, async () => ++loads === 1 ? rows : [rows[0]], async () => assert.fail("Stale worktree executed"));
	assert.ok(warnings[0].includes("changed or disappeared"));
});

test("handoff actions close the browser after dispatching the explicit selected branch", async (t) => {
	for (const key of ["r", "t", "p", "w", "s"]) {
		const kb = bindings(t);
		const choices: ListChoice[] = [];
		const ctx = { ui: { custom: customUI(kb, [["j", key]]), notify: () => {} } } as unknown as ExtensionCommandContext;
		await browseWorktrees(ctx, async () => rows, async (choice) => { choices.push(choice); });
		assert.equal(choices.length, 1);
		assert.equal(choices[0].worktree?.branch, "fix/session-picker");
	}
});

test("list command, alias, and menu use the action browser; remove still confirms; RPC stays textual", async (t) => {
	const kb = bindings(t);
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-list-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const main = path.join(root, "repo"); const topic = path.join(root, "topic");
	fs.mkdirSync(main);
	function git(args: string[]) {
		const result = spawnSync("git", args, { cwd: main, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
	}
	git(["init", "--initial-branch=main"]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"]);
	git(["worktree", "add", "-b", "fix/session-picker", topic]);
	const original = git(["show-ref"]);
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	extension({ registerCommand: (name, command) => commands.set(name, command.handler), registerTool: () => {}, on: () => () => {} } as Pick<ExtensionAPI, "registerCommand" | "registerTool" | "on"> as ExtensionAPI);
	for (const [name, args] of [
		["worktree", "list"], ["worktree", "ls"], ["worktree", "l"], ["worktrees", ""],
		["wt", "l"], ["wt", "list"], ["worktree", ""], ["wt", ""],
	]) {
		let confirmations = 0; let browsers = 0; let menuShown = false;
		const browser = customUI(kb, [["j", "x"], ["q"]], () => { browsers++; });
		const ctx = {
			cwd: main, mode: "tui", hasUI: true,
			ui: {
				notify: () => {}, input: async () => assert.fail("No input needed"),
				confirm: async (title: string) => { assert.ok(title.includes('"fix/session-picker"')); confirmations++; return false; },
				custom: async (factory: Parameters<typeof browser>[0]) => {
					if (args === "" && ["worktree", "wt"].includes(name) && !menuShown) {
						menuShown = true;
						let result: unknown;
						const menu = await factory({ terminal: { rows: 24 }, requestRender: () => {} } as Parameters<typeof factory>[0], theme, kb as Parameters<typeof factory>[2], (value) => { result = value; });
						assert.ok(menu instanceof WorktreeCommandMenu);
						menu.handleInput("list"); menu.handleInput(enter); return result;
					}
					return browser(factory);
				},
			},
		} as unknown as ExtensionCommandContext;
		await commands.get(name)!(args, ctx);
		assert.equal(browsers, 2); assert.equal(confirmations, 1);
		assert.equal(git(["show-ref"]), original); assert.ok(fs.existsSync(topic));
	}
	const notifications: string[] = [];
	await commands.get("worktree")!("list", { cwd: main, mode: "rpc", ui: { notify: (text: string) => notifications.push(text), custom: async () => assert.fail("RPC cannot use custom UI") } } as unknown as ExtensionCommandContext);
	assert.ok(notifications[0].includes("Git Worktrees:"));
	assert.ok(notifications[0].includes("fix/session-picker"));
});
