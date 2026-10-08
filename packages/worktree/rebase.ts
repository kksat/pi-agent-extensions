/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface Worktree {
	path: string;
	branch?: string;
	bare?: boolean;
	prunable?: boolean;
}

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface RebaseDependencies {
	git(args: string[], cwd: string): Promise<GitResult>;
	getWorktrees(gitRoot: string): Promise<Worktree[]>;
	sendUserMessage(prompt: string): void;
}

type RebaseContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "isIdle"> & {
	ui: Pick<ExtensionCommandContext["ui"], "notify" | "select">;
};

const rebasingWorktrees = new Set<string>();
const operationMarkers = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];

export function isRebaseTarget(worktree: Worktree): boolean {
	return Boolean(worktree.branch && !isDefaultBranch(worktree.branch) && !worktree.bare && !worktree.prunable);
}

function isDefaultBranch(branch: string): boolean {
	return branch === "main" || branch === "master";
}

async function hasGitMarker(deps: Pick<RebaseDependencies, "git">, cwd: string, marker: string): Promise<boolean> {
	const result = await deps.git(["rev-parse", "--git-path", marker], cwd);
	if (result.exitCode !== 0) throw new Error(result.stderr || "Cannot inspect worktree Git state.");
	return fs.existsSync(path.resolve(cwd, result.stdout));
}

export async function checkWorktreeReady(git: RebaseDependencies["git"], target: Worktree): Promise<string> {
	const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], target.path);
	if (head.exitCode !== 0 || head.stdout !== target.branch) throw new Error("Worktree branch changed. Select the worktree again.");
	for (const marker of operationMarkers) {
		if (await hasGitMarker({ git }, target.path, marker)) {
			throw new Error("A rebase, merge, cherry-pick, or revert is already in progress in the target worktree. Finish or abort it first.");
		}
	}
	const status = await git(["status", "--porcelain", "--untracked-files=all"], target.path);
	if (status.exitCode !== 0) throw new Error(status.stderr || "Cannot read worktree status.");
	if (status.stdout) throw new Error("Target worktree has uncommitted or untracked changes. Commit or stash them before rebasing.");
	const original = await git(["rev-parse", "--verify", "HEAD"], target.path);
	if (original.exitCode !== 0) throw new Error(original.stderr || "Cannot read the branch tip.");
	return original.stdout;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function conflictPrompt(target: Worktree, base: string, originalHead: string, onto: string): string {
	const git = `git -C ${shellQuote(target.path)}`;
	return [
		"/worktree rebase stopped on conflicts. Resolve them and finish the rebase now.",
		`Target worktree: ${JSON.stringify(target.path)}`,
		`Branch being rebased: ${JSON.stringify(target.branch)} onto local ${JSON.stringify(base)} (${onto}).`,
		`Original branch tip: ${originalHead}.`,
		"This is the selected worktree, which may differ from your session's working directory. Scope every command and file edit to this absolute path, and read its applicable AGENTS.md instructions first.",
		"Before editing, inspect git status and the rebase metadata (head-name, orig-head, onto) in rebase-merge or rebase-apply. Verify they match the branch and commits above. If the rebase was aborted, finished, or replaced, stop and report rather than starting a new operation.",
		`Use ${git} status, ${git} diff --name-only --diff-filter=U, and ${git} show REBASE_HEAD to understand each conflict.`,
		"Resolve conflicts semantically, preserving the intended changes from both the worktree branch and the base. Do not blindly choose ours/theirs. Stage only the files you have resolved, using git add -- <paths> (or git rm -- <paths> for intentional deletions).",
		`Continue with ${git} -c core.editor=true -c rebase.updateRefs=false rebase --continue. Repeat inspection, resolution, staging, and continuation for every conflicted commit until the rebase completes.`,
		"Do not skip commits, abort, reset, stash, change unrelated branches/worktrees, or push without explicit user approval. If a resolution is ambiguous or a non-conflict error prevents continuation, stop and ask the user, leaving the rebase recoverable.",
		"After completion, verify the expected branch is checked out, no rebase or unmerged files remain, and the base commit is an ancestor of HEAD. Run the relevant project checks and report their results and the final rebase status.",
	].join("\n");
}

