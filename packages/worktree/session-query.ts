/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Search, sort, and tree layout for the worktree session picker.
 * Query syntax matches /resume: fuzzy tokens, "quoted phrases", and re:<regex>.
 * Tokens may also target one field: branch:, worktree: (or wt:), name:, path:.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

/**
 * Same character-order scoring as `@earendil-works/pi-tui` `fuzzyMatch`.
 * Kept here so session search does not depend on the TUI package at test time.
 */
function fuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();
	const matchQuery = (normalizedQuery: string) => {
		if (normalizedQuery.length === 0) return { matches: true, score: 0 };
		if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };
		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;
		while (queryIndex < normalizedQuery.length) {
			const i = textLower.indexOf(normalizedQuery[queryIndex], lastMatchIndex + 1);
			if (i === -1) break;
			const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1] ?? "");
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
			}
			if (isWordBoundary) score -= 10;
			score += i * 0.1;
			lastMatchIndex = i;
			queryIndex++;
		}
		if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
		if (normalizedQuery === textLower) score -= 100;
		return { matches: true, score };
	};
	const primary = matchQuery(queryLower);
	if (primary.matches) return primary;
	const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(queryLower);
	const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(queryLower);
	const swapped = alphaNumeric
		? `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`
		: numericAlpha
			? `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`
			: "";
	if (!swapped) return primary;
	const swappedMatch = matchQuery(swapped);
	if (!swappedMatch.matches) return primary;
	return { matches: true, score: swappedMatch.score + 5 };
}

export type SessionScope = "current" | "worktrees";
export type SortMode = "threaded" | "recent" | "relevance";
export type NameFilter = "all" | "named";
export type FieldFilter = "all" | "branch" | "worktree";

export interface WorktreeSessionSource {
	branch: string;
	path: string;
	missing?: boolean;
}

export interface WorktreeSessionRow {
	session: SessionInfo;
	branch: string;
	worktreePath: string;
	worktreeName: string;
	missing: boolean;
}

export interface SessionTreeNode {
	row: WorktreeSessionRow;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
}

const SORT_MODES: SortMode[] = ["threaded", "recent", "relevance"];
const FIELD_FILTERS: FieldFilter[] = ["all", "branch", "worktree"];

export function nextSortMode(mode: SortMode): SortMode {
	return SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length] ?? "threaded";
}

export function nextNameFilter(filter: NameFilter): NameFilter {
	return filter === "all" ? "named" : "all";
}

export function nextFieldFilter(filter: FieldFilter): FieldFilter {
	return FIELD_FILTERS[(FIELD_FILTERS.indexOf(filter) + 1) % FIELD_FILTERS.length] ?? "all";
}

export function nextScope(scope: SessionScope): SessionScope {
	return scope === "current" ? "worktrees" : "current";
}

export function sortModeLabel(mode: SortMode): string {
	if (mode === "threaded") return "Threaded";
	if (mode === "recent") return "Recent";
	return "Fuzzy";
}

export function nameFilterLabel(filter: NameFilter): string {
	return filter === "all" ? "All" : "Named";
}

export function fieldFilterLabel(filter: FieldFilter): string {
	if (filter === "branch") return "Branch";
	if (filter === "worktree") return "Worktree";
	return "All";
}

export function scopeLabel(scope: SessionScope): string {
	return scope === "current" ? "Current Folder" : "All Worktrees";
}

export function toWorktreeSessionRow(session: SessionInfo, source: WorktreeSessionSource): WorktreeSessionRow {
	const worktreePath = source.path || session.cwd;
	const base = worktreePath ? path.basename(worktreePath) : "";
	return {
		session,
		branch: source.branch || "(detached)",
		worktreePath,
		worktreeName: base || worktreePath,
		missing: source.missing ?? false,
	};
}

type SearchField = "all" | "branch" | "worktree" | "name" | "path";

interface ParsedToken {
	kind: "fuzzy" | "phrase";
	value: string;
}

interface ParsedQuery {
	mode: "tokens" | "regex";
	tokens: ParsedToken[];
	regex: RegExp | null;
	error?: string;
}

function canonical(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function corpus(row: WorktreeSessionRow, field: SearchField): string {
	const session = row.session;
	switch (field) {
		case "branch":
			return row.branch;
		case "worktree":
			return `${row.worktreeName} ${row.worktreePath}`;
		case "name":
			return session.name ?? "";
		case "path":
			return `${session.path} ${session.cwd} ${row.worktreePath}`;
		case "all":
			return [
				session.id,
				session.name ?? "",
				session.firstMessage,
				session.allMessagesText,
				session.cwd,
				session.path,
				row.branch,
				row.worktreeName,
				row.worktreePath,
				row.missing ? "missing" : "present",
			].join(" ");
	}
}

function fieldForFilter(filter: FieldFilter): SearchField {
	if (filter === "branch") return "branch";
	if (filter === "worktree") return "worktree";
	return "all";
}

function splitPrefix(value: string): { field: SearchField | null; value: string } {
	const match = /^(branch|worktree|wt|name|path):(.*)$/i.exec(value);
	if (!match) return { field: null, value };
	const raw = match[1].toLowerCase();
	const field: SearchField = raw === "wt" || raw === "worktree" ? "worktree" : (raw as SearchField);
	return { field, value: match[2] };
}

function parseSearchQuery(query: string): ParsedQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [], regex: null };
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: message };
		}
	}

	const tokens: ParsedToken[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;
	const flush = (kind: ParsedToken["kind"]) => {
		const value = buf.trim();
		buf = "";
		if (value) tokens.push({ kind, value });
	};
	for (const ch of trimmed) {
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}
		buf += ch;
	}
	if (inQuote) hadUnclosedQuote = true;
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0)
				.map((token) => ({ kind: "fuzzy", value: token })),
			regex: null,
		};
	}
	flush(inQuote ? "phrase" : "fuzzy");
	return { mode: "tokens", tokens, regex: null };
}

