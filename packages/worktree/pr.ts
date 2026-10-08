/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import type { BoundaryResult, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkWorktreeReady, isRebaseTarget, shellQuote, type GitResult, type Worktree } from "./rebase.ts";

type PrContext = Pick<ExtensionCommandContext, "hasUI" | "isIdle"> & {
	ui: Pick<ExtensionCommandContext["ui"], "notify" | "select">;
};

interface PrDependencies {
	run(command: string, args: string[], cwd: string): Promise<GitResult>;
	getWorktrees(gitRoot: string): Promise<Worktree[]>;
	sendUserMessage(prompt: string): void;
	now?: () => number;
	maxContinuations?: number;
}

interface PrJob {
	path: string;
	branch: string;
	originalHead: string;
	remote: string;
	repo: string;
	repoName: string;
	base: string;
	startedAt: number;
	continuations: number;
	prNumber?: number;
}

interface PullRequest {
	number: number;
	url: string;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	headRepository: { name?: string; nameWithOwner?: string } | null;
	headRepositoryOwner?: { login: string } | null;
	state?: string;
	statusCheckRollup?: Array<{ __typename?: string; status?: string; conclusion?: string; state?: string }>;
}

interface Check {
	name: string;
	bucket: string;
	state: string;
	link?: string;
}

interface Verification {
	green: boolean;
	message: string;
}

function headRepositoryName(pr: PullRequest): string | undefined {
	// gh can serialize headRepository.nameWithOwner as an empty string; owner/name are populated separately.
	const owner = pr.headRepositoryOwner?.login;
	const name = pr.headRepository?.name;
	return owner && name ? `${owner}/${name}` : pr.headRepository?.nameWithOwner || undefined;
}

function remoteRepositoryUrl(remote: string): string {
	const scp = remote.match(/^[^/@]+@([^:]+):(.+)$/);
	const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
	if (!["https:", "http:", "ssh:"].includes(url.protocol)) throw new Error("PRs require a GitHub remote URL.");
	const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
	if (parts.length !== 2) throw new Error("Cannot identify the GitHub repository from the remote URL.");
	return `https://${url.hostname}/${parts.join("/")}`;
}

