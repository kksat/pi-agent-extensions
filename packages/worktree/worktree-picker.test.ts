/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Requires the package's Pi peer dependencies.
//   node --experimental-strip-types packages/worktree/worktree-picker.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { SearchableMenu } from "./command-menu.ts";
import extension from "./index.ts";
import { selectSearchableItem, selectWorktree, type PickerContext } from "./worktree-picker.ts";

initTheme("dark", false);
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const worktrees = [
	{ branch: "feature/payments", path: "/checkouts/billing-service" },
	{ branch: "fix/session-picker", path: "/checkouts/resume-ui" },
	{ branch: "feature/rebase", path: "/checkouts/git-tools" },
];
const enter = "\r";
const escape = "\x1b";
const up = "\x1b[A";
const down = "\x1b[B";
const clear = "\x15";

function bindings(t: TestContext, config: KeybindingsConfig = {}) {
	const previous = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, config);
	setKeybindings(keybindings);
	t.after(() => setKeybindings(previous));
	return keybindings;
}

async function pick(t: TestContext, inputs: string[], config: KeybindingsConfig = {}, rows = 24) {
	const keybindings = bindings(t, config);
	let menu: SearchableMenu | undefined;
	let renders = 0;
	const ctx: PickerContext = {
		mode: "tui",
		ui: {
			select: async () => { throw new Error("TUI must use fuzzy search"); },
			custom: async (factory) => {
				let result: unknown;
				const component = await factory(
					{ terminal: { rows }, requestRender: () => { renders++; } } as Parameters<typeof factory>[0],
					theme, keybindings as Parameters<typeof factory>[2], (value) => { result = value; },
				);
				assert.ok(component instanceof SearchableMenu);
				menu = component;
				menu.focused = true;
				for (const data of inputs) menu.handleInput(data);
				return result as never;
			},
		},
	};
	const result = await selectWorktree(ctx, "Select worktree:", worktrees);
	assert.ok(menu);
	return { result, menu, renders };
}

function rendered(menu: SearchableMenu) {
	return menu.render(100).join("\n");
}

test("blank picker shows branches and paths and allows direct arrow-key selection", async (t) => {
	const { result, menu } = await pick(t, [down, enter]);
	for (const wt of worktrees) {
		assert.ok(rendered(menu).includes(wt.branch));
		assert.ok(rendered(menu).includes(wt.path));
	}
	assert.equal(result, "fix/session-picker");
	assert.ok(rendered(menu).includes("Select worktree:"));
	assert.ok(rendered(menu).includes("Type to fuzzy-search"));
});

test("nonconsecutive branch characters select the exact branch, not the query", async (t) => {
	const { result, menu, renders } = await pick(t, [..."ssnpkr", enter]);
	assert.equal(result, "fix/session-picker");
	assert.ok(!rendered(menu).includes("feature/payments"));
	assert.ok(rendered(menu).includes("Search: ssnpkr"));
	assert.equal(renders, 7);
});

test("case-insensitive fuzzy search also matches checkout paths", async (t) => {
	const { result, menu } = await pick(t, ["BLLNGSRV", enter]);
	assert.equal(result, "feature/payments");
	assert.ok(!rendered(menu).includes("fix/session-picker"));
});

test("query edits reset ranking and clearing restores the full list", async (t) => {
	const { result, menu } = await pick(t, [down, "paymentsx", "\x7f", enter, clear]);
	assert.equal(result, "feature/payments");
	for (const wt of worktrees) assert.ok(rendered(menu).includes(wt.branch));
});

test("no matches cannot select or navigate to an unrelated worktree", async (t) => {
	const { result, menu } = await pick(t, ["zzzzzz", down, up, enter]);
	assert.equal(result, undefined);
	assert.ok(rendered(menu).includes("No matching worktrees or folders"));
	menu.handleInput(clear);
	menu.handleInput("rbs");
	assert.ok(rendered(menu).includes("feature/rebase"));
});

test("Escape and Ctrl+C cancel a filtered picker", async (t) => {
	for (const cancel of [escape, "\x03"]) {
		const { result } = await pick(t, ["rbs", cancel]);
		assert.equal(result, undefined);
	}
});

test("configured navigation and confirmation bindings are honored", async (t) => {
	const { result } = await pick(t, ["\x0e", "\x0f"], {
		"tui.select.down": "ctrl+n",
		"tui.select.confirm": "ctrl+o",
	});
	assert.equal(result, "fix/session-picker");
});

test("page navigation and wrapping remain available on a short terminal", async (t) => {
	assert.equal((await pick(t, ["\x1b[6~", enter], {}, 10)).result, "fix/session-picker");
	assert.equal((await pick(t, [up, enter], {}, 10)).result, "feature/rebase");
});

test("pasted text and newlines only update the query, never select a worktree", async (t) => {
	const { result, menu } = await pick(t, ["\x1b[200~", "payments", "\r", "\x1b[201~"]);
	assert.equal(result, undefined);
	assert.ok(rendered(menu).includes("feature/payments"));
});

