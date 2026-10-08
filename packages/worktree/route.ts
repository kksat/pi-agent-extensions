/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Decides what `/worktree` does before any git or session work.
 * Commands that must work outside a repository are listed here, not as
 * exceptions after a blanket "not a git repo" return.
 */

export type WorktreeRoute =
	| { type: "folder-sessions" }
	| { type: "need-git" }
	| { type: "menu"; gitRoot: string | null }
	| { type: "list"; gitRoot: string }
	| { type: "sessions"; gitRoot: string }
	| { type: "clean"; gitRoot: string }
	| { type: "remove"; gitRoot: string; args: string }
	| { type: "rename"; gitRoot: string; args: string }
	| { type: "switch"; gitRoot: string; args: string }
	| { type: "rebase"; gitRoot: string; args: string }
	| { type: "pr"; gitRoot: string; args: string }
	| { type: "help" }
	| { type: "create"; gitRoot: string; args: string };

const SESSION_SUBCOMMANDS = new Set(["sessions", "session"]);

export function routeWorktreeCommand(args: string, gitRoot: string | null): WorktreeRoute {
	const trimmed = args.trim();
	const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
	const sub = (parts[0] ?? "").toLowerCase();
	const rest = parts.slice(1).join(" ");

	if (!gitRoot) {
		if (trimmed.length === 0) return { type: "menu", gitRoot: null };
		if (SESSION_SUBCOMMANDS.has(sub)) return { type: "folder-sessions" };
		if (sub === "help" || sub === "--help" || sub === "-h") return { type: "help" };
		return { type: "need-git" };
	}

	if (trimmed.length === 0) return { type: "menu", gitRoot };

	switch (sub) {
		case "create":
		case "add":
		case "new":
			return { type: "create", gitRoot, args: rest };
		case "list":
		case "ls":
			return { type: "list", gitRoot };
		case "sessions":
		case "session":
			return { type: "sessions", gitRoot };
		case "clean":
		case "cleanup":
		case "prune":
			return { type: "clean", gitRoot };
		case "remove":
		case "rm":
		case "del":
		case "delete":
			return { type: "remove", gitRoot, args: rest };
		case "rename":
		case "mv":
			return { type: "rename", gitRoot, args: rest };
		case "switch":
		case "attach":
		case "go":
			return { type: "switch", gitRoot, args: rest };
		case "rebase":
			return { type: "rebase", gitRoot, args: rest };
		case "pr":
			return { type: "pr", gitRoot, args: rest };
		case "help":
		case "--help":
		case "-h":
			return { type: "help" };
		default:
			return { type: "create", gitRoot, args: trimmed };
	}
}