function prPrompt(job: PrJob): string {
	const git = `git -C ${shellQuote(job.path)}`;
	const gh = `gh --repo ${shellQuote(job.repo)}`;
	const remoteRef = `refs/remotes/${job.remote}/${job.base}`;
	return [
		"Run the /worktree pr workflow to completion: remote-base rebase, semantic conflict resolution, PR creation, and green CI on the latest pushed commit.",
		`Selected worktree: ${JSON.stringify(job.path)}; topic branch: ${JSON.stringify(job.branch)}; original tip: ${job.originalHead}.`,
		`GitHub repository: ${JSON.stringify(job.repo)}; Git remote: ${JSON.stringify(job.remote)}; PR base: ${JSON.stringify(job.base)}.`,
		"Scope ALL Git, gh, checks, and file edits to this worktree. Read applicable AGENTS.md instructions and GLOSSARY.md first. Do not touch other worktrees or rewrite local/remote main/master. Verify the selected branch and original tip before the first mutation; stop if someone changed them.",
		"1. Confirm gh authentication and repository access. Check for an existing OPEN PR for exactly this repository and head branch; reuse it rather than creating a duplicate. Do not silently retarget a PR or push to a different repository/fork.",
		`2. Capture the remote topic branch OID before rebasing using ${git} ls-remote --heads ${shellQuote(job.remote)} ${shellQuote(`refs/heads/${job.branch}`)}. If it exists, ensure it is an ancestor of the original local tip; stop for divergent remote work. Keep this exact OID as the push lease (empty if the branch did not exist).`,
		`3. Fetch the actual remote base: ${git} fetch --no-tags ${shellQuote(job.remote)} ${shellQuote(`+refs/heads/${job.base}:${remoteRef}`)}. Resolve ${shellQuote(remoteRef)} to a commit OID, then rebase the topic branch onto that fetched OID using git -c core.editor=true -c rebase.updateRefs=false rebase --no-autostash <OID>. This is a REMOTE-base rebase, not /worktree tip's local-base behavior. Do not switch or advance local main/master.`,
		`4. Resolve EVERY conflicted commit semantically: inspect status, unmerged paths, REBASE_HEAD and the base changes; preserve both sides' intended behavior rather than blindly taking ours/theirs. Stage only resolved paths, then ${git} -c core.editor=true -c rebase.updateRefs=false rebase --continue. Repeat until no rebase/unmerged files remain. Never skip commits, reset, autostash, or abort to hide problems.`,
		"5. Run relevant project tests, lint, and type checks. Fix problems caused by this branch and commit only those fixes. Confirm the fetched base is an ancestor of HEAD and the worktree is clean. If there are no changes relative to the base, call worktree_pr_pause with that reason and report it instead of creating an empty PR.",
		"6. BEFORE writing the PR body, use the pr skill requested as /skills:pr by the user (Pi spelling: /skill:pr). Resolve the available named pr skill, read its complete SKILL.md with the read tool, and follow all its instructions. If unavailable, pause and ask for it. Use its Summary, Evidence (real Before/After), and Merge Danger structure; never invent evidence. Write the body to a temporary file OUTSIDE the repository, not an untracked worktree file.",
		`7. Push ONLY this topic branch to ${JSON.stringify(job.remote)} with an explicit HEAD:refs/heads/<topic> refspec. A rebased published branch may be rewritten ONLY with --force-with-lease=refs/heads/<topic>:<captured-remote-OID> (use an empty expected OID for a previously absent branch). Never use --force, a broad push, or refresh the lease to bypass concurrent changes. If the lease fails, stop and ask the user. This lease applies to the INITIAL rewritten-branch publish; subsequent CI-repair commits must use a normal explicit fast-forward push, not the now-stale original lease.`,
		`8. Create the PR with ${gh} pr create --base ${shellQuote(job.base)} --head ${shellQuote(job.branch)} --title <title> --body-file <temporary-body-file>. For a matching existing open PR, update its body with gh pr edit instead. Keep it open; do not merge it or enable auto-merge.`,
		`9. Wait for ALL reported CI checks AND required checks on this PR: use ${gh} pr checks <number> --watch --fail-fast --interval 10, then inspect --json name,bucket,state,link (also with --required). If checks have not appeared yet, wait and retry; an empty check list is NOT green. Inspect failed run logs (gh run view --log-failed or the external CI links), fix the underlying branch code, commit, push, and watch the NEW head's checks again.`,
		"Do not disable checks, weaken tests, bypass required checks, mark failures successful, or repeatedly rerun deterministic failures to fake green CI. Skipped/neutral checks are acceptable only alongside at least one passing check; cancelled, pending, unknown, and failed checks are not green.",
		"10. Re-read the PR and verify its head OID equals the selected worktree's clean HEAD and that its base/head repository/branch match the values above. Report the PR URL, final commit SHA, local verification results, and CI check names/links only after green CI is verified. Update the PR body with any additional fixes and real evidence.",
		"If conflict intent is ambiguous, credentials/secrets/permissions are missing, external CI is inaccessible, or a safe repair is impossible, call worktree_pr_pause with a concrete reason, then report the blocker and any PR URL. Do not claim success. Escape or session changes also pause this workflow. The extension independently verifies CI before settlement and will request continuation when unfinished; automatic verification is bounded to avoid an endless loop.",
	].join("\n");
}

/** Pi performs the edits/push/PR; this controller independently gates completion on GitHub's latest-head checks. */
export class WorktreePrWorkflow {
	private active: PrJob | undefined;
	private preparing = false;
	private generation = 0;
	private deps: PrDependencies;

	constructor(deps: PrDependencies) {
		this.deps = deps;
	}

	get isActive(): boolean {
		return this.preparing || Boolean(this.active);
	}

	reset(): void {
		this.generation++;
		this.active = undefined;
		this.preparing = false;
	}

