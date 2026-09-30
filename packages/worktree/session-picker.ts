/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Worktree session picker modeled on /resume.
 * Tab switches the current folder and every recorded worktree.
 * Ctrl+S sorts, Ctrl+N keeps named sessions, Ctrl+Shift+B cycles branch/worktree filter.
 */

import * as os from "node:os";
import {
	DynamicBorder,
	SessionManager,
	keyHint,
	keyText,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
} from "@earendil-works/pi-tui";
import {
	fieldFilterLabel,
	filterWorktreeSessions,
	nameFilterLabel,
	nextFieldFilter,
	nextNameFilter,
	nextScope,
	nextSortMode,
	sortModeLabel,
	type FieldFilter,
	type NameFilter,
	type SessionScope,
	type SessionTreeNode,
	type SortMode,
	type WorktreeSessionRow,
} from "./session-query.ts";

export type SessionRowsLoader = (signal?: AbortSignal) => Promise<WorktreeSessionRow[]>;

export interface WorktreeSessionSelectorOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender: () => void;
	loadCurrent: SessionRowsLoader;
	loadWorktrees: SessionRowsLoader;
	onSelect: (row: WorktreeSessionRow) => void;
	onCancel: () => void;
	renameSession?: (sessionPath: string, nextName: string) => Promise<void>;
	currentSessionFilePath?: string;
	maxVisible?: number;
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	if (!filePath) return filePath;
	if (filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function formatSessionDate(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function sessionTitle(row: WorktreeSessionRow): string {
	const named = row.session.name?.trim();
	if (named) return named;
	const message = row.session.firstMessage.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return message || "(empty)";
}

class PickerHeader implements Component {
	scope: SessionScope = "current";
	sortMode: SortMode = "threaded";
	nameFilter: NameFilter = "all";
	fieldFilter: FieldFilter = "all";
	loading = false;
	showPath = false;
	statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private theme: Theme;
	private requestRender: () => void;
	private showRenameHint: boolean;

	constructor(theme: Theme, requestRender: () => void, showRenameHint: boolean) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.showRenameHint = showRenameHint;
	}

	invalidate(): void {}

	setStatus(message: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		if (this.statusTimeout) {
			clearTimeout(this.statusTimeout);
			this.statusTimeout = null;
		}
		this.statusMessage = message;
		if (!message || !autoHideMs) return;
		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	dispose(): void {
		if (this.statusTimeout) clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const title =
			this.scope === "current" ? "Worktree Sessions (Current Folder)" : "Worktree Sessions (All Worktrees)";
		const leftText = theme.bold(title);
		const scopeText =
			this.loading
				? `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "Loading...")}`
				: this.scope === "current"
					? `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All Worktrees")}`
					: `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All Worktrees")}`;
		const filterText = theme.fg("muted", "Filter: ") + theme.fg("accent", fieldFilterLabel(this.fieldFilter));
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameFilterLabel(this.nameFilter));
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortModeLabel(this.sortMode));
		const rightText = truncateToWidth(`${scopeText}  ${filterText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		let hintLine1 = "";
		let hintLine2 = "";
		if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
		} else {
			const sep = theme.fg("muted", " · ");
			const pathState = this.showPath ? "(on)" : "(off)";
			const hint2 = [
				keyHint("app.session.toggleSort" as never, "sort"),
				keyHint("app.session.toggleNamedFilter" as never, "named"),
				rawKeyHint("ctrl+shift+b", "filter"),
				keyHint("app.session.togglePath" as never, `path ${pathState}`),
			];
			if (this.showRenameHint) hint2.push(keyHint("app.session.rename" as never, "rename"));
			hintLine1 = truncateToWidth(
				keyHint("tui.input.tab", "scope") +
					sep +
					theme.fg("muted", 're:<pattern> regex · "phrase" exact · branch: · worktree:'),
				width,
				"…",
			);
			hintLine2 = truncateToWidth(hint2.join(sep), width, "…");
		}
		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

class SessionRows implements Component, Focusable {
	private rows: WorktreeSessionRow[] = [];
	private nodes: SessionTreeNode[] = [];
	private selectedIndex = 0;
	private selectionTouched = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private fieldFilter: FieldFilter = "all";
	private scope: SessionScope = "current";
	private showPath = false;
	private loading = false;
	private searchInput = new Input();
	private _focused = false;
	onSelect?: (row: WorktreeSessionRow) => void;
	onCancel?: () => void;
	onToggleScope?: () => void;
	onToggleSort?: () => void;
	onToggleNameFilter?: () => void;
	onToggleFieldFilter?: () => void;
	onTogglePath?: (showPath: boolean) => void;
	onRename?: (row: WorktreeSessionRow) => void;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private maxVisible: number;
	private currentSessionFilePath: string | undefined;

	constructor(
		theme: Theme,
		keybindings: KeybindingsManager,
		maxVisible: number,
		currentSessionFilePath: string | undefined,
	) {
		this.theme = theme;
		this.keybindings = keybindings;
		this.maxVisible = maxVisible;
		this.currentSessionFilePath = currentSessionFilePath;
		this.searchInput.onSubmit = () => {
			const selected = this.nodes[this.selectedIndex];
			if (selected) this.onSelect?.(selected.row);
		};
		this.applyQuery();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	invalidate(): void {}

	setRows(rows: WorktreeSessionRow[], scope: SessionScope, loading: boolean): void {
		const selectedPath = this.selectionTouched ? this.nodes[this.selectedIndex]?.row.session.path : undefined;
		this.rows = rows;
		this.scope = scope;
		this.loading = loading;
		this.applyQuery();
		if (!this.selectionTouched) {
			this.selectedIndex = 0;
		} else if (selectedPath) {
			const index = this.nodes.findIndex((node) => node.row.session.path === selectedPath);
			if (index >= 0) this.selectedIndex = index;
		}
	}

	setSortMode(mode: SortMode): void {
		this.sortMode = mode;
		this.applyQuery();
	}

	setNameFilter(filter: NameFilter): void {
		this.nameFilter = filter;
		this.applyQuery();
	}

	setFieldFilter(filter: FieldFilter): void {
		this.fieldFilter = filter;
		this.applyQuery();
	}

	private applyQuery(): void {
		this.nodes = filterWorktreeSessions(
			this.rows,
			this.searchInput.getValue(),
			this.sortMode,
			this.nameFilter,
			this.fieldFilter,
		);
		if (this.nodes.length === 0) this.selectedIndex = 0;
		else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.nodes.length - 1));
	}

	private treePrefix(node: SessionTreeNode): string {
		if (node.depth === 0) return "";
		const ancestors = node.ancestorContinues.map((continues) => (continues ? "│  " : "   ")).join("");
		return ancestors + (node.isLast ? "└─ " : "├─ ");
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines = [...this.searchInput.render(width), ""];
		if (this.nodes.length === 0) {
			let empty = "  No sessions match.";
			if (this.loading) empty = "  Loading sessions...";
			else if (this.nameFilter === "named") {
				empty = `  No named sessions. Press ${keyText("app.session.toggleNamedFilter" as never)} to show all.`;
			} else if (!this.searchInput.getValue().trim() && this.scope === "current") {
				empty = "  No sessions in current folder. Press Tab to view all worktrees.";
			} else if (!this.searchInput.getValue().trim()) {
				empty = "  No sessions found for recorded worktrees.";
			}
			lines.push(truncateToWidth(empty, width, "…"));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.nodes.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.nodes.length);
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.nodes[i];
			const row = node.row;
			const selected = i === this.selectedIndex;
			const current = this.currentSessionFilePath && row.session.path === this.currentSessionFilePath;
			const prefix = this.treePrefix(node);
			const title = sessionTitle(row);
			const age = formatSessionDate(row.session.modified);
			const count = String(row.session.messageCount);
			let meta = `${row.branch} · ${row.worktreeName}`;
			if (row.missing) meta = `missing ${meta}`;
			if (this.showPath) meta = `${shortenPath(row.session.path)}  ${meta}`;
			const rightPart = `${meta}  ${count} ${age}`;
			const cursor = selected ? theme.fg("accent", "› ") : "  ";
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2;
			const available = Math.max(10, width - 2 - prefixWidth - rightWidth);
			const truncated = truncateToWidth(title, available, "…");
			let messageColor: "accent" | "warning" | null = null;
			if (current) messageColor = "accent";
			else if (row.session.name?.trim()) messageColor = "warning";
			let styled = messageColor ? theme.fg(messageColor, truncated) : truncated;
			if (selected) styled = theme.bold(styled);
			const leftPart = cursor + theme.fg("dim", prefix) + styled;
			const gap = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(rightPart));
			const styledRight = theme.fg(row.missing ? "error" : "dim", rightPart);
			let line = leftPart + " ".repeat(gap) + styledRight;
			if (selected) line = theme.bg("selectedBg", line);
			lines.push(truncateToWidth(line, width));
		}
		if (startIndex > 0 || endIndex < this.nodes.length) {
			lines.push(theme.fg("muted", truncateToWidth(`  (${this.selectedIndex + 1}/${this.nodes.length})`, width, "")));
		}
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.input.tab")) {
			this.onToggleScope?.();
			return;
		}
		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}
		if (kb.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}
		if (matchesKey(keyData, "ctrl+shift+b") || matchesKey(keyData, "shift+ctrl+b")) {
			this.onToggleFieldFilter?.();
			return;
		}
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.nodes[this.selectedIndex];
			if (selected) this.onRename?.(selected.row);
			return;
		}
		if (this.nodes.length === 0) {
			if (kb.matches(keyData, "tui.select.cancel")) this.onCancel?.();
			else {
				this.searchInput.handleInput(keyData);
				this.applyQuery();
			}
			return;
		}
		this.selectionTouched = true;
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.nodes.length - 1, this.selectedIndex + 1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.nodes.length - 1, this.selectedIndex + this.maxVisible);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.nodes[this.selectedIndex];
			if (selected) this.onSelect?.(selected.row);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyQuery();
	}
}

export class WorktreeSessionSelector extends Container implements Focusable {
	private header: PickerHeader;
	private list: SessionRows;
	private renameInput = new Input();
	private mode: "list" | "rename" = "list";
	private renameTarget: WorktreeSessionRow | null = null;
	private scope: SessionScope = "worktrees";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private fieldFilter: FieldFilter = "all";
	private currentRows: WorktreeSessionRow[] | null = null;
	private worktreeRows: WorktreeSessionRow[] | null = null;
	private currentLoad: AbortController | null = null;
	private worktreeLoad: AbortController | null = null;
	private _focused = false;
	private options: WorktreeSessionSelectorOptions;

	constructor(options: WorktreeSessionSelectorOptions) {
		super();
		this.options = options;
		const showRename = Boolean(options.renameSession);
		this.header = new PickerHeader(options.theme, options.requestRender, showRename);
		this.list = new SessionRows(
			options.theme,
			options.keybindings,
			options.maxVisible ?? 10,
			options.currentSessionFilePath,
		);
		this.list.onSelect = (row) => {
			this.cancelLoads();
			options.onSelect(row);
		};
		this.list.onCancel = () => {
			this.cancelLoads();
			options.onCancel();
		};
		this.list.onToggleScope = () => this.toggleScope();
		this.list.onToggleSort = () => this.toggleSort();
		this.list.onToggleNameFilter = () => this.toggleName();
		this.list.onToggleFieldFilter = () => this.toggleField();
		this.list.onTogglePath = (showPath) => {
			this.header.showPath = showPath;
			options.requestRender();
		};
		this.list.onRename = (row) => this.enterRename(row);
		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};
		this.buildListLayout();
		void this.loadScope("worktrees");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.mode === "rename") this.renameInput.focused = value;
		else this.list.focused = value;
	}

	handleInput(data: string): void {
		if (this.mode === "rename") {
			if (this.options.keybindings.matches(data, "tui.select.cancel")) {
				this.exitRename();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}
		this.list.handleInput(data);
	}

	dispose(): void {
		this.cancelLoads();
		this.header.dispose();
	}

	private buildListLayout(): void {
		this.clear();
		this.addChild(this.header);
		this.addChild(new DynamicBorder((text) => this.options.theme.fg("accent", text)));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => this.options.theme.fg("accent", text)));
	}

	private activeRows(): WorktreeSessionRow[] {
		const rows = this.scope === "current" ? this.currentRows : this.worktreeRows;
		return rows ?? [];
	}

	private publishRows(): void {
		const loading = (this.scope === "current" ? this.currentLoad : this.worktreeLoad) !== null;
		this.header.scope = this.scope;
		this.header.loading = loading && this.activeRows().length === 0;
		this.header.sortMode = this.sortMode;
		this.header.nameFilter = this.nameFilter;
		this.header.fieldFilter = this.fieldFilter;
		this.list.setSortMode(this.sortMode);
		this.list.setNameFilter(this.nameFilter);
		this.list.setFieldFilter(this.fieldFilter);
		this.list.setRows(this.activeRows(), this.scope, this.header.loading);
		this.options.requestRender();
	}

	private cancelLoads(): void {
		this.currentLoad?.abort();
		this.worktreeLoad?.abort();
		this.currentLoad = null;
		this.worktreeLoad = null;
	}

	private async loadScope(scope: SessionScope): Promise<void> {
		if (scope === "current" ? this.currentLoad : this.worktreeLoad) return;
		const controller = new AbortController();
		if (scope === "current") this.currentLoad = controller;
		else this.worktreeLoad = controller;
		if (scope === this.scope) this.publishRows();
		const loader = scope === "current" ? this.options.loadCurrent : this.options.loadWorktrees;
		try {
			const rows = await loader(controller.signal);
			if ((scope === "current" ? this.currentLoad : this.worktreeLoad) !== controller) return;
			if (scope === "current") {
				this.currentRows = rows;
				this.currentLoad = null;
			} else {
				this.worktreeRows = rows;
				this.worktreeLoad = null;
			}
			if (scope === this.scope) this.publishRows();
		} catch (err) {
			if ((scope === "current" ? this.currentLoad : this.worktreeLoad) !== controller) return;
			if (scope === "current") this.currentLoad = null;
			else this.worktreeLoad = null;
			if (scope !== this.scope) return;
			const message = err instanceof Error ? err.message : String(err);
			this.header.setStatus({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
			this.publishRows();
		}
	}

	private toggleScope(): void {
		this.scope = nextScope(this.scope);
		const rows = this.scope === "current" ? this.currentRows : this.worktreeRows;
		const loading = (this.scope === "current" ? this.currentLoad : this.worktreeLoad) !== null;
		this.publishRows();
		if (rows === null && !loading) void this.loadScope(this.scope);
	}

	private toggleSort(): void {
		this.sortMode = nextSortMode(this.sortMode);
		this.publishRows();
	}

	private toggleName(): void {
		this.nameFilter = nextNameFilter(this.nameFilter);
		this.publishRows();
	}

	private toggleField(): void {
		this.fieldFilter = nextFieldFilter(this.fieldFilter);
		this.publishRows();
	}

	private enterRename(row: WorktreeSessionRow): void {
		if (!this.options.renameSession) return;
		if (this.scope === "current" ? this.currentLoad : this.worktreeLoad) return;
		this.mode = "rename";
		this.renameTarget = row;
		this.renameInput.setValue(row.session.name ?? "");
		this.renameInput.focused = this._focused;
		const panel = new Container();
		panel.addChild(new Text(this.options.theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(this.options.theme.fg("muted", "Enter to save · Escape to cancel"), 1, 0),
		);
		this.clear();
		this.addChild(new DynamicBorder((text) => this.options.theme.fg("accent", text)));
		this.addChild(panel);
		this.addChild(new DynamicBorder((text) => this.options.theme.fg("accent", text)));
		this.options.requestRender();
	}

	private exitRename(): void {
		this.mode = "list";
		this.renameTarget = null;
		this.buildListLayout();
		this.publishRows();
		this.list.focused = this._focused;
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		const target = this.renameTarget;
		const rename = this.options.renameSession;
		if (!next || !target || !rename) {
			this.exitRename();
			return;
		}
		try {
			await rename(target.session.path, next);
			const renamed = { ...target.session, name: next };
			const apply = (rows: WorktreeSessionRow[] | null) => {
				if (!rows) return;
				for (const row of rows) {
					if (row.session.path === target.session.path) row.session = renamed;
				}
			};
			apply(this.currentRows);
			apply(this.worktreeRows);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.header.setStatus({ type: "error", message: `Failed to rename: ${message}` }, 3000);
		} finally {
			this.exitRename();
		}
	}
}

export async function renameSessionFile(sessionPath: string, nextName: string): Promise<void> {
	const next = nextName.trim();
	if (!next) return;
	const manager = SessionManager.open(sessionPath);
	manager.appendSessionInfo(next);
}
