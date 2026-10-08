/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import * as fs from "node:fs";
import * as os from "node:os";
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

type RebaseCommand = "rebase" | "tip";
const rebasingWorktrees = new Set<string>();
const operationMarkers = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];

/** Topic worktrees are the selectable operand for both rebase directions and PR delivery. */
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

export async function checkWorktreeReady(
	git: RebaseDependencies["git"],
	target: Worktree,
	options: { allowDirty?: boolean } = {},
): Promise<string> {
	const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], target.path);
	if (head.exitCode !== 0 || head.stdout !== target.branch) throw new Error("Worktree branch changed. Select the worktree again.");
	for (const marker of operationMarkers) {
		if (await hasGitMarker({ git }, target.path, marker)) {
			throw new Error("A rebase, merge, cherry-pick, or revert is already in progress in the target worktree. Finish or abort it first.");
		}
	}
	const status = await git(["status", "--porcelain", "--untracked-files=all"], target.path);
	if (status.exitCode !== 0) throw new Error(status.stderr || "Cannot read worktree status.");
	if (status.stdout && !options.allowDirty) throw new Error("Target worktree has uncommitted or untracked changes. Commit or stash them before rebasing.");
	const original = await git(["rev-parse", "--verify", "HEAD"], target.path);
	if (original.exitCode !== 0) throw new Error(original.stderr || "Cannot read the branch tip.");
	return original.stdout;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function conflictPrompt(
	command: RebaseCommand,
	target: Worktree,
	ontoBranch: string,
	originalHead: string,
	onto: string,
	gitRoot: string,
	temporaryRoot?: string,
): string {
	const git = `git -C ${shellQuote(target.path)}`;
	return [
		`/worktree ${command} stopped on conflicts. Resolve them and finish the rebase now.`,
		`Target worktree WHERE THE REBASE IS PAUSED: ${JSON.stringify(target.path)}`,
		`Branch being rebased: ${JSON.stringify(target.branch)} onto local ${JSON.stringify(ontoBranch)} (${onto}).`,
		`Original branch tip: ${originalHead}.`,
		"This target may differ from the selected topic worktree and your session's working directory. Scope every command and file edit to this absolute target path, and read its applicable AGENTS.md instructions first. Do not modify the branch/worktree being used as the onto source.",
		"Before editing, inspect git status and the rebase metadata (head-name, orig-head, onto) in rebase-merge or rebase-apply. Verify they match the branch and commits above. If the rebase was aborted, finished, or replaced, stop and report rather than starting a new operation.",
		`Use ${git} status, ${git} diff --name-only --diff-filter=U, and ${git} show REBASE_HEAD to understand each conflict.`,
		"Resolve conflicts semantically, preserving the intended changes from both branches. Do not blindly choose ours/theirs. Stage only the files you have resolved, using git add -- <paths> (or git rm -- <paths> for intentional deletions).",
		`Continue with ${git} -c core.editor=true -c rebase.updateRefs=false rebase --continue. Repeat inspection, resolution, staging, and continuation for every conflicted commit until the rebase completes.`,
		"Do not skip commits, abort, reset, stash, change unrelated branches/worktrees, or push without explicit user approval. If a resolution is ambiguous or a non-conflict error prevents continuation, stop and ask the user, leaving the rebase recoverable.",
		"After completion, verify the expected branch is checked out, no rebase or unmerged files remain, and the onto commit is an ancestor of HEAD. Run the relevant project checks and report their results and the final rebase status.",
		...(temporaryRoot ? [
			"This is a temporary checkout of main/master because that branch was not checked out anywhere. Leave it intact while paused or if anything is unresolved.",
			`ONLY after successful completion and a clean worktree, remove the temporary checkout with git -C ${shellQuote(gitRoot)} worktree remove -- ${shellQuote(target.path)}, then rmdir ${shellQuote(temporaryRoot)}. Never use --force and never delete the main/master branch.`,
		] : []),
	].join("\n");
}