function matchRow(
	row: WorktreeSessionRow,
	parsed: ParsedQuery,
	fieldFilter: FieldFilter,
): { matches: boolean; score: number } {
	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const text = corpus(row, fieldForFilter(fieldFilter));
		const index = text.search(parsed.regex);
		if (index < 0) return { matches: false, score: 0 };
		return { matches: true, score: index * 0.1 };
	}
	if (parsed.tokens.length === 0) return { matches: true, score: 0 };

	let total = 0;
	for (const token of parsed.tokens) {
		const prefixed = splitPrefix(token.value);
		if (!prefixed.value) continue;
		const field = prefixed.field ?? fieldForFilter(fieldFilter);
		const text = corpus(row, field);
		if (token.kind === "phrase") {
			const normalized = normalizeWhitespaceLower(text);
			const phrase = normalizeWhitespaceLower(prefixed.value);
			const index = normalized.indexOf(phrase);
			if (index < 0) return { matches: false, score: 0 };
			total += index * 0.1;
			continue;
		}
		const fuzzy = fuzzyMatch(prefixed.value, text);
		if (!fuzzy.matches) return { matches: false, score: 0 };
		total += fuzzy.score;
	}
	return { matches: true, score: total };
}

function hasSessionName(row: WorktreeSessionRow): boolean {
	return Boolean(row.session.name?.trim());
}

function flatNode(row: WorktreeSessionRow): SessionTreeNode {
	return { row, depth: 0, isLast: true, ancestorContinues: [] };
}

interface TreeBuildNode {
	row: WorktreeSessionRow;
	children: TreeBuildNode[];
	latestActivity: number;
}

function buildSessionTree(rows: WorktreeSessionRow[]): TreeBuildNode[] {
	const byPath = new Map<string, TreeBuildNode>();
	for (const row of rows) {
		const sessionPath = canonical(row.session.path) ?? row.session.path;
		byPath.set(sessionPath, {
			row,
			children: [],
			latestActivity: row.session.modified.getTime(),
		});
	}
	const roots: TreeBuildNode[] = [];
	for (const row of rows) {
		const sessionPath = canonical(row.session.path) ?? row.session.path;
		const node = byPath.get(sessionPath);
		if (!node) continue;
		const parentPath = canonical(row.session.parentSessionPath);
		const parent = parentPath ? byPath.get(parentPath) : undefined;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	const updateLatest = (node: TreeBuildNode): number => {
		let latest = node.row.session.modified.getTime();
		for (const child of node.children) latest = Math.max(latest, updateLatest(child));
		node.latestActivity = latest;
		return latest;
	};
	for (const root of roots) updateLatest(root);
	const sortNodes = (nodes: TreeBuildNode[]) => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) sortNodes(node.children);
	};
	sortNodes(roots);
	return roots;
}

function flattenSessionTree(roots: TreeBuildNode[]): SessionTreeNode[] {
	const result: SessionTreeNode[] = [];
	const walk = (node: TreeBuildNode, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
		result.push({ row: node.row, depth, isLast, ancestorContinues });
		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i], depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};
	for (let i = 0; i < roots.length; i++) {
		walk(roots[i], 0, [], i === roots.length - 1);
	}
	return result;
}

export function filterWorktreeSessions(
	rows: WorktreeSessionRow[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter,
	fieldFilter: FieldFilter,
): SessionTreeNode[] {
	const named = nameFilter === "all" ? rows : rows.filter(hasSessionName);
	const trimmed = query.trim();
	if (sortMode === "threaded" && !trimmed) {
		return flattenSessionTree(buildSessionTree(named));
	}
	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];
	if (!trimmed) return named.map(flatNode);

	if (sortMode === "recent") {
		const filtered: WorktreeSessionRow[] = [];
		for (const row of named) {
			if (matchRow(row, parsed, fieldFilter).matches) filtered.push(row);
		}
		return filtered.map(flatNode);
	}

	const scored: Array<{ row: WorktreeSessionRow; score: number }> = [];
	for (const row of named) {
		const result = matchRow(row, parsed, fieldFilter);
		if (result.matches) scored.push({ row, score: result.score });
	}
	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.row.session.modified.getTime() - a.row.session.modified.getTime();
	});
	return scored.map((entry) => flatNode(entry.row));
}
