/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// What `/worktree` does with and without a git checkout.
//   node --experimental-strip-types packages/worktree/test.ts

import { routeWorktreeCommand } from "./route.ts";
import {
	filterWorktreeSessions,
	nextFieldFilter,
	nextScope,
	nextSortMode,
	toWorktreeSessionRow,
	type WorktreeSessionRow,
} from "./session-query.ts";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, msg: string) {
	const act = JSON.stringify(actual);
	const exp = JSON.stringify(expected);
	if (act === exp) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL: ${msg} (got ${act}, expected ${exp})`);
	}
}

console.log("Running worktree command routing tests...\n");

assertEqual(
	routeWorktreeCommand("", null),
	{ type: "menu", gitRoot: null },
	"plain /worktree outside a git repo opens the menu",
);
assertEqual(
	routeWorktreeCommand("   ", null),
	{ type: "menu", gitRoot: null },
	"blank /worktree outside a git repo opens the menu",
);
assertEqual(
	routeWorktreeCommand("sessions", null),
	{ type: "folder-sessions" },
	"/worktree sessions outside a git repo opens the usual session list",
);
assertEqual(
	routeWorktreeCommand("session", null),
	{ type: "folder-sessions" },
	"/worktree session outside a git repo opens the usual session list",
);
assertEqual(
	routeWorktreeCommand("list", null),
	{ type: "need-git" },
	"/worktree list outside a git repo still requires git",
);
assertEqual(routeWorktreeCommand("help", null), { type: "help" }, "/worktree help works outside a git repo");
assertEqual(
	routeWorktreeCommand("", "/repo"),
	{ type: "menu", gitRoot: "/repo" },
	"plain /worktree inside a git repo opens the menu",
);
assertEqual(
	routeWorktreeCommand("sessions", "/repo"),
	{ type: "sessions", gitRoot: "/repo" },
	"/worktree sessions inside a git repo lists worktree sessions",
);
assertEqual(
	routeWorktreeCommand("feature", "/repo"),
	{ type: "create", gitRoot: "/repo", args: "feature" },
	"/worktree <branch> inside a git repo creates that branch",
);
assertEqual(
	routeWorktreeCommand("create foo main", "/repo"),
	{ type: "create", gitRoot: "/repo", args: "foo main" },
	"/worktree create keeps only the arguments after the subcommand",
);

assertEqual(
	routeWorktreeCommand("rebase", "/repo"),
	{ type: "rebase", gitRoot: "/repo", args: "" },
	"/worktree rebase routes to rebase, not branch creation",
);
assertEqual(
	routeWorktreeCommand("rebase feature", "/repo"),
	{ type: "rebase", gitRoot: "/repo", args: "feature" },
	"/worktree rebase preserves the selected branch",
);
assertEqual(routeWorktreeCommand("rebase", null), { type: "need-git" }, "rebase requires a git repository");

assertEqual(routeWorktreeCommand("pr", "/repo"), { type: "pr", gitRoot: "/repo", args: "" }, "/worktree pr opens the PR workflow, not branch creation");
assertEqual(routeWorktreeCommand("pr feature", "/repo"), { type: "pr", gitRoot: "/repo", args: "feature" }, "/worktree pr preserves the target branch");
assertEqual(routeWorktreeCommand("pr", null), { type: "need-git" }, "/worktree pr requires a git repository");

function session(partial: Partial<SessionInfo> & Pick<SessionInfo, "path">): SessionInfo {
	return {
		id: partial.id ?? partial.path,
		cwd: partial.cwd ?? "/tmp/repo",
		name: partial.name,
		parentSessionPath: partial.parentSessionPath,
		created: partial.created ?? new Date(0),
		modified: partial.modified ?? new Date(0),
		messageCount: partial.messageCount ?? 1,
		firstMessage: partial.firstMessage ?? "",
		allMessagesText: partial.allMessagesText ?? partial.firstMessage ?? "",
		path: partial.path,
	};
}

function row(options: {
	path: string;
	branch: string;
	worktreeName?: string;
	worktreePath?: string;
	name?: string;
	firstMessage?: string;
	modified?: number;
	parent?: string;
	missing?: boolean;
}): WorktreeSessionRow {
	const worktreePath = options.worktreePath ?? `/tmp/${options.worktreeName ?? options.branch}`;
	return toWorktreeSessionRow(
		session({
			path: options.path,
			name: options.name,
			firstMessage: options.firstMessage,
			allMessagesText: options.firstMessage,
			modified: new Date(options.modified ?? 0),
			parentSessionPath: options.parent,
			cwd: worktreePath,
		}),
		{ branch: options.branch, path: worktreePath, missing: options.missing },
	);
}

function shown(nodes: ReturnType<typeof filterWorktreeSessions>): string[] {
	return nodes.map((node) => `${node.depth}:${node.row.session.path}`);
}

console.log("\nRunning worktree session query tests...\n");

const parent = row({ path: "/sessions/parent.jsonl", branch: "main", worktreeName: "repo", modified: 1, firstMessage: "start" });
const child = row({
	path: "/sessions/child.jsonl",
	branch: "main",
	worktreeName: "repo",
	modified: 5,
	parent: "/sessions/parent.jsonl",
	firstMessage: "follow up",
});
const feature = row({
	path: "/sessions/feature.jsonl",
	branch: "feature",
	worktreeName: "repo-feature",
	worktreePath: "/tmp/repo-feature",
	modified: 4,
	name: "Named feature",
	firstMessage: "widgets",
});
const discussion = row({
	path: "/sessions/discussion.jsonl",
	branch: "main",
	worktreeName: "repo",
	modified: 3,
	firstMessage: "feature discussion",
});
const allRows = [parent, child, feature, discussion];

assertEqual(
	shown(filterWorktreeSessions(allRows, "", "threaded", "all", "all")),
	["0:/sessions/parent.jsonl", "1:/sessions/child.jsonl", "0:/sessions/feature.jsonl", "0:/sessions/discussion.jsonl"],
	"threaded view nests a session under its parent and orders roots by latest activity",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "", "recent", "all", "all")),
	["0:/sessions/parent.jsonl", "0:/sessions/child.jsonl", "0:/sessions/feature.jsonl", "0:/sessions/discussion.jsonl"],
	"recent view keeps the incoming order",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "", "threaded", "named", "all")),
	["0:/sessions/feature.jsonl"],
	"named filter keeps only sessions with a name",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "feature", "recent", "all", "branch")),
	["0:/sessions/feature.jsonl"],
	"branch filter matches the branch and not message text",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "feature", "recent", "all", "all")).sort(),
	["0:/sessions/discussion.jsonl", "0:/sessions/feature.jsonl"].sort(),
	"all-fields search matches both the branch and message text",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "repo-feature", "recent", "all", "worktree")),
	["0:/sessions/feature.jsonl"],
	"worktree filter matches the worktree folder name",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "branch:feature", "recent", "all", "all")),
	["0:/sessions/feature.jsonl"],
	"branch: limits a token to the branch",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "wt:repo-feature", "recent", "all", "all")),
	["0:/sessions/feature.jsonl"],
	"wt: limits a token to the worktree name or path",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, '"feature discussion"', "recent", "all", "all")),
	["0:/sessions/discussion.jsonl"],
	"quoted phrase matches the message text",
);
assertEqual(
	shown(filterWorktreeSessions(allRows, "re:^feature$", "recent", "all", "branch")),
	["0:/sessions/feature.jsonl"],
	"regex search uses the active field",
);
assertEqual(
	shown(filterWorktreeSessions([row({ path: "/sessions/gone.jsonl", branch: "old", missing: true, firstMessage: "bye" })], "missing", "recent", "all", "all")),
	["0:/sessions/gone.jsonl"],
	"missing worktrees stay searchable",
);
assertEqual(nextScope("current"), "worktrees", "scope cycles from the current folder to all worktrees");
assertEqual(nextScope("worktrees"), "current", "scope cycles back to the current folder");
assertEqual(nextSortMode("threaded"), "recent", "sort cycles from threaded to recent");
assertEqual(nextSortMode("recent"), "relevance", "sort cycles from recent to fuzzy");
assertEqual(nextSortMode("relevance"), "threaded", "sort cycles from fuzzy back to threaded");
assertEqual(nextFieldFilter("all"), "branch", "filter cycles from all fields to branch");
assertEqual(nextFieldFilter("branch"), "worktree", "filter cycles from branch to worktree");
assertEqual(nextFieldFilter("worktree"), "all", "filter cycles from worktree back to all fields");

console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