	pause(reason: string): string {
		if (!this.active) throw new Error("No /worktree pr workflow is active.");
		const message = `PR workflow paused, NOT verified green: ${reason}. Worktree: ${this.active.path}`;
		this.reset();
		return message;
	}

	private async run(command: string, args: string[], cwd: string): Promise<GitResult> {
		return this.deps.run(command, args, cwd);
	}

	private async checked(command: string, args: string[], cwd: string): Promise<string> {
		const result = await this.run(command, args, cwd);
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `${command} failed.`);
		return result.stdout;
	}

	async start(args: string, ctx: PrContext, gitRoot: string): Promise<void> {
		if (!ctx.isIdle() || this.isActive) {
			ctx.ui.notify("Agent or PR workflow is busy. Finish or pause it before running /worktree pr.", "warning");
			return;
		}
		let branch = args.trim();
		if (/\s/.test(branch)) {
			ctx.ui.notify("Usage: /worktree pr [branch]", "error");
			return;
		}
		const generation = this.generation;
		this.preparing = true;
		try {
			const targets = (await this.deps.getWorktrees(gitRoot)).filter(isRebaseTarget);
			if (!branch) {
				if (!targets.length) throw new Error("No topic worktrees available for a PR.");
				if (!ctx.hasUI) throw new Error("Specify a worktree branch: /worktree pr <branch>.");
				branch = await ctx.ui.select("Select worktree to create a PR from:", targets.map((wt) => wt.branch!)) ?? "";
				if (!branch) return;
			}
			const target = targets.find((wt) => wt.branch === branch);
			if (!target) throw new Error(`No eligible topic worktree for ${JSON.stringify(branch)}. main/master and detached worktrees are excluded.`);
			const git = (gitArgs: string[], cwd: string) => this.run("git", gitArgs, cwd);
			const originalHead = await checkWorktreeReady(git, target);
			const remotes = (await this.checked("git", ["remote"], target.path)).split("\n").filter(Boolean);
			const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
			if (!remote) throw new Error("Use an origin remote or a single unambiguous GitHub remote.");
			const remoteUrl = remoteRepositoryUrl(await this.checked("git", ["remote", "get-url", remote], target.path));
			await this.checked("gh", ["auth", "status", "--hostname", new URL(remoteUrl).hostname], target.path);
			const repo = JSON.parse(await this.checked("gh", ["repo", "view", remoteUrl, "--json", "url,nameWithOwner,defaultBranchRef"], target.path));
			if (typeof repo.url !== "string" || typeof repo.nameWithOwner !== "string") throw new Error("Invalid GitHub repository metadata.");
			const heads = await this.checked("git", ["ls-remote", "--heads", remote, "refs/heads/main", "refs/heads/master"], target.path);
			const available = heads.split("\n").map((line) => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, ""));
			const preferred = repo.defaultBranchRef?.name;
			const base = available.includes(preferred) && ["main", "master"].includes(preferred)
				? preferred : available.includes("main") ? "main" : available.includes("master") ? "master" : undefined;
			if (!base) throw new Error("The selected remote has no main or master branch.");
			if (generation !== this.generation) return;
			if (!ctx.isIdle()) throw new Error("Agent became busy. Run /worktree pr after the current turn finishes.");
			if (await checkWorktreeReady(git, target) !== originalHead) throw new Error("Worktree tip changed during PR preparation. Try again.");
			if (generation !== this.generation) return;
			if (!ctx.isIdle()) throw new Error("Agent became busy. Run /worktree pr after the current turn finishes.");
			const job: PrJob = {
				path: target.path, branch, originalHead, remote,
				repo: repo.url, repoName: repo.nameWithOwner, base,
				startedAt: (this.deps.now ?? Date.now)(), continuations: 0,
			};
			this.active = job;
			try { this.deps.sendUserMessage(prPrompt(job)); }
			catch (error) { this.active = undefined; throw error; }
			ctx.ui.notify(`Pi will rebase ${JSON.stringify(branch)} onto ${remote}/${base}, create its PR using /skill:pr, and verify green CI.`, "info");
		} catch (error) {
			if (generation !== this.generation) return;
			ctx.ui.notify(`Cannot start PR workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (generation === this.generation) this.preparing = false;
		}
	}

	private async checks(job: PrJob, number: number, required: boolean): Promise<Check[]> {
		const result = await this.run("gh", ["pr", "checks", String(number), "--repo", job.repo, "--json", "name,bucket,state,link", ...(required ? ["--required"] : [])], job.path);
		if (!result.stdout && /no checks reported/i.test(result.stderr)) return [];
		if (![0, 1, 8].includes(result.exitCode)) throw new Error(result.stderr || "Cannot read CI checks.");
		const checks = JSON.parse(result.stdout);
		if (!Array.isArray(checks) || checks.some((check) => !check || typeof check.name !== "string" || typeof check.bucket !== "string" || typeof check.state !== "string")) throw new Error("Invalid CI response.");
		return checks;
	}

	private async verify(job: PrJob): Promise<Verification> {
		const git = (args: string[], cwd: string) => this.run("git", args, cwd);
		let head: string;
		try { head = await checkWorktreeReady(git, job); }
		catch (error) { return { green: false, message: `Finish the rebase/repairs and leave the selected branch clean: ${String(error)}` }; }
		const list = JSON.parse(await this.checked("gh", ["pr", "list", "--repo", job.repo, "--state", "open", "--head", job.branch, "--json", "number,url,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner"], job.path));
		if (!Array.isArray(list)) throw new Error("Invalid PR list response.");
		const matches: PullRequest[] = list.filter((pr) => pr.headRefName === job.branch && headRepositoryName(pr)?.toLowerCase() === job.repoName.toLowerCase());
		if (matches.length > 1) throw new Error("Multiple matching PRs; select the correct PR manually.");
		const pr = matches[0];
		if (!pr && job.prNumber) throw new Error(`Previously observed PR #${job.prNumber} is no longer open/matching. Ask the user before creating or reopening another PR.`);
		if (!pr) return { green: false, message: "No matching open PR exists yet. Create it using /skill:pr; do not create a duplicate or use a different fork." };
		if (job.prNumber && job.prNumber !== pr.number) throw new Error("The matching PR changed during the workflow. Ask the user before proceeding.");
		job.prNumber = pr.number;
		if (pr.baseRefName !== job.base) throw new Error(`Existing PR ${pr.url} targets ${pr.baseRefName}, not ${job.base}; ask the user before retargeting.`);
		if (pr.headRefOid !== head) return { green: false, message: `PR ${pr.url} head ${pr.headRefOid} is not local HEAD ${head}. Safely push the selected topic branch; old-commit checks do not count.` };
		const ancestor = await git(["merge-base", "--is-ancestor", `refs/remotes/${job.remote}/${job.base}`, head], job.path);
		if (ancestor.exitCode !== 0) return { green: false, message: "The fetched remote base is not an ancestor of HEAD (or has not been fetched). Finish the remote-base rebase before declaring success." };
		const all = await this.checks(job, pr.number, false);
		const required = await this.checks(job, pr.number, true);
		const combined = [...all, ...required];
		if (!all.length) return { green: false, message: `PR ${pr.url} has no CI checks yet. Wait for checks to register; empty CI is not green.` };
		const unfinished = combined.filter((check) => !["pass", "skipping"].includes(check.bucket));
		if (unfinished.length) return { green: false, message: `CI is not green for ${pr.url} at ${head}: ${unfinished.map((check) => `${check.name}: ${check.bucket} (${check.state}) ${check.link ?? ""}`).join("; ")}. Wait for pending checks; inspect failed logs, repair the code, commit, push, and recheck the new head.` };
		if (!all.some((check) => check.bucket === "pass")) return { green: false, message: `PR ${pr.url} has no passing CI evidence; entirely skipped/neutral CI is not green. Investigate why no tests ran.` };
		// Checks and head can change while the API calls are in flight: re-read both before success.
		const latest: PullRequest = JSON.parse(await this.checked("gh", ["pr", "view", String(pr.number), "--repo", job.repo, "--json", "state,headRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,statusCheckRollup"], job.path));
		if (latest.state !== "OPEN") throw new Error(`PR ${pr.url} was closed or merged during verification. Do not reopen it or create another PR without user approval.`);
		if (latest.headRefOid !== head || latest.headRefName !== job.branch || latest.baseRefName !== job.base || headRepositoryName(latest)?.toLowerCase() !== job.repoName.toLowerCase() || await checkWorktreeReady(git, job) !== head) {
			return { green: false, message: "PR/worktree changed during CI verification. Recheck the current open PR and latest pushed commit; do not report stale success." };
		}
		const rollup = latest.statusCheckRollup;
		const passing = (check: NonNullable<PullRequest["statusCheckRollup"]>[number]) =>
			check?.__typename === "CheckRun" ? check.status === "COMPLETED" && check.conclusion === "SUCCESS"
				: check?.__typename === "StatusContext" && check.state === "SUCCESS";
		const acceptable = (check: NonNullable<PullRequest["statusCheckRollup"]>[number]) => passing(check) ||
			check?.__typename === "CheckRun" && check.status === "COMPLETED" && ["SKIPPED", "NEUTRAL"].includes(check.conclusion ?? "");
		if (!Array.isArray(rollup) || !rollup.length || !rollup.some(passing) || !rollup.every(acceptable)) {
			return { green: false, message: `The latest GitHub check rollup for ${pr.url} is absent or not green (a run may have restarted). Watch and recheck the current head; earlier passing snapshots are insufficient.` };
		}
		return { green: true, message: `✓ PR ${pr.url}: CI verified green for ${head}. Checks: ${all.map((check) => `${check.name} (${check.bucket}) ${check.link ?? ""}`).join("; ")}` };
	}

	async beforeSettle(outcome: "completed" | "aborted" | "error", alreadyContinuing = false): Promise<BoundaryResult | undefined> {
		const job = this.active;
		if (!job) return;
		if (outcome !== "completed") {
			this.reset();
			return this.result(`PR workflow paused (${outcome}); CI is NOT verified green. Any rebase/PR is left intact. Finish or abort a paused rebase before rerunning /worktree pr to reuse the PR.`, false);
		}
		if (alreadyContinuing) return;
		let verification: Verification;
		try { verification = await this.verify(job); }
		catch (error) {
			if (this.active !== job) return;
			this.reset();
			return this.result(`PR workflow blocked; CI is NOT verified green: ${String(error)}. Resolve access/configuration issues and rerun /worktree pr.`, false);
		}
		if (this.active !== job) return;
		if (verification.green) {
			this.reset();
			return this.result(verification.message, false);
		}
		if (job.continuations >= (this.deps.maxContinuations ?? 12) || (this.deps.now ?? Date.now)() - job.startedAt >= 30 * 60 * 1000) {
			this.reset();
			return this.result(`PR workflow paused at its automatic verification limit; CI is NOT green. ${verification.message} Resolve the blocker and rerun /worktree pr.`, false);
		}
		job.continuations++;
		return this.result(`Continue /worktree pr in ${JSON.stringify(job.path)} for branch ${JSON.stringify(job.branch)}; it is NOT complete. ${verification.message}\nWait at least 10 seconds before checking again if CI is pending or not yet registered. Use /skill:pr for the body. Fix failures without disabling checks; push only the topic branch. Use the captured lease only for the initial rewritten-topic publish; use normal explicit fast-forward pushes for subsequent CI-repair commits. If blocked or ambiguous, call worktree_pr_pause with a concrete reason and report the blocker rather than claiming green CI.`, true);
	}

	private result(content: string, continueRun: boolean): BoundaryResult {
		return { entries: [{ type: "custom_message", customType: "worktree-pr-verification", content, display: true }], continue: continueRun };
	}
}
