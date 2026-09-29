/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// What `/worktree` does with and without a git checkout.
//   node --experimental-strip-types packages/worktree/test.ts

import { routeWorktreeCommand } from "./route.ts";

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

console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