/** Replay local main/master onto the selected/current topic's committed tip. */
export async function handleWorktreeRebase(args: string, ctx: RebaseContext, gitRoot: string, deps: RebaseDependencies): Promise<void> {
	await handleDirectionalRebase("rebase", args, ctx, gitRoot, deps);
}

/** Replay the selected/current topic onto local main/master (the original rebase behavior). */
export async function handleWorktreeTip(args: string, ctx: RebaseContext, gitRoot: string, deps: RebaseDependencies): Promise<void> {
	await handleDirectionalRebase("tip", args, ctx, gitRoot, deps);
}

async function handleDirectionalRebase(
	command: RebaseCommand,
	args: string,
	ctx: RebaseContext,
	gitRoot: string,
	deps: RebaseDependencies,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify(`Agent is busy. Run /worktree ${command} after the current turn finishes.`, "warning");
		return;
	}
	const requested = args.trim();
	if (/\s/.test(requested)) {
		ctx.ui.notify(`Usage: /worktree ${command} [branch]`, "error");
		return;
	}

	const current = await deps.git(["symbolic-ref", "--quiet", "--short", "HEAD"], ctx.cwd);
	const worktrees = await deps.getWorktrees(gitRoot);
	let branch = requested;
	if (!branch) {
		if (current.exitCode !== 0 || !current.stdout) {
			ctx.ui.notify(`Detached HEAD. Specify a worktree branch: /worktree ${command} <branch>.`, "error");
			return;
		}
		if (isDefaultBranch(current.stdout)) {
			const topics = worktrees.filter(isRebaseTarget);
			if (!topics.length) {
				ctx.ui.notify("No topic worktrees available.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Specify a worktree branch: /worktree ${command} <branch>.`, "error");
				return;
			}
			const title = command === "rebase" ? "Select worktree to rebase main/master onto:" : "Select worktree to tip onto main/master:";
			const chosen = await ctx.ui.select(title, topics.map((wt) => wt.branch!));
			if (!chosen) return;
			branch = chosen;
		} else {
			branch = current.stdout;
		}
	}

	const topic = worktrees.find((wt) => wt.branch === branch);
	if (!topic || !isRebaseTarget(topic)) {
		ctx.ui.notify(`No eligible topic worktree for branch ${JSON.stringify(branch)}. Select a topic branch, not main/master.`, "error");
		return;
	}
	if (!ctx.isIdle() || rebasingWorktrees.has(topic.path)) {
		ctx.ui.notify("Agent or worktree is busy. Try again after the current operation finishes.", "warning");
		return;
	}

	const locks = [topic.path];
	rebasingWorktrees.add(topic.path);
	let temporaryRoot: string | undefined;
	let temporaryAdded = false;
	let preserveTemporary = false;
	let target: Worktree | undefined;
	try {
		// Prefer the invoking main/master branch; from a topic branch prefer main, then master.
		const candidates = current.exitCode === 0 && isDefaultBranch(current.stdout)
			? [current.stdout, current.stdout === "main" ? "master" : "main"] : ["main", "master"];
		let base = "";
		let baseHead = "";
		for (const candidate of candidates) {
			const result = await deps.git(["rev-parse", "--verify", `refs/heads/${candidate}^{commit}`], topic.path);
			if (result.exitCode === 0) {
				base = candidate;
				baseHead = result.stdout;
				break;
			}
		}
		if (!base) throw new Error("No local main or master branch found. Fetch/update your base branch first.");
		const baseLock = `base:${gitRoot}:${base}`;
		if (rebasingWorktrees.has(baseLock)) throw new Error("main/master is busy with another worktree operation.");
		rebasingWorktrees.add(baseLock);
		locks.push(baseLock);

		let onto = baseHead;
		let ontoBranch = base;
		if (command === "tip") {
			target = topic;
		} else {
			// Only the committed topic tip is used; its working files are not changed or stashed.
			onto = await checkWorktreeReady(deps.git, topic, { allowDirty: true });
			ontoBranch = branch;
			target = worktrees.find((wt) => wt.branch === base);
			if (target && (target.bare || target.prunable)) throw new Error(`The ${base} checkout is unavailable. Repair it before rebasing.`);
			if (!target) {
				temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-rebase-"));
				target = { path: path.join(temporaryRoot, "checkout"), branch: base };
				const added = await deps.git(["worktree", "add", "--", target.path, base], gitRoot);
				if (added.exitCode !== 0) throw new Error(added.stderr || "Cannot create a temporary main/master checkout.");
				temporaryAdded = true;
			}
		}
		const original = await checkWorktreeReady(deps.git, target);
		if (command === "rebase" && original !== baseHead) throw new Error("main/master changed during preparation. Run /worktree rebase again.");
		if (!ctx.isIdle()) throw new Error("Agent became busy. Try again after the current turn finishes.");

		ctx.ui.notify(`Rebasing local ${JSON.stringify(target.branch)} onto local ${JSON.stringify(ontoBranch)} in ${target.path}...`, "info");
		// Pin the onto commit, disable implicit stashing and updates to other branch refs.
		// If execution/state inspection throws, keep any temporary checkout until its state is known.
		preserveTemporary = true;
		const result = await deps.git(["-c", "core.editor=true", "-c", "rebase.updateRefs=false", "rebase", "--no-autostash", onto], target.path);
		if (result.exitCode === 0) {
			preserveTemporary = false;
			ctx.ui.notify(`✓ Rebased ${JSON.stringify(target.branch)} onto local ${ontoBranch}.`, "info");
			return;
		}
		const inRebase = await hasGitMarker(deps, target.path, "rebase-merge") || await hasGitMarker(deps, target.path, "rebase-apply");
		preserveTemporary = inRebase;
		const unmerged = await deps.git(["diff", "--name-only", "--diff-filter=U"], target.path);
		if (inRebase && unmerged.exitCode === 0 && unmerged.stdout) {
			deps.sendUserMessage(conflictPrompt(command, target, ontoBranch, original, onto, gitRoot, temporaryRoot));
			ctx.ui.notify(`Rebase conflicts found in ${target.path}. Pi will resolve them and continue /worktree ${command}.`, "warning");
			return;
		}
		throw new Error(`${result.stderr || result.stdout || "Git rebase failed."}${inRebase ? `\nThe rebase is still paused in ${target.path}; inspect git status before continuing or aborting.` : ""}`);
	} catch (error) {
		ctx.ui.notify(`Failed /worktree ${command}: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		try {
			if (temporaryRoot && target) {
				if (temporaryAdded && !preserveTemporary) {
					for (const marker of operationMarkers) {
						if (await hasGitMarker(deps, target.path, marker)) preserveTemporary = true;
					}
				}
				if (preserveTemporary) {
					ctx.ui.notify(`Temporary main/master checkout retained at ${target.path} while the rebase is paused or its state is uncertain.`, "warning");
				} else {
					const removed = temporaryAdded ? await deps.git(["worktree", "remove", "--", target.path], gitRoot) : { exitCode: 0 };
					if (removed.exitCode === 0) {
						try { fs.rmdirSync(temporaryRoot); }
						catch { ctx.ui.notify(`Temporary directory retained at ${temporaryRoot}; inspect before removing it.`, "warning"); }
					} else {
						ctx.ui.notify(`Could not safely remove temporary checkout ${target.path}; it has been retained.`, "warning");
					}
				}
			}
		} catch (error) {
			ctx.ui.notify(`Temporary checkout retained at ${target?.path}: ${String(error)}`, "warning");
		} finally {
			for (const lock of locks) rebasingWorktrees.delete(lock);
		}
	}
}
