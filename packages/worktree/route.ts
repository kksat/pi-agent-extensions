/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { DEFAULT_WORKTREE_ALIASES, resolveWorktreeSubcommand, type SubcommandAliases } from "./aliases.ts";

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
	| { type: "tip"; gitRoot: string; args: string }
	| { type: "pr"; gitRoot: string; args: string }
	| { type: "help" }
	| { type: "create"; gitRoot: string; args: string };

export function routeWorktreeCommand(
	args: string,
	gitRoot: string | null,
	aliases: SubcommandAliases = DEFAULT_WORKTREE_ALIASES.subcommandAliases,
): WorktreeRoute {
	const trimmed = args.trim();
	const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
	const sub = resolveWorktreeSubcommand(parts[0] ?? "", aliases);
	const rest = parts.slice(1).join(" ");

	if (!gitRoot) {
		if (trimmed.length === 0) return { type: "menu", gitRoot: null };
		if (sub === "sessions") return { type: "folder-sessions" };
		if (sub === "help") return { type: "help" };
		return { type: "need-git" };
	}

	if (trimmed.length === 0) return { type: "menu", gitRoot };

	switch (sub) {
		case "create":
			return { type: "create", gitRoot, args: rest };
		case "list":
			return { type: "list", gitRoot };
		case "sessions":
			return { type: "sessions", gitRoot };
		case "clean":
			return { type: "clean", gitRoot };
		case "remove":
			return { type: "remove", gitRoot, args: rest };
		case "rename":
			return { type: "rename", gitRoot, args: rest };
		case "switch":
			return { type: "switch", gitRoot, args: rest };
		case "rebase":
			return { type: "rebase", gitRoot, args: rest };
		case "tip":
			return { type: "tip", gitRoot, args: rest };
		case "pr":
			return { type: "pr", gitRoot, args: rest };
		case "help":
			return { type: "help" };
		default:
			return { type: "create", gitRoot, args: trimmed };
	}
}
