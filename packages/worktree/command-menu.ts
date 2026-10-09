/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import {
	DynamicBorder,
	keyHint,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	SelectList,
	fuzzyFilter,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type SelectItem,
} from "@earendil-works/pi-tui";

const commands: SelectItem[] = [
	{ value: "create", label: "➕ Create new worktree" },
	{ value: "list", label: "📋 List all worktrees" },
	{ value: "sessions", label: "💬 Browse sessions" },
	{ value: "switch", label: "🔀 Switch/attach to worktree" },
	{ value: "rebase", label: "🔄 Rebase main/master onto worktree" },
	{ value: "tip", label: "⤴️ Tip worktree onto main/master" },
	{ value: "pr", label: "📤 Create PR and ensure green CI" },
	{ value: "rename", label: "✏️  Rename worktree branch" },
	{ value: "remove", label: "🗑️  Remove a worktree" },
	{ value: "clean", label: "🧹 Clean up all managed worktrees" },
	{ value: "help", label: "❓ Help" },
];

interface MenuOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender(): void;
	onSelect(command: string): void;
	onCancel(): void;
	maxVisible?: number;
}

interface SearchableMenuOptions extends MenuOptions {
	title: string;
	items: SelectItem[];
	placeholder: string;
	emptyMessage?: string;
}

/** Typing ranks fuzzy matches; Enter returns only the highlighted item's original value. */
export class SearchableMenu implements Component, Focusable {
	private search: Input;
	private list: SelectList;
	private items: SelectItem[];
	private border: DynamicBorder;
	private maxVisible: number;
	private options: SearchableMenuOptions;
	private pasting = false;
	private query = "";

	constructor(options: SearchableMenuOptions) {
		this.options = options;
		this.items = options.items;
		this.maxVisible = Math.max(1, options.maxVisible ?? options.items.length);
		this.border = new DynamicBorder((text) => options.theme.fg("accent", text));
		this.search = new Input({
			prompt: "Search: ",
			placeholder: options.placeholder,
			placeholderStyle: (text) => options.theme.fg("dim", text),
		});
		this.search.onSubmit = () => {
			this.refreshMatches();
			this.confirm();
		};
		this.search.onEscape = options.onCancel;
		this.list = this.createList();
	}

	get focused(): boolean {
		return this.search.focused;
	}

	set focused(value: boolean) {
		this.search.focused = value;
	}

	private createList(): SelectList {
		const { theme } = this.options;
		return new SelectList(this.items, this.maxVisible, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", this.options.emptyMessage ?? text),
		});
	}

	private confirm(): void {
		const selected = this.list.getSelectedItem();
		if (selected) this.options.onSelect(selected.value);
	}

	private refreshMatches(): void {
		if (this.search.getValue() === this.query) return;
		this.query = this.search.getValue();
		this.items = fuzzyFilter(this.options.items, this.query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`);
		// SelectList.setFilter is prefix-only; rebuilding retains fuzzy ranking and selects the best match.
		this.list = this.createList();
	}

	private handleSearchInput(data: string): void {
		this.search.handleInput(data);
		this.refreshMatches();
	}

	handleInput(data: string): void {
		// Pasted newlines/control keys are query content, never navigation or confirmation.
		if (this.pasting || data.includes("\x1b[200~")) {
			this.pasting = !data.includes("\x1b[201~");
			this.handleSearchInput(data);
			this.options.requestRender();
			return;
		}
		const { keybindings: kb } = this.options;
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			const index = this.items.indexOf(this.list.getSelectedItem()!);
			const delta = kb.matches(data, "tui.select.up") ? -1 : 1;
			if (this.items.length) this.list.setSelectedIndex((index + delta + this.items.length) % this.items.length);
		} else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
			const index = this.items.indexOf(this.list.getSelectedItem()!);
			const delta = kb.matches(data, "tui.select.pageUp") ? -this.maxVisible : this.maxVisible;
			this.list.setSelectedIndex(index + delta);
		} else {
			this.handleSearchInput(data);
		}
		this.options.requestRender();
	}

	render(width: number): string[] {
		const { theme } = this.options;
		const hints = [
			"Type to fuzzy-search",
			keyHint("tui.select.up", "up"),
			keyHint("tui.select.down", "down"),
			keyHint("tui.select.confirm", "select"),
			keyHint("tui.select.cancel", "cancel"),
		].join(" · ");
		return [
			...this.border.render(width),
			theme.fg("accent", theme.bold(this.options.title)),
			...this.search.render(width),
			"",
			...this.list.render(width),
			"",
			theme.fg("dim", hints),
			...this.border.render(width),
		].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.search.invalidate();
		this.list.invalidate();
		this.border.invalidate();
	}
}

export class WorktreeCommandMenu extends SearchableMenu {
	constructor(options: MenuOptions) {
		super({ ...options, title: "Worktree Management", items: commands, placeholder: "Type a command…" });
	}
}

export async function selectWorktreeCommand(ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		// RPC clients support select dialogs, not custom terminal components.
		const selected = await ctx.ui.select("Worktree Management", commands.map((item) => item.label));
		return commands.find((item) => item.label === selected)?.value;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => new WorktreeCommandMenu({
		theme,
		keybindings,
		requestRender: () => tui.requestRender(),
		onSelect: (command) => done(command),
		onCancel: () => done(undefined),
		maxVisible: Math.max(1, Math.min(commands.length, (tui.terminal.rows ?? 24) - 9)),
	}));
}
