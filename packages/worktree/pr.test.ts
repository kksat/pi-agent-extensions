/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Real local Git worktrees, scripted GitHub CLI/API responses; no PRs or network writes.
//   node --experimental-strip-types packages/worktree/pr.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { BoundaryResult } from "@earendil-works/pi-coding-agent";
import { WorktreePrWorkflow } from "./pr.ts";

interface Check { name: string; bucket: string; state: string; link?: string }
interface Pr {
	number: number; url: string; headRefName: string; headRefOid: string; baseRefName: string;
	headRepository: { nameWithOwner: string; name?: string }; state: string;
	headRepositoryOwner?: { login: string };
	statusCheckRollup: Array<{ __typename: string; status?: string; conclusion?: string; state?: string }>;
}

function message(result: BoundaryResult | undefined): string {
	const entry = result?.entries?.find((entry) => entry.type === "custom_message");
	return entry?.type === "custom_message" && typeof entry.content === "string" ? entry.content : "";
}

function fixture(t: TestContext, options: {
	base?: string; defaultBase?: string; remote?: string; remoteUrl?: string; maxContinuations?: number;
} = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-pr-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const main = path.join(root, "repo");
	const feature = path.join(root, "topic worktree's path");
	fs.mkdirSync(main);
	const base = options.base ?? "main";
	const remote = options.remote ?? "origin";
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	function runGit(args: string[], cwd = main) {
		const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
		return { stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? result.error?.message ?? "").trim(), exitCode: result.status ?? 1 };
	}
	function git(args: string[], cwd = main) {
		const result = runGit(args, cwd);
		assert.equal(result.exitCode, 0, result.stderr);
		return result.stdout;
	}
	function commit(filename: string, content = "topic\n") {
		fs.writeFileSync(path.join(feature, filename), content);
		git(["add", "--", filename], feature);
		git(["commit", "-m", `Update ${filename}`], feature);
		return git(["rev-parse", "HEAD"], feature);
	}
	git(["init", `--initial-branch=${base}`]);
	git(["config", "user.name", "PR Test"]);
	git(["config", "user.email", "pr@example.test"]);
	git(["config", "commit.gpgsign", "false"]);
	git(["config", "core.hooksPath", path.join(root, "no-hooks")]);
	fs.writeFileSync(path.join(main, "base.txt"), "base\n");
	git(["add", "base.txt"]);
	git(["commit", "-m", "base"]);
	const baseSha = git(["rev-parse", "HEAD"]);
	git(["worktree", "add", "-b", "feature", feature]);
	const head = commit("topic.txt");
	git(["remote", "add", remote, options.remoteUrl ?? "https://github.com/example/repo.git"]);
	// Simulate the tracking ref Pi will update by fetching; local base and remote ref stay separate.
	git(["update-ref", `refs/remotes/${remote}/${base}`, baseSha]);
	const pr: Pr = {
		number: 42, url: "https://github.com/example/repo/pull/42", headRefName: "feature", headRefOid: head,
		baseRefName: base, headRepository: { nameWithOwner: "example/repo" }, state: "OPEN",
		statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
	};
	const state = {
		list: [] as Pr[],
		all: [{ name: "test", bucket: "pass", state: "SUCCESS", link: "https://ci.example/test/1" }] as Check[],
		required: [] as Check[],
		latest: pr,
		authError: "",
		checksError: "",
		checksCode: 0,
		checksRaw: undefined as string | undefined,
		headRefs: `${baseSha}\trefs/heads/${base}`,
		afterChecks: undefined as (() => void) | undefined,
		afterRepo: undefined as (() => void) | undefined,
		afterHead: undefined as (() => void) | undefined,
	};
	const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
	const prompts: string[] = [];
	const notices: Array<{ text: string; level?: string }> = [];
	const selections: string[][] = [];
	let now = 0;
	const workflow = new WorktreePrWorkflow({
		run: async (command, args, cwd) => {
			commands.push({ command, args, cwd });
			if (command === "git") {
				if (args[0] === "ls-remote") return { stdout: state.headRefs, stderr: "", exitCode: 0 };
				const result = runGit(args, cwd);
				if (args.join(" ") === "rev-parse --verify HEAD") state.afterHead?.();
				return result;
			}
			assert.equal(command, "gh");
			if (args[0] === "auth") return { stdout: "", stderr: state.authError, exitCode: state.authError ? 1 : 0 };
			if (args[0] === "repo") {
				state.afterRepo?.();
				return { stdout: JSON.stringify({ url: "https://github.com/example/repo", nameWithOwner: "example/repo", defaultBranchRef: { name: options.defaultBase ?? base } }), stderr: "", exitCode: 0 };
			}
			if (args[1] === "list") return { stdout: JSON.stringify(state.list), stderr: "", exitCode: 0 };
			if (args[1] === "view") return { stdout: JSON.stringify(state.latest), stderr: "", exitCode: 0 };
			if (args[1] === "checks") {
				const checks = args.includes("--required") ? state.required : state.all;
				if (args.includes("--required")) state.afterChecks?.();
				return { stdout: state.checksRaw ?? JSON.stringify(checks), stderr: state.checksError, exitCode: state.checksCode };
			}
			throw new Error(`Unexpected gh command: ${args.join(" ")}`);
		},
		getWorktrees: async () => git(["worktree", "list", "--porcelain"]).split("\n\n").map((record) => {
			const lines = record.split("\n");
			return {
				path: lines.find((line) => line.startsWith("worktree "))!.slice(9),
				branch: lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, ""),
			};
		}),
		sendUserMessage: (prompt) => { prompts.push(prompt); },
		now: () => now,
		maxContinuations: options.maxContinuations,
	});
	async function start(args = "", ui: { hasUI?: boolean; idle?: boolean; chosen?: string; cancel?: boolean } = {}) {
		await workflow.start(args, {
			mode: "rpc",
			hasUI: ui.hasUI ?? true,
			isIdle: () => ui.idle ?? true,
			ui: {
				custom: async () => { throw new Error("RPC must not open terminal UI"); },
				notify: (text, level) => { notices.push({ text, level }); },
				select: async (_title, choices) => {
					selections.push(choices);
					return ui.cancel ? undefined : ui.chosen ?? "feature";
				},
			},
		}, main);
	}
	return { main, feature, baseSha, head, pr, git, commit, state, commands, prompts, notices, selections, workflow, start, advanceTime: (ms: number) => { now += ms; } };
}

