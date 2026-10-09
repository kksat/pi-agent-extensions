/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { DynamicBorder, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Input, KeybindingsManager, SelectList, fuzzyFilter, matchesKey, truncateToWidth, wrapTextWithAnsi,
	type Component, type Focusable, type KeybindingDefinitions, type SelectItem,
} from "@earendil-works/pi-tui";
import { isRebaseTarget } from "./rebase.ts";

export interface ListedWorktree {
	path: string;
	branch?: string;
	commit?: string;
	bare?: boolean;
	locked?: boolean;
	prunable?: boolean;
	isMain: boolean;
	isManaged: boolean;
	tmuxActive: boolean;
}

export type ListCommand = "create" | "list" | "sessions" | "switch" | "rebase" | "tip" | "pr" | "rename" | "remove" | "clean" | "help";
type ListControl = "up" | "down" | "pageUp" | "pageDown" | "first" | "last" | "search" | "cancel";
type ListBinding = `worktree.list.${ListCommand | ListControl}`;

declare module "@earendil-works/pi-tui" {
	interface Keybindings extends Record<ListBinding, true> {}
}

export const WORKTREE_LIST_KEYBINDINGS = {
	"worktree.list.up": { defaultKeys: ["k", "up"], description: "Previous worktree" },
	"worktree.list.down": { defaultKeys: ["j", "down"], description: "Next worktree" },
	"worktree.list.pageUp": { defaultKeys: ["ctrl+u", "pageUp"], description: "Page up" },
	"worktree.list.pageDown": { defaultKeys: ["ctrl+d", "pageDown"], description: "Page down" },
	"worktree.list.first": { defaultKeys: ["g", "home"], description: "First worktree" },
	"worktree.list.last": { defaultKeys: ["shift+g", "end"], description: "Last worktree" },
	"worktree.list.search": { defaultKeys: "/", description: "Search branches and paths" },
	"worktree.list.cancel": { defaultKeys: ["q", "escape", "ctrl+c"], description: "Close list" },
	"worktree.list.create": { defaultKeys: "c", description: "Create" },
	"worktree.list.list": { defaultKeys: "l", description: "Refresh list" },
	"worktree.list.sessions": { defaultKeys: "s", description: "Browse sessions" },
	"worktree.list.switch": { defaultKeys: ["enter", "w"], description: "Switch/attach" },
	"worktree.list.rebase": { defaultKeys: "r", description: "Rebase main/master onto topic" },
	"worktree.list.tip": { defaultKeys: "t", description: "Tip topic onto main/master" },
	"worktree.list.pr": { defaultKeys: "p", description: "PR + green CI" },
	"worktree.list.rename": { defaultKeys: "n", description: "Rename" },
	"worktree.list.remove": { defaultKeys: "x", description: "Remove" },
	"worktree.list.clean": { defaultKeys: "shift+c", description: "Clean all managed" },
	"worktree.list.help": { defaultKeys: "?", description: "Help" },
} satisfies KeybindingDefinitions;

export interface ListChoice {
	command: ListCommand;
	worktree?: ListedWorktree;
	query: string;
}

/** Never let an unavailable row action fall back to a different branch or another picker. */
export function unavailableAction(command: ListCommand, worktree?: ListedWorktree): string | undefined {
	if (!["switch", "rebase", "tip", "pr", "rename", "remove"].includes(command)) return undefined;
	if (!worktree) return "Select a worktree first (or clear the search).";
	if (!worktree.branch) return "This worktree has no branch (detached HEAD or bare repository).";
	if (worktree.bare || worktree.prunable) return "This checkout is bare or prunable; select a living worktree.";
	if (["rebase", "tip", "pr"].includes(command) && !isRebaseTarget(worktree)) return "Select a topic branch, not main/master.";
	if (["rename", "remove"].includes(command) && worktree.isMain) return "The primary repository worktree cannot be renamed or removed here.";
	if (command === "remove" && worktree.locked) return "This worktree is locked; unlock it explicitly before removal.";
	return undefined;
}

interface ListOptions {
	worktrees: ListedWorktree[];
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender(): void;
	onSelect(choice: ListChoice): void;
	onCancel(): void;
	query?: string;
	selectedPath?: string;
	maxVisible?: number;
	getRows?(): number;
}

/** Normal mode owns action keys; search mode owns text, including j/k/x/r/t. */
export class WorktreeList implements Component, Focusable {
	private options: ListOptions;
	private bindings: KeybindingsManager;
	private input: Input;
	private border: DynamicBorder;
	private list!: SelectList;
	private items: SelectItem[] = [];
	private maxVisible: number;
	private searching = false;
	private pasting = false;
	private hasFocus = false;
	private message = "";