test("focus, invalidation, Unicode paths, and narrow rendering are preserved", async (t) => {
	const { menu } = await pick(t, ["rbs"]);
	assert.ok(rendered(menu).includes(CURSOR_MARKER));
	menu.focused = false;
	assert.ok(!rendered(menu).includes(CURSOR_MARKER));
	const unicode = new SearchableMenu({
		title: "选择 worktree", items: [{ value: "feature/日本", label: "feature/日本", description: "/目录/🌿" }],
		placeholder: "Search…", theme, keybindings: getKeybindings(),
		requestRender: () => {}, onSelect: () => {}, onCancel: () => {},
	});
	for (const component of [menu, unicode]) {
		component.invalidate();
		for (const width of [1, 8, 20, 40, 80]) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("RPC keeps standard selection and maps a displayed label back to the original value", async () => {
	const selections: string[][] = [];
	const ctx: PickerContext = {
		mode: "rpc",
		ui: {
			select: async (_title, labels) => { selections.push(labels); return labels[1]; },
			custom: async () => { throw new Error("RPC cannot render custom components"); },
		},
	};
	assert.equal(await selectWorktree(ctx, "Switch:", worktrees), "fix/session-picker");
	assert.deepEqual(selections, [worktrees.map((wt) => wt.branch)]);
	assert.equal(await selectSearchableItem(ctx, "Resume in:", [
		{ value: "/current", label: "Current folder" },
		{ value: "/topic", label: "feature/payments (/topic)" },
	]), "/topic");
	ctx.ui.select = async () => undefined;
	assert.equal(await selectWorktree(ctx, "Switch:", worktrees), undefined);
});

test("empty candidate lists and detached worktrees do not open a picker", async () => {
	const ctx: PickerContext = {
		mode: "tui",
		ui: {
			select: async () => { throw new Error("Empty select"); },
			custom: async () => { throw new Error("Empty custom"); },
		},
	};
	assert.equal(await selectWorktree(ctx, "Switch:", []), undefined);
	assert.equal(await selectWorktree(ctx, "Switch:", [{ path: "/detached" }]), undefined);
});

test("all command, alias, and menu entry points open the searchable worktree picker", async (t) => {
	const keybindings = bindings(t);
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-picker-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const main = path.join(root, "repo");
	const topic = path.join(root, "resume-ui");
	fs.mkdirSync(main);
	function git(args: string[]) {
		const result = spawnSync("git", args, {
			cwd: main, encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	}
	git(["init", "--initial-branch=main"]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"]);
	git(["worktree", "add", "-b", "fix/session-picker", topic]);
	const original = git(["show-ref"]);
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	extension({
		registerCommand: (name, command) => { commands.set(name, command.handler); },
		registerTool: () => {}, on: () => () => {},
	} as Pick<ExtensionAPI, "registerCommand" | "registerTool" | "on"> as ExtensionAPI);
	for (const [name, args, menuCommand] of [
		...["switch", "rename", "remove", "rebase", "tip", "pr"].map((action) => ["worktree", action, ""]),
		["worktree-remove", "", ""], ["worktree-rename", "", ""],
		...["switch", "rename", "remove", "rebase", "tip", "pr"].map((action) => ["worktree", "", action]),
	]) {
		await t.test(`${name} ${args || (menuCommand ? `(menu: ${menuCommand})` : "")}`, async () => {
			let pickers = 0;
			let menus = 0;
			await commands.get(name)!(args, {
				cwd: main, mode: "tui", hasUI: true, isIdle: () => true,
				ui: {
					notify: (message: string) => { throw new Error(message); },
					select: async () => { throw new Error("Worktree selection must be searchable"); },
					input: async () => { throw new Error("Cancelled picker must not ask for input"); },
					confirm: async () => { throw new Error("Cancelled picker must not confirm an operation"); },
					custom: async (factory) => {
						let result: unknown;
						const component = await factory(
							{ terminal: { rows: 24 }, requestRender: () => {} } as Parameters<typeof factory>[0],
							theme, keybindings as Parameters<typeof factory>[2], (value) => { result = value; },
						);
						assert.ok(component instanceof SearchableMenu);
						if (rendered(component).includes("Worktree Management")) {
							assert.ok(menuCommand);
							menus++;
							component.handleInput(menuCommand);
							component.handleInput(enter);
						} else {
							pickers++;
							component.handleInput("ssnpkr");
							assert.ok(rendered(component).includes("fix/session-picker"));
							assert.ok(!rendered(component).includes("No matching"));
							component.handleInput(escape);
						}
						return result as never;
					},
				},
			} as Pick<ExtensionCommandContext, "cwd" | "mode" | "hasUI" | "isIdle"> & {
				ui: Pick<ExtensionCommandContext["ui"], "notify" | "select" | "input" | "confirm" | "custom">;
			} as ExtensionCommandContext);
			assert.equal(pickers, 1);
			assert.equal(menus, menuCommand ? 1 : 0);
			assert.equal(git(["show-ref"]), original);
			assert.ok(fs.existsSync(topic));
		});
	}
	await t.test("sessions resume destination uses fuzzy search and retains Other folder", async () => {
		let calls = 0;
		const ui: Pick<ExtensionCommandContext["ui"], "custom" | "select"> = {
			select: async () => { throw new Error("Destination must be searchable"); },
			custom: async (factory) => {
				// Supply a selection from the existing session browser, then exercise its destination picker.
				if (calls++ === 0) return { branch: "fix/session-picker" } as never;
				let result: unknown;
				const component = await factory(
					{ terminal: { rows: 24 }, requestRender: () => {} } as Parameters<typeof factory>[0],
					theme, keybindings as Parameters<typeof factory>[2], (value) => { result = value; },
				);
				assert.ok(component instanceof SearchableMenu);
				assert.ok(rendered(component).includes("Other folder..."));
				component.handleInput("ssnpkr");
				assert.ok(rendered(component).includes("fix/session-picker"));
				assert.ok(!rendered(component).includes("Other folder..."));
				component.handleInput(clear);
				component.handleInput("othfld");
				assert.ok(rendered(component).includes("Other folder..."));
				component.handleInput(escape);
				return result as never;
			},
		};
		const ctx = { cwd: main, mode: "tui", ui, sessionManager: { usesDefaultSessionDir: () => true } };
		await commands.get("worktree")!("sessions", ctx as unknown as ExtensionCommandContext);
		assert.equal(calls, 2);
	});
});