/** Rebase only the topic worktree; main/master and other worktrees are never checked out or rewritten. */
export async function handleWorktreeRebase(
	args: string,
	ctx: RebaseContext,
	gitRoot: string,
	deps: RebaseDependencies,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Agent is busy. Run /worktree rebase after the current turn finishes.", "warning");
		return;
	}
	const requested = args.trim();
	if (/\s/.test(requested)) {
		ctx.ui.notify("Usage: /worktree rebase [branch]", "error");
		return;
	}

	const current = await deps.git(["symbolic-ref", "--quiet", "--short", "HEAD"], ctx.cwd);
	const worktrees = await deps.getWorktrees(gitRoot);
	let branch = requested;
	if (!branch) {
		if (current.exitCode !== 0 || !current.stdout) {
			ctx.ui.notify("Detached HEAD. Specify a worktree branch: /worktree rebase <branch>.", "error");
			return;
		}
		if (isDefaultBranch(current.stdout)) {
			const targets = worktrees.filter(isRebaseTarget);
			if (targets.length === 0) {
				ctx.ui.notify("No topic worktrees available to rebase.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Specify a worktree branch: /worktree rebase <branch>.", "error");
				return;
			}
			const chosen = await ctx.ui.select("Select worktree to rebase onto main/master:", targets.map((wt) => wt.branch!));
			if (!chosen) return;
			branch = chosen;
		} else {
			branch = current.stdout;
		}
	}

	const target = worktrees.find((wt) => wt.branch === branch);
	if (!target || !isRebaseTarget(target)) {
		ctx.ui.notify(`No eligible topic worktree for branch ${JSON.stringify(branch)}. main/master cannot be rebased by this command.`, "error");
		return;
	}
	if (!ctx.isIdle() || rebasingWorktrees.has(target.path)) {
		ctx.ui.notify("Agent or worktree is busy. Try again after the current operation finishes.", "warning");
		return;
	}

	rebasingWorktrees.add(target.path);
	try {
		// Prefer the invoking main/master branch; from a topic branch prefer main, then master.
		const bases = current.exitCode === 0 && isDefaultBranch(current.stdout)
			? [current.stdout, current.stdout === "main" ? "master" : "main"]
			: ["main", "master"];
		let base = "";
		let onto = "";
		for (const candidate of bases) {
			const result = await deps.git(["rev-parse", "--verify", `refs/heads/${candidate}^{commit}`], target.path);
			if (result.exitCode === 0) {
				base = candidate;
				onto = result.stdout;
				break;
			}
		}
		if (!base) throw new Error("No local main or master branch found. Fetch/update your base branch first.");

		const original = await checkWorktreeReady(deps.git, target);

		ctx.ui.notify(`Rebasing ${JSON.stringify(branch)} onto local ${base} in ${target.path}...`, "info");
		// Pin the base commit, disable implicit stashing and updates to other branch refs.
		const result = await deps.git(["-c", "core.editor=true", "-c", "rebase.updateRefs=false", "rebase", "--no-autostash", onto], target.path);
		if (result.exitCode === 0) {
			ctx.ui.notify(`✓ Rebased ${JSON.stringify(branch)} onto local ${base}.`, "info");
			return;
		}
		const inRebase = await hasGitMarker(deps, target.path, "rebase-merge") || await hasGitMarker(deps, target.path, "rebase-apply");
		const unmerged = await deps.git(["diff", "--name-only", "--diff-filter=U"], target.path);
		if (inRebase && unmerged.exitCode === 0 && unmerged.stdout) {
			deps.sendUserMessage(conflictPrompt(target, base, original, onto));
			ctx.ui.notify("Rebase conflicts found. Pi will resolve them and continue the rebase.", "warning");
			return;
		}
		throw new Error(`${result.stderr || result.stdout || "Git rebase failed."}${inRebase ? "\nThe rebase is still paused; inspect git status in the target worktree before continuing or aborting." : ""}`);
	} catch (error) {
		ctx.ui.notify(`Failed to rebase worktree: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		rebasingWorktrees.delete(target.path);
	}
}