	constructor(options: ListOptions) {
		this.options = options;
		const userBindings = options.keybindings.getUserBindings();
		const claimed = new Set(Object.keys(WORKTREE_LIST_KEYBINDINGS).flatMap((id) => {
			const value = userBindings[id];
			return value === undefined ? [] : Array.isArray(value) ? value : [value];
		}));
		// An explicit assignment wins over another action's default, even for navigation.
		const definitions = Object.fromEntries(Object.entries(WORKTREE_LIST_KEYBINDINGS).map(([id, definition]) => [id, {
			...definition,
			defaultKeys: (Array.isArray(definition.defaultKeys) ? definition.defaultKeys : [definition.defaultKeys]).filter((key) => !claimed.has(key)),
		}]));
		this.bindings = new KeybindingsManager(definitions, userBindings);
		this.maxVisible = Math.max(1, options.maxVisible ?? 10);
		this.border = new DynamicBorder((text) => options.theme.fg("accent", text));
		this.input = new Input({ prompt: "Search: ", placeholder: "Branch or path…" });
		this.input.setValue(options.query ?? "");
		this.input.onSubmit = () => this.setSearching(false);
		this.input.onEscape = () => this.setSearching(false);
		this.refreshMatches();
		const index = this.items.findIndex((item) => item.value === options.selectedPath);
		if (index >= 0) this.list.setSelectedIndex(index);
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) {
		this.hasFocus = value;
		this.input.focused = value && this.searching;
	}

	private setSearching(value: boolean): void {
		this.searching = value;
		this.input.focused = this.hasFocus && value;
	}

	private refreshMatches(): void {
		this.items = fuzzyFilter(this.options.worktrees, this.input.getValue(), (wt) => `${wt.branch ?? "(detached)"} ${wt.path}`).map((wt) => ({
			value: wt.path,
			label: `${wt.branch ?? "(detached)"} ${wt.isMain ? "[main]" : wt.isManaged ? "[managed]" : "[external]"}${wt.tmuxActive ? " ⚡ tmux:active" : ""}`,
			description: wt.path,
		}));
		this.createList();
	}