test("PR selects only topic worktrees, scopes every probe, and requests the complete remote-base workflow", async (t) => {
	const f = fixture(t);
	await f.start();
	assert.deepEqual(f.selections, [["feature"]]);
	assert.equal(f.workflow.isActive, true);
	assert.equal(f.prompts.length, 1);
	const prompt = f.prompts[0];
	for (const requirement of [JSON.stringify(f.feature), f.head, "fetch --no-tags", "refs/heads/main:refs/remotes/origin/main", "REMOTE-base rebase", "rebase --continue", "EVERY conflicted commit", "/skill:pr", "complete SKILL.md", "Summary, Evidence", "Merge Danger", "--force-with-lease=refs/heads", "captured-remote-OID", "pr create", "--body-file", "OUTSIDE the repository", "--watch --fail-fast", "--required", "gh run view --log-failed", "worktree_pr_pause"]) assert.ok(prompt.includes(requirement), requirement);
	assert.ok(prompt.includes(f.feature.replace(/'/g, `'\\''`)), "worktree path shell-quoted");
	assert.ok(f.commands.every((command) => command.cwd === f.feature));
	assert.ok(!f.commands.some((command) => ["fetch", "rebase", "push", "commit", "create"].some((verb) => command.args.includes(verb))), "preparation is read-only; Pi owns mutations");
	assert.equal(f.git(["rev-parse", "feature"]), f.head);
});

test("explicit PR target skips the picker; bare pr without UI requires a branch", async (t) => {
	const f = fixture(t);
	await f.start("", { hasUI: false });
	assert.match(f.notices.at(-1)!.text, /Specify a worktree branch/);
	assert.equal(f.prompts.length, 0);
	await f.start("feature", { hasUI: false });
	assert.equal(f.prompts.length, 1);
	assert.equal(f.selections.length, 0);
});

test("cancelling, busy agents, invalid targets, and extra arguments do not start PRs", async (t) => {
	const f = fixture(t);
	await f.start("", { cancel: true });
	await f.start("", { idle: false });
	for (const target of ["main", "master", "missing", "feature extra"]) await f.start(target);
	assert.equal(f.prompts.length, 0);
	assert.equal(f.workflow.isActive, false);
});

test("dirty or already-operating worktrees are rejected", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.feature, "untracked.txt"), "do not discard\n");
	await f.start();
	assert.match(f.notices.at(-1)!.text, /uncommitted or untracked/);
	fs.unlinkSync(path.join(f.feature, "untracked.txt"));
	const marker = path.resolve(f.feature, f.git(["rev-parse", "--git-path", "MERGE_HEAD"], f.feature));
	fs.mkdirSync(marker);
	await f.start();
	assert.match(f.notices.at(-1)!.text, /already in progress/);
	assert.equal(f.prompts.length, 0);
});

test("remote master is supported and the remote's default wins when both exist", async (t) => {
	const f = fixture(t, { base: "master", defaultBase: "master" });
	f.state.headRefs += `\n${f.baseSha}\trefs/heads/main`;
	await f.start();
	assert.ok(f.prompts[0].includes("refs/heads/master:refs/remotes/origin/master"));
	assert.ok(!f.prompts[0].includes("refs/heads/main:refs/remotes/origin/main"));
});

test("remote main/master, not local branch existence, determines the base", async (t) => {
	const f = fixture(t, { base: "trunk", defaultBase: "trunk" });
	f.state.headRefs = `${f.baseSha}\trefs/heads/main`;
	await f.start();
	assert.equal(f.prompts.length, 1);
	assert.ok(f.prompts[0].includes("PR base: \"main\""));
});

test("a sole non-origin remote and SSH GitHub URL work", async (t) => {
	const f = fixture(t, { remote: "upstream", remoteUrl: "git@github.com:example/repo.git" });
	await f.start();
	assert.ok(f.prompts[0].includes("refs/remotes/upstream/main"));
	assert.ok(f.commands.some((command) => command.command === "gh" && command.args.includes("https://github.com/example/repo")));
});

test("auth errors, ambiguous remotes, missing remote base, and branch races fail safely", async (t) => {
	const f = fixture(t);
	f.state.authError = "authentication required";
	await f.start();
	assert.match(f.notices.at(-1)!.text, /authentication required/);
	f.state.authError = "";
	f.state.headRefs = "";
	await f.start();
	assert.match(f.notices.at(-1)!.text, /no main or master/);
	f.state.headRefs = `${f.baseSha}\trefs/heads/main`;
	f.state.afterRepo = () => { f.commit("raced.txt"); };
	await f.start();
	assert.match(f.notices.at(-1)!.text, /tip changed/);
	f.state.afterRepo = undefined;
	f.git(["remote", "rename", "origin", "one"]);
	f.git(["remote", "add", "two", "https://github.com/example/other.git"]);
	await f.start();
	assert.match(f.notices.at(-1)!.text, /unambiguous GitHub remote/);
	assert.equal(f.prompts.length, 0);
});

test("duplicate starts and session changes cannot schedule another workflow", async (t) => {
	const f = fixture(t);
	await f.start();
	await f.start();
	assert.equal(f.prompts.length, 1);
	assert.match(f.notices.at(-1)!.text, /busy/);
	f.workflow.reset();
	assert.equal(await f.workflow.beforeSettle("completed"), undefined);
	const other = fixture(t);
	other.state.afterRepo = () => other.workflow.reset();
	await other.start();
	assert.equal(other.prompts.length, 0, "a session reset during async preparation invalidates the kickoff");
});

test("session reset during the final asynchronous readiness probe cannot queue work into another session", async (t) => {
	const f = fixture(t);
	let probes = 0;
	f.state.afterHead = () => {
		if (++probes === 2) f.workflow.reset();
	};
	await f.start();
	assert.equal(f.prompts.length, 0);
	assert.equal(f.workflow.isActive, false);
});

test("CI success is independently verified for an open PR whose latest SHA equals local HEAD", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.required = [...f.state.all];
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /CI verified green/);
	assert.ok(message(result).includes(f.pr.url));
	assert.ok(message(result).includes(f.head));
	assert.ok(message(result).includes("https://ci.example/test/1"));
	assert.equal(f.workflow.isActive, false);
	assert.ok(f.commands.some((command) => command.args.includes("--required")));
	assert.ok(f.commands.some((command) => command.args[1] === "view"));
});

test("missing PR and stale pushed SHA request continuation instead of accepting old green checks", async (t) => {
	const f = fixture(t);
	await f.start();
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /No matching open PR/);
	f.state.list = [{ ...f.pr, headRefOid: f.baseSha }];
	result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /old-commit checks do not count/);
});

test("real gh response shape with empty headRepository.nameWithOwner is identified by owner and name", async (t) => {
	const f = fixture(t);
	await f.start();
	const realistic = { ...f.pr, headRepository: { name: "repo", nameWithOwner: "" }, headRepositoryOwner: { login: "example" } };
	f.state.list = [realistic];
	f.state.latest = realistic;
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /CI verified green/);
});

test("a fork PR with the same branch name cannot satisfy this workflow", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [{ ...f.pr, headRepository: { name: "repo", nameWithOwner: "" }, headRepositoryOwner: { login: "other" } }];
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /No matching open PR/);
});

test("wrong-base and ambiguous matching PRs block instead of retargeting or guessing", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [{ ...f.pr, baseRefName: "other" }];
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /NOT verified green.*retargeting/);
	await f.start();
	f.state.list = [f.pr, { ...f.pr, number: 43 }];
	result = await f.workflow.beforeSettle("completed");
	assert.match(message(result), /Multiple matching PRs/);
});

test("a PR closed during the workflow is a blocker, not authorization to create a replacement", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.all = [{ name: "test", bucket: "pending", state: "PENDING" }];
	assert.equal((await f.workflow.beforeSettle("completed"))?.continue, true);
	f.state.list = [];
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /no longer open.*Ask the user/);
	await f.start();
	f.state.list = [f.pr];
	f.state.all = [{ name: "test", bucket: "pass", state: "SUCCESS" }];
	f.state.latest = { ...f.pr, state: "CLOSED" };
	result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /closed or merged.*user approval/);
});

test("pending, failed, cancelled, and unknown check buckets are never green", async (t) => {
	for (const bucket of ["pending", "fail", "cancel", "unexpected"]) {
		const f = fixture(t);
		await f.start();
		f.state.list = [f.pr];
		f.state.all.push({ name: "lint", bucket, state: bucket.toUpperCase(), link: "https://ci.example/lint" });
		f.state.checksCode = bucket === "pending" ? 8 : bucket === "fail" ? 1 : 0;
		const result = await f.workflow.beforeSettle("completed");
		assert.equal(result?.continue, true);
		assert.ok(message(result).includes(`lint: ${bucket}`));
		assert.ok(!message(result).includes("CI verified green"));
	}
});

test("all-failed checks still instruct Pi to fix the failure, not just wait for a passing check", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.all = [{ name: "test", bucket: "fail", state: "FAILURE" }];
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /test: fail.*repair the code/);
});

test("a failed required check prevents success even when all other checks pass", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.required = [{ name: "required-test", bucket: "fail", state: "FAILURE" }];
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /required-test: fail/);
});

test("no checks and entirely skipped checks are not green; skipped alongside passing is acceptable", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.all = [];
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /no CI checks/);
	f.state.all = [{ name: "optional", bucket: "skipping", state: "SKIPPED" }];
	result = await f.workflow.beforeSettle("completed");
	assert.match(message(result), /entirely skipped/);
	f.state.all.push({ name: "test", bucket: "pass", state: "SUCCESS" });
	result = await f.workflow.beforeSettle("completed");
	assert.match(message(result), /CI verified green/);
});

test("GitHub's no-checks-yet message is retried, not treated as green", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.checksRaw = "";
	f.state.checksError = "no checks reported on the 'feature' branch";
	f.state.checksCode = 1;
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /empty CI is not green/);
});

test("PR or local head changes during verification invalidate success", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.latest = { ...f.pr, headRefOid: f.baseSha };
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /changed during CI verification/);
	f.state.latest = f.pr;
	f.state.afterChecks = () => { f.commit("new-local-head.txt"); };
	result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /changed during CI verification/);
});

test("a rerun or missing final rollup cannot pass using an earlier green checks snapshot", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.latest = { ...f.pr, statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }] };
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /earlier passing snapshots are insufficient/);
	f.state.latest = { ...f.pr, statusCheckRollup: [] };
	result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	f.state.latest = { ...f.pr, statusCheckRollup: [{ __typename: "StatusContext", state: "SUCCESS" }] };
	result = await f.workflow.beforeSettle("completed");
	assert.match(message(result), /CI verified green/);
});

test("unfinished rebase/dirty fixes or a missing remote-base ancestry cannot pass CI gate", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	fs.writeFileSync(path.join(f.feature, "dirty.txt"), "unfinished\n");
	let result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, true);
	assert.match(message(result), /leave the selected branch clean/);
	fs.unlinkSync(path.join(f.feature, "dirty.txt"));
	f.git(["update-ref", "-d", "refs/remotes/origin/main"]);
	result = await f.workflow.beforeSettle("completed");
	assert.match(message(result), /remote base is not an ancestor/);
});

test("malformed or inaccessible CI is explicitly blocked, never silently successful", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.checksRaw = "not JSON";
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /blocked; CI is NOT verified green/);
	assert.equal(f.workflow.isActive, false);
});

test("the CI gate requests repair then independently verifies a newly pushed head", async (t) => {
	const f = fixture(t);
	await f.start();
	f.state.list = [f.pr];
	f.state.all = [{ name: "test", bucket: "fail", state: "FAILURE" }];
	assert.equal((await f.workflow.beforeSettle("completed"))?.continue, true);
	const newHead = f.commit("fix.txt");
	f.state.list = [{ ...f.pr, headRefOid: newHead }];
	f.state.latest = f.state.list[0];
	f.state.all = [{ name: "test", bucket: "pass", state: "SUCCESS" }];
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.ok(message(result).includes(newHead));
	assert.match(message(result), /CI verified green/);
});

test("verification continuations and elapsed time are bounded", async (t) => {
	const f = fixture(t, { maxContinuations: 1 });
	await f.start();
	assert.equal((await f.workflow.beforeSettle("completed"))?.continue, true);
	const result = await f.workflow.beforeSettle("completed");
	assert.equal(result?.continue, false);
	assert.match(message(result), /verification limit; CI is NOT green/);
	assert.equal(f.workflow.isActive, false);
	await f.start();
	f.advanceTime(30 * 60 * 1000);
	assert.equal((await f.workflow.beforeSettle("completed"))?.continue, false);
});

test("aborts, errors, explicit blockers, and an already-queued continuation are respected", async (t) => {
	const f = fixture(t);
	await f.start();
	assert.equal(await f.workflow.beforeSettle("completed", true), undefined);
	assert.equal(f.workflow.isActive, true);
	let result = await f.workflow.beforeSettle("aborted", true);
	assert.equal(result?.continue, false);
	assert.match(message(result), /paused \(aborted\).*NOT verified green/);
	await f.start();
	result = await f.workflow.beforeSettle("error");
	assert.match(message(result), /paused \(error\)/);
	await f.start();
	assert.match(f.workflow.pause("missing CI secret"), /NOT verified green: missing CI secret/);
	assert.equal(await f.workflow.beforeSettle("completed"), undefined);
	assert.throws(() => f.workflow.pause("again"), /No.*workflow is active/);
});
