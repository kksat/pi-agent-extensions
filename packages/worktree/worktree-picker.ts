/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

export type PickerContext = Pick<ExtensionCommandContext, "mode"> & {
	ui: Pick<ExtensionCommandContext["ui"], "select" | "custom">;
};

/** Use a focused fuzzy search in the terminal, preserving ordinary select dialogs for RPC. */
export async function selectSearchableItem(
	ctx: PickerContext,
	title: string,
	items: SelectItem[],
	placeholder = "Type a branch or path…",
): Promise<string | undefined> {
	if (!items.length) return undefined;
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select(title, items.map((item) => item.label));
		return items.find((item) => item.label === selected)?.value;
	}
	// Keep non-TUI commands and real-Git tests independent of terminal runtime dependencies.
	const { SearchableMenu } = await import("./command-menu.ts");
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => new SearchableMenu({
		title,
		items,
		placeholder,
		emptyMessage: "No matching worktrees or folders",
		theme,
		keybindings,
		requestRender: () => tui.requestRender(),
		onSelect: (value) => done(value),
		onCancel: () => done(undefined),
		maxVisible: Math.max(1, Math.min(items.length, (tui.terminal.rows ?? 24) - 9)),
	}));
}

/** Search both branch names and checkout paths; return the exact branch, never the query. */
export function selectWorktree(
	ctx: PickerContext,
	title: string,
	worktrees: Array<{ branch?: string; path: string }>,
): Promise<string | undefined> {
	return selectSearchableItem(ctx, title, worktrees.filter((wt) => wt.branch).map((wt) => ({
		value: wt.branch!,
		label: wt.branch!,
		description: wt.path,
	})));
}