	private createList(): void {
		const { theme } = this.options;
		this.list = new SelectList(this.items, this.maxVisible, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: () => theme.fg("warning", "No matching worktrees"),
		}, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 80 });
	}

	private selected(): ListedWorktree | undefined {
		return this.options.worktrees.find((wt) => wt.path === this.list.getSelectedItem()?.value);
	}

	private move(delta: number, wrap = false): void {
		if (!this.items.length) return;
		const index = this.items.findIndex((item) => item === this.list.getSelectedItem());
		this.list.setSelectedIndex(wrap ? (index + delta + this.items.length) % this.items.length : index + delta);
	}

	private act(command: ListCommand): void {
		const worktree = this.selected();
		this.message = unavailableAction(command, worktree) ?? "";
		if (!this.message) this.options.onSelect({ command, worktree, query: this.input.getValue() });
	}

	handleInput(data: string): void {
		this.message = "";
		// Bracketed paste is always search text, never a burst of destructive shortcuts.
		if (this.pasting || data.includes("\x1b[200~")) {
			this.pasting = !data.includes("\x1b[201~");
			this.setSearching(true);
			this.input.handleInput(data);
			this.refreshMatches();
		} else if (this.searching) {
			const kb = this.options.keybindings;
			if (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
				this.setSearching(false);
			} else if (kb.matches(data, "tui.select.up")) this.move(-1, true);
			else if (kb.matches(data, "tui.select.down")) this.move(1, true);
			else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.maxVisible);
			else if (kb.matches(data, "tui.select.pageDown")) this.move(this.maxVisible);
			else {
				const previous = this.input.getValue();
				this.input.handleInput(data);
				if (previous !== this.input.getValue()) this.refreshMatches();
			}
		} else {
			const kb = this.bindings;
			const conflicts = kb.getConflicts().filter((conflict) => matchesKey(data, conflict.key));
			if (conflicts.length) {
				this.message = "This key has conflicting bindings; fix worktree.list.* in keybindings.json.";
				this.options.requestRender();
				return;
			}
			if (kb.matches(data, "worktree.list.cancel")) this.options.onCancel();
			else if (kb.matches(data, "worktree.list.search")) this.setSearching(true);
			else if (kb.matches(data, "worktree.list.up")) this.move(-1, true);
			else if (kb.matches(data, "worktree.list.down")) this.move(1, true);
			else if (kb.matches(data, "worktree.list.pageUp")) this.move(-this.maxVisible);
			else if (kb.matches(data, "worktree.list.pageDown")) this.move(this.maxVisible);
			else if (kb.matches(data, "worktree.list.first")) this.list.setSelectedIndex(0);
			else if (kb.matches(data, "worktree.list.last")) this.list.setSelectedIndex(this.items.length - 1);
			else {
				for (const command of listCommands) {
					if (kb.matches(data, `worktree.list.${command}`)) { this.act(command); break; }
				}
			}
		}
		this.options.requestRender();
	}

	private hint(action: ListCommand | ListControl): string {
		const id = `worktree.list.${action}` as const;
		const keys = this.bindings.getKeys(id).join("/") || "unbound";
		return `${keys}: ${WORKTREE_LIST_KEYBINDINGS[id].description}`;
	}

	render(width: number): string[] {
		const { theme } = this.options;
		const wt = this.selected();
		const hintGroups: Array<Array<ListCommand | ListControl>> = [
			["up", "down", "search", "cancel"],
			["switch", "remove", "rename", "rebase", "tip"],
			["create", "list", "sessions", "pr", "clean", "help"],
		];
		const hints = hintGroups.flatMap((group) => wrapTextWithAnsi(group.map((action) => this.hint(action)).join(" · "), Math.max(1, width)));
		if (this.searching) hints.push(...wrapTextWithAnsi("Type to fuzzy-search · Enter/Escape: normal mode · Ctrl+U: clear query", Math.max(1, width)));
		if (this.options.getRows) {
			const maxVisible = Math.max(1, Math.min(this.options.maxVisible ?? 10, this.options.getRows() - hints.length - 10));
			if (maxVisible !== this.maxVisible) {
				const index = this.items.indexOf(this.list.getSelectedItem()!);
				this.maxVisible = maxVisible;
				this.createList();
				this.list.setSelectedIndex(index);
			}
		}
		const conflicts = this.bindings.getConflicts().map((conflict) => `${conflict.key}: ${conflict.keybindings.join(", ")}`).join("; ");
		return [
			...this.border.render(width),
			theme.fg("accent", theme.bold(`Git Worktrees — ${this.searching ? "SEARCH" : "NORMAL"}`)),
			...this.input.render(width),
			...this.list.render(width),
			"",
			theme.fg("muted", wt ? `Path: ${wt.path}` : "No worktree selected"),
			theme.fg("muted", wt ? `Commit: ${wt.commit?.slice(0, 8) ?? "—"}${wt.tmuxActive ? " · tmux:active" : ""}${wt.locked ? " · locked" : ""}${wt.prunable ? " · prunable" : ""}${wt.bare ? " · bare" : ""}` : ""),
			theme.fg("warning", this.message || (conflicts ? `Conflicting bindings: ${conflicts}` : "")),
			...hints.map((hint) => theme.fg("dim", hint)),
			...this.border.render(width),
		].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void { this.input.invalidate(); this.list.invalidate(); this.border.invalidate(); }
}

const listCommands: ListCommand[] = ["create", "list", "sessions", "switch", "rebase", "tip", "pr", "rename", "remove", "clean", "help"];

/** Dispose the custom component before opening a dialog or starting agent/session work. */
export async function browseWorktrees(
	ctx: ExtensionCommandContext,
	load: () => Promise<ListedWorktree[]>,
	run: (choice: ListChoice) => Promise<void>,
): Promise<void> {
	let query = "";
	let selectedPath: string | undefined;
	while (true) {
		const worktrees = await load();
		const choice = await ctx.ui.custom<ListChoice | undefined>((tui, theme, keybindings, done) => new WorktreeList({
			worktrees, theme, keybindings, query, selectedPath,
			maxVisible: Math.max(1, worktrees.length), getRows: () => tui.terminal.rows ?? 24,
			requestRender: () => tui.requestRender(), onSelect: done, onCancel: () => done(undefined),
		}));
		if (!choice) return;
		query = choice.query;
		selectedPath = choice.worktree?.path;
		if (choice.command === "list") continue;
		if (["switch", "rename", "remove", "rebase", "tip", "pr"].includes(choice.command)) {
			const fresh = (await load()).find((wt) => wt.path === selectedPath && wt.branch === choice.worktree?.branch);
			const reason = fresh ? unavailableAction(choice.command, fresh) : "The selected worktree changed or disappeared. Select it again.";
			if (reason) { ctx.ui.notify(reason, "warning"); continue; }
			choice.worktree = fresh;
		}
		await run(choice);
		// These actions may switch sessions/windows or enqueue conflict-resolution/PR work.
		if (["switch", "sessions", "rebase", "tip", "pr"].includes(choice.command)) return;
	}
}
