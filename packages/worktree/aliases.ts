/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKTREE_SUBCOMMANDS = ["create", "list", "sessions", "clean", "remove", "rename", "switch", "rebase", "tip", "pr", "help"] as const;
export type WorktreeSubcommand = typeof WORKTREE_SUBCOMMANDS[number];
export type CommandAliasTarget = "worktree" | WorktreeSubcommand;
export type SubcommandAliases = Readonly<Record<string, WorktreeSubcommand>>;

export interface WorktreeAliases {
	commandAliases: Readonly<Record<string, CommandAliasTarget>>;
	subcommandAliases: SubcommandAliases;
}

export const DEFAULT_WORKTREE_ALIASES: WorktreeAliases = {
	commandAliases: {
		wt: "worktree",
		worktrees: "list",
		"worktree-clean": "clean",
		"worktree-remove": "remove",
		"worktree-rename": "rename",
	},
	subcommandAliases: {
		l: "list", ls: "list",
		add: "create", new: "create",
		session: "sessions",
		cleanup: "clean", prune: "clean",
		rm: "remove", del: "remove", delete: "remove",
		mv: "rename",
		attach: "switch", go: "switch",
		"--help": "help", "-h": "help",
	},
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge per-name overrides; null disables an alias. Canonical commands cannot be shadowed. */
export function parseWorktreeAliases(value: unknown): WorktreeAliases {
	if (!isObject(value)) throw new Error("Expected a JSON object.");
	const config = value;
	const allowedFields = new Set(["commandAliases", "subcommandAliases"]);
	for (const field of Object.keys(value)) {
		if (!allowedFields.has(field)) throw new Error(`Unknown option "${field}".`);
	}
	function merge<T extends CommandAliasTarget>(field: string, defaults: Readonly<Record<string, T>>, targets: readonly T[]): Record<string, T> {
		const result = { ...defaults };
		if (!Object.hasOwn(config, field)) return result;
		const overrides = config[field];
		if (!isObject(overrides)) throw new Error(`"${field}" must map alias names to canonical targets or null.`);
		for (const [alias, target] of Object.entries(overrides)) {
			const validName = field === "commandAliases" ? /^[a-z][a-z0-9-]*$/ : /^(?:-{1,2})?[a-z][a-z0-9-]*$/;
			if (!validName.test(alias)) throw new Error(`Invalid alias name "${alias}" in ${field}; use a lowercase name without a slash or spaces.`);
			if (alias === "worktree" || (field === "subcommandAliases" && WORKTREE_SUBCOMMANDS.includes(alias as WorktreeSubcommand))) {
				throw new Error(`Canonical command "${alias}" cannot be overridden.`);
			}
			if (target === null) delete result[alias];
			else if (typeof target === "string" && targets.includes(target as T)) result[alias] = target as T;
			else throw new Error(`Invalid target for "${alias}" in ${field}; choose ${targets.join(", ")} or null.`);
		}
		return result;
	}
	return {
		commandAliases: merge("commandAliases", DEFAULT_WORKTREE_ALIASES.commandAliases, ["worktree", ...WORKTREE_SUBCOMMANDS]),
		subcommandAliases: merge("subcommandAliases", DEFAULT_WORKTREE_ALIASES.subcommandAliases, WORKTREE_SUBCOMMANDS),
	};
}

/** Load once per extension runtime; /reload applies changes, including command registrations. */
export function loadWorktreeAliases(agentDir: string): WorktreeAliases {
	const file = join(agentDir, "worktree.json");
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseWorktreeAliases({});
		throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseWorktreeAliases(JSON.parse(text.replace(/^\uFEFF/, "")));
	} catch (error) {
		// Do not silently activate defaults or branch creation after an invalid alias configuration.
		throw new Error(`Invalid worktree alias configuration in ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function resolveWorktreeSubcommand(name: string, aliases: SubcommandAliases): string {
	const lower = name.toLowerCase();
	return Object.hasOwn(aliases, lower) ? aliases[lower] : lower;
}

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

/** Aliases use exactly the canonical handler, with optional subcommand prefixing. */
export function registerWorktreeCommands(
	pi: Pick<ExtensionAPI, "registerCommand">,
	command: CommandOptions,
	aliases: WorktreeAliases["commandAliases"],
): void {
	pi.registerCommand("worktree", command);
	for (const [name, target] of Object.entries(aliases)) {
		if (target === "worktree") {
			pi.registerCommand(name, { ...command, description: "Alias for /worktree" });
		} else {
			pi.registerCommand(name, {
				description: `Alias for /worktree ${target}`,
				handler: (args, ctx) => command.handler(`${target} ${args}`, ctx),
				getArgumentCompletions: async (prefix) => {
					const items = await command.getArgumentCompletions?.(`${target} ${prefix}`);
					return items?.map((item) => ({ ...item, value: item.value.replace(new RegExp(`^${target}\\s+`), "") })) ?? null;
				},
			});
		}
	}
}
