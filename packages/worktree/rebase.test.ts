/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Real Git repositories; Pi's UI and conflict-resolution turn are captured, not model-invoked.
//   node --experimental-strip-types packages/worktree/rebase.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { handleWorktreeRebase, handleWorktreeTip, isRebaseTarget } from "./rebase.ts";

function fixture(t: TestContext, base = "main") {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-rebase-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const main = path.join(root, "repo");
	const feature = path.join(root, "repo feature's worktree");
	fs.mkdirSync(main);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
	function run(args: string[], cwd = main) {
		const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
		return { stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? result.error?.message ?? "").trim(), exitCode: result.status ?? 1 };
	}
	function git(args: string[], cwd = main) {
		const result = run(args, cwd);
		assert.equal(result.exitCode, 0, `git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
		return result.stdout;
	}
	function commit(cwd: string, filename: string, content: string) {
		fs.writeFileSync(path.join(cwd, filename), content);
		git(["add", "--", filename], cwd);
		git(["commit", "-m", `Update ${filename}`], cwd);
		return git(["rev-parse", "HEAD"], cwd);
	}
	git(["init", `--initial-branch=${base}`]);
	git(["config", "user.name", "Worktree Test"]);
	git(["config", "user.email", "worktree@example.test"]);
	git(["config", "commit.gpgsign", "false"]);
	git(["config", "core.hooksPath", path.join(root, "no-hooks")]);
	commit(main, "shared.txt", "original\n");
	git(["worktree", "add", "-b", "feature", feature]);

	async function call(cwd: string, args = "", options: {
		command?: "rebase" | "tip";
		chosen?: string;
		cancel?: boolean;
		hasUI?: boolean;
		idle?: boolean;
		afterSelect?: () => void;
		run?: typeof run;
	} = {}) {
		const notices: Array<{ text: string; level?: string }> = [];
		const selections: string[][] = [];
		const prompts: string[] = [];
		const commands: Array<{ args: string[]; cwd: string }> = [];
		const handler = options.command === "rebase" ? handleWorktreeRebase : handleWorktreeTip;
		await handler(args, {
			cwd,
			hasUI: options.hasUI ?? true,
			isIdle: () => options.idle ?? true,
			ui: {
				notify: (text, level) => { notices.push({ text, level }); },
				select: async (_title, choices) => {
					selections.push(choices);
					options.afterSelect?.();
					return options.cancel ? undefined : options.chosen ?? "feature";
				},
			},
		}, main, {
			git: async (args, cwd) => {
				commands.push({ args, cwd });
				return (options.run ?? run)(args, cwd);
			},
			getWorktrees: async () => git(["worktree", "list", "--porcelain"]).split("\n\n").map((record) => {
				const lines = record.split("\n");
				return {
					path: lines.find((line) => line.startsWith("worktree "))!.slice(9),
					branch: lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, ""),
				};
			}),
			sendUserMessage: (prompt) => { prompts.push(prompt); },
		});
		return { notices, selections, prompts, commands };
	}
	return { main, feature, git, run, commit, call };
}

function assertNoRebase(result: Awaited<ReturnType<ReturnType<typeof fixture>["call"]>>, message: RegExp) {
	assert.equal(result.commands.some((command) => command.args.includes("rebase")), false);
	assert.equal(result.prompts.length, 0);
	assert.match(result.notices.at(-1)!.text, message);
}

test("tip from a linked worktree subdirectory uses local main and leaves main unchanged", async (t) => {
	const f = fixture(t);
	const oldTip = f.commit(f.feature, "topic.txt", "topic\n");
	const base = f.commit(f.main, "base.txt", "base\n");
	f.git(["branch", "topic-alias", oldTip]);
	f.git(["config", "rebase.updateRefs", "true"]);
	const subdir = path.join(f.feature, "subdir");
	fs.mkdirSync(subdir);
	const result = await f.call(subdir);
	assert.equal(result.selections.length, 0);
	assert.equal(result.prompts.length, 0);
	assert.match(result.notices.at(-1)!.text, /✓ Rebased.*onto local main/);
	f.git(["merge-base", "--is-ancestor", base, "feature"]);
	assert.notEqual(f.git(["rev-parse", "feature"]), oldTip);
	assert.equal(f.git(["rev-parse", "main"]), base);
	assert.equal(f.git(["rev-parse", "topic-alias"]), oldTip, "configured updateRefs must not rewrite another branch");
	assert.equal(f.git(["symbolic-ref", "--short", "HEAD"], f.feature), "feature");
	assert.equal(fs.readFileSync(path.join(f.feature, "topic.txt"), "utf8"), "topic\n");
	assert.equal(fs.readFileSync(path.join(f.feature, "base.txt"), "utf8"), "base\n");
});

test("main opens a picker for topic worktrees and only rebases the selected checkout", async (t) => {
	const f = fixture(t);
	f.commit(f.feature, "topic.txt", "topic\n");
	const base = f.commit(f.main, "base.txt", "base\n");
	f.git(["branch", "master"]);
	// Dirty main is irrelevant: only the target must be clean.
	fs.writeFileSync(path.join(f.main, "untracked.txt"), "do not touch\n");
	const result = await f.call(f.main);
	assert.deepEqual(result.selections, [["feature"]]);
	f.git(["merge-base", "--is-ancestor", base, "feature"]);
	assert.equal(f.git(["rev-parse", "main"]), base);
	assert.equal(fs.readFileSync(path.join(f.main, "untracked.txt"), "utf8"), "do not touch\n");
});

test("explicit target bypasses the picker", async (t) => {
	const f = fixture(t);
	f.commit(f.feature, "topic.txt", "topic\n");
	const base = f.commit(f.main, "base.txt", "base\n");
	const result = await f.call(f.main, "feature");
	assert.equal(result.selections.length, 0);
	f.git(["merge-base", "--is-ancestor", base, "feature"]);
});

test("master is used when main does not exist", async (t) => {
	const f = fixture(t, "master");
	f.commit(f.feature, "topic.txt", "topic\n");
	const base = f.commit(f.main, "base.txt", "base\n");
	const result = await f.call(f.feature);
	assert.match(result.notices.at(-1)!.text, /onto local master/);
	f.git(["merge-base", "--is-ancestor", base, "feature"]);
});

test("invoking master wins over main when both exist", async (t) => {
	const f = fixture(t, "master");
	f.git(["branch", "main"]);
	f.commit(f.feature, "topic.txt", "topic\n");
	const base = f.commit(f.main, "base.txt", "base\n");
	const result = await f.call(f.main);
	assert.match(result.notices.at(-1)!.text, /onto local master/);
	f.git(["merge-base", "--is-ancestor", base, "feature"]);
});

test("main is preferred from a topic when both bases exist", async (t) => {
	const f = fixture(t);
	f.git(["branch", "master"]);
	f.commit(f.feature, "topic.txt", "topic\n");
	f.commit(f.main, "base.txt", "base\n");
	const result = await f.call(f.feature);
	assert.match(result.notices.at(-1)!.text, /onto local main/);
});

test("topic branch in the primary checkout is eligible", async (t) => {
	const f = fixture(t);
	f.git(["switch", "-c", "primary-topic"]);
	f.commit(f.main, "topic.txt", "primary\n");
	const result = await f.call(f.main);
	assert.match(result.notices.at(-1)!.text, /✓ Rebased "primary-topic"/);
});

test("cancelling the picker does not mutate Git", async (t) => {
	const f = fixture(t);
	const result = await f.call(f.main, "", { cancel: true });
	assert.equal(result.notices.length, 0);
	assert.equal(result.commands.some((command) => command.args.includes("rebase")), false);
	assert.equal(result.prompts.length, 0);
});

test("invalid targets and extra arguments never rebase", async (t) => {
	const f = fixture(t);
	for (const branch of ["main", "master", "missing", "feature extra"]) {
		assertNoRebase(await f.call(f.main, branch), /No eligible|Usage/);
	}
});

test("detached HEAD needs an explicit target and no-UI main needs a branch", async (t) => {
	const f = fixture(t);
	assertNoRebase(await f.call(f.main, "", { hasUI: false }), /Specify a worktree branch/);
	f.git(["checkout", "--detach"], f.feature);
	assertNoRebase(await f.call(f.feature), /Detached HEAD/);
});

test("busy agent is rejected without Git commands", async (t) => {
	const f = fixture(t);
	const result = await f.call(f.feature, "", { idle: false });
	assertNoRebase(result, /Agent is busy/);
	assert.equal(result.commands.length, 0);
});

test("missing base gives an actionable error", async (t) => {
	const f = fixture(t);
	f.git(["branch", "-m", "main", "trunk"]);
	assertNoRebase(await f.call(f.feature), /No local main or master/);
});

test("untracked, unstaged, and staged changes are preserved; autostash config cannot bypass safety", async (t) => {
	const f = fixture(t);
	f.git(["config", "rebase.autoStash", "true"]);
	const tip = f.git(["rev-parse", "feature"]);
	fs.writeFileSync(path.join(f.feature, "untracked.txt"), "untracked\n");
	assertNoRebase(await f.call(f.feature), /uncommitted or untracked changes/);
	fs.unlinkSync(path.join(f.feature, "untracked.txt"));
	fs.writeFileSync(path.join(f.feature, "shared.txt"), "changed\n");
	assertNoRebase(await f.call(f.feature), /uncommitted or untracked changes/);
	f.git(["add", "shared.txt"], f.feature);
	assertNoRebase(await f.call(f.feature), /uncommitted or untracked changes/);
	assert.equal(f.git(["rev-parse", "feature"]), tip);
	assert.equal(fs.readFileSync(path.join(f.feature, "shared.txt"), "utf8"), "changed\n");
	assert.equal(f.git(["stash", "list"], f.feature), "");
});

test("existing operations are rejected using worktree-specific Git paths", async (t) => {
	const f = fixture(t);
	for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
		const location = path.resolve(f.feature, f.git(["rev-parse", "--git-path", marker], f.feature));
		fs.mkdirSync(location);
		assertNoRebase(await f.call(f.main, "feature"), /already in progress/);
		fs.rmSync(location, { recursive: true });
	}
});

test("branch changing while the picker is open fails safely", async (t) => {
	const f = fixture(t);
	assertNoRebase(await f.call(f.main, "", {
		afterSelect: () => { f.git(["switch", "-c", "changed"], f.feature); },
	}), /Worktree branch changed/);
});

test("non-conflict Git failure does not send a resolution prompt", async (t) => {
	const f = fixture(t);
	const result = await f.call(f.feature, "", {
		run: (args, cwd) => args.includes("rebase")
			? { stdout: "", stderr: "pre-rebase hook refused", exitCode: 1 }
			: f.run(args, cwd),
	});
	assert.equal(result.prompts.length, 0);
	assert.match(result.notices.at(-1)!.text, /pre-rebase hook refused/);
	assert.equal(result.notices.at(-1)!.level, "error");
});

test("real conflicts trigger a scoped Pi turn; continuation can resolve multiple conflicted commits", async (t) => {
	const f = fixture(t);
	f.commit(f.feature, "shared.txt", "topic first\n");
	const original = f.commit(f.feature, "shared.txt", "topic second\n");
	const base = f.commit(f.main, "shared.txt", "base\n");
	const result = await f.call(f.main, "feature");
	assert.equal(result.prompts.length, 1);
	const prompt = result.prompts[0];
	assert.ok(prompt.includes(JSON.stringify(f.feature)));
	assert.ok(prompt.includes(`git -C '${f.feature.replace(/'/g, `'\\''`)}'`), "shell path is quoted, including apostrophes");
	assert.ok(prompt.includes(original));
	assert.ok(prompt.includes(base));
	assert.match(prompt, /head-name, orig-head, onto/);
	assert.match(prompt, /Do not blindly choose ours\/theirs/);
	assert.match(prompt, /core.editor=true.*rebase --continue/);
	assert.match(prompt, /every conflicted commit/);
	assert.match(prompt, /Do not skip commits, abort, reset, stash/);
	assert.match(prompt, /Run the relevant project checks/);
	assert.equal(f.git(["diff", "--name-only", "--diff-filter=U"], f.feature), "shared.txt");
	assert.equal(f.git(["rev-parse", "main"]), base);

	// Emulate the requested agent actions (without making an external model call).
	fs.writeFileSync(path.join(f.feature, "shared.txt"), "base + topic first\n");
	f.git(["add", "--", "shared.txt"], f.feature);
	const next = f.run(["-c", "core.editor=true", "rebase", "--continue"], f.feature);
	assert.equal(next.exitCode, 1, "the next topic commit also conflicts");
	assert.equal(f.git(["diff", "--name-only", "--diff-filter=U"], f.feature), "shared.txt");
	fs.writeFileSync(path.join(f.feature, "shared.txt"), "base + topic first + topic second\n");
	f.git(["add", "--", "shared.txt"], f.feature);
	f.git(["-c", "core.editor=true", "rebase", "--continue"], f.feature);
	assert.equal(f.git(["symbolic-ref", "--short", "HEAD"], f.feature), "feature");
	assert.equal(f.git(["status", "--porcelain"], f.feature), "");
	f.git(["merge-base", "--is-ancestor", base, "feature"]);
	assert.equal(fs.existsSync(path.resolve(f.feature, f.git(["rev-parse", "--git-path", "rebase-merge"], f.feature))), false);
});

test("eligibility is based on the branch, not primary checkout or managed status", () => {
	assert.equal(isRebaseTarget({ path: "/repo", branch: "topic" }), true);
	for (const wt of [
		{ path: "/repo", branch: "main" },
		{ path: "/repo", branch: "master" },
		{ path: "/repo" },
		{ path: "/repo", branch: "topic", bare: true },
		{ path: "/repo", branch: "topic", prunable: true },
	]) assert.equal(isRebaseTarget(wt), false);
});

function temporaryCheckout(result: Awaited<ReturnType<ReturnType<typeof fixture>["call"]>>): string {
	const added = result.commands.find((command) => command.args[0] === "worktree" && command.args[1] === "add");
	assert.ok(added, "a temporary checkout was created");
	return added.args[3];
}

function removeTemporaryFixture(f: ReturnType<typeof fixture>, checkout: string): void {
	if (fs.existsSync(checkout)) {
		f.run(["rebase", "--abort"], checkout);
		f.git(["worktree", "remove", "--", checkout]);
	}
	if (fs.existsSync(path.dirname(checkout))) fs.rmdirSync(path.dirname(checkout));
}

test("rebase replays main onto the current topic from a subdirectory, leaving the topic and aliases unchanged", async (t) => {
	const f = fixture(t);
	const topic = f.commit(f.feature, "topic.txt", "topic\n");
	const main = f.commit(f.main, "main.txt", "main\n");
	f.git(["branch", "main-alias", main]);
	f.git(["branch", "topic-alias", topic]);
	f.git(["config", "rebase.updateRefs", "true"]);
	const subdir = path.join(f.feature, "subdir");
	fs.mkdirSync(subdir);
	const result = await f.call(subdir, "", { command: "rebase" });
	assert.match(result.notices.at(-1)!.text, /Rebased "main" onto local feature/);
	assert.equal(result.selections.length, 0);
	assert.equal(result.prompts.length, 0);
	f.git(["merge-base", "--is-ancestor", topic, "main"]);
	assert.notEqual(f.git(["rev-parse", "main"]), main);
	assert.equal(f.git(["rev-parse", "feature"]), topic);
	assert.equal(f.git(["rev-parse", "main-alias"]), main);
	assert.equal(f.git(["rev-parse", "topic-alias"]), topic);
	assert.equal(f.git(["symbolic-ref", "--short", "HEAD"], f.main), "main");
	assert.equal(f.git(["symbolic-ref", "--short", "HEAD"], f.feature), "feature");
	assert.equal(fs.readFileSync(path.join(f.main, "topic.txt"), "utf8"), "topic\n");
	assert.equal(fs.readFileSync(path.join(f.main, "main.txt"), "utf8"), "main\n");
});

test("rebase on main picks a topic but mutates the main checkout, not the selected topic", async (t) => {
	const f = fixture(t);
	const topic = f.commit(f.feature, "topic.txt", "topic\n");
	f.commit(f.main, "main.txt", "main\n");
	const result = await f.call(f.main, "", { command: "rebase" });
	assert.deepEqual(result.selections, [["feature"]]);
	const rebase = result.commands.find((command) => command.args.includes("rebase"));
	assert.equal(rebase?.cwd, f.main);
	assert.equal(rebase?.args.at(-1), topic);
	assert.equal(f.git(["rev-parse", "feature"]), topic);
	f.git(["merge-base", "--is-ancestor", topic, "main"]);
});

test("explicit rebase source can differ from the invoking topic checkout", async (t) => {
	const f = fixture(t);
	const topic = f.commit(f.feature, "topic.txt", "topic\n");
	f.commit(f.main, "main.txt", "main\n");
	const other = path.join(path.dirname(f.feature), "other");
	f.git(["worktree", "add", "-b", "other", other]);
	const otherHead = f.commit(other, "other.txt", "other\n");
	const result = await f.call(other, "feature", { command: "rebase" });
	assert.equal(result.selections.length, 0);
	f.git(["merge-base", "--is-ancestor", topic, "main"]);
	assert.equal(f.git(["rev-parse", "feature"]), topic);
	assert.equal(f.git(["rev-parse", "other"]), otherHead);
});

test("rebase supports master fallback and prefers the invoking master when main also exists", async (t) => {
	const f = fixture(t, "master");
	const topic = f.commit(f.feature, "topic.txt", "topic\n");
	f.commit(f.main, "master.txt", "master\n");
	const result = await f.call(f.feature, "", { command: "rebase" });
	assert.match(result.notices.at(-1)!.text, /Rebased "master" onto local feature/);
	f.git(["merge-base", "--is-ancestor", topic, "master"]);
	f.git(["branch", "main"]);
	const main = f.git(["rev-parse", "main"]);
	const newerTopic = f.commit(f.feature, "new-topic.txt", "new topic\n");
	const next = await f.call(f.main, "", { command: "rebase" });
	assert.match(next.notices.at(-1)!.text, /Rebased "master" onto local feature/);
	assert.equal(f.git(["rev-parse", "main"]), main);
	f.git(["merge-base", "--is-ancestor", newerTopic, "master"]);
});

test("rebase protects untracked, unstaged, and staged main changes even when autostash is configured", async (t) => {
	const f = fixture(t);
	f.commit(f.feature, "topic.txt", "topic\n");
	f.git(["config", "rebase.autoStash", "true"]);
	const main = f.git(["rev-parse", "main"]);
	fs.writeFileSync(path.join(f.main, "untracked.txt"), "do not discard\n");
	assertNoRebase(await f.call(f.feature, "", { command: "rebase" }), /uncommitted or untracked/);
	fs.unlinkSync(path.join(f.main, "untracked.txt"));
	fs.writeFileSync(path.join(f.main, "shared.txt"), "dirty\n");
	assertNoRebase(await f.call(f.feature, "", { command: "rebase" }), /uncommitted or untracked/);
	f.git(["add", "shared.txt"]);
	assertNoRebase(await f.call(f.feature, "", { command: "rebase" }), /uncommitted or untracked/);
	assert.equal(f.git(["rev-parse", "main"]), main);
	assert.equal(fs.readFileSync(path.join(f.main, "shared.txt"), "utf8"), "dirty\n");
	assert.equal(f.git(["stash", "list"]), "");
});

test("rebase uses only the committed topic tip and leaves its uncommitted files untouched", async (t) => {
	const f = fixture(t);
	const topic = f.commit(f.feature, "topic.txt", "committed\n");
	fs.writeFileSync(path.join(f.feature, "topic.txt"), "uncommitted\n");
	fs.writeFileSync(path.join(f.feature, "untracked.txt"), "untracked\n");
	const result = await f.call(f.feature, "", { command: "rebase" });
	assert.match(result.notices.at(-1)!.text, /Rebased "main" onto local feature/);
	assert.equal(f.git(["rev-parse", "feature"]), topic);
	assert.equal(fs.readFileSync(path.join(f.feature, "topic.txt"), "utf8"), "uncommitted\n");
	assert.equal(fs.readFileSync(path.join(f.feature, "untracked.txt"), "utf8"), "untracked\n");
	assert.equal(fs.readFileSync(path.join(f.main, "topic.txt"), "utf8"), "committed\n");
	assert.equal(fs.existsSync(path.join(f.main, "untracked.txt")), false);
});

test("rebase rejects an existing operation in either the main target or topic source", async (t) => {
	const f = fixture(t);
	for (const cwd of [f.main, f.feature]) {
		const marker = path.resolve(cwd, f.git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], cwd));
		fs.mkdirSync(marker);
		assertNoRebase(await f.call(f.feature, "", { command: "rebase" }), /already in progress/);
		fs.rmdirSync(marker);
	}
});

test("rebase creates and removes a temporary main checkout without switching the primary topic", async (t) => {
	const f = fixture(t);
	const main = f.commit(f.main, "main.txt", "main\n");
	f.git(["switch", "-c", "primary-topic", "feature"]);
	const topic = f.commit(f.main, "topic.txt", "topic\n");
	const result = await f.call(f.main, "", { command: "rebase" });
	const checkout = temporaryCheckout(result);
	assert.equal(fs.existsSync(path.dirname(checkout)), false, "the temporary root and checkout are removed");
	assert.ok(result.commands.some((command) => command.args[0] === "worktree" && command.args[1] === "remove"));
	assert.ok(!result.commands.some((command) => command.args.includes("--force")));
	f.git(["merge-base", "--is-ancestor", topic, "main"]);
	assert.notEqual(f.git(["rev-parse", "main"]), main);
	assert.equal(f.git(["rev-parse", "primary-topic"]), topic);
	assert.equal(f.git(["symbolic-ref", "--short", "HEAD"]), "primary-topic");
	assert.equal(f.git(["show", "main:main.txt"]), "main");
	assert.equal(fs.existsSync(path.join(f.main, "main.txt")), false);
});

test("rebase conflicts are resolved in main for every replayed main commit, leaving topic unchanged", async (t) => {
	const f = fixture(t);
	const topic = f.commit(f.feature, "shared.txt", "topic\n");
	f.commit(f.main, "shared.txt", "main first\n");
	const original = f.commit(f.main, "shared.txt", "main second\n");
	const result = await f.call(f.feature, "", { command: "rebase" });
	assert.equal(result.prompts.length, 1);
	const prompt = result.prompts[0];
	assert.match(prompt, /\/worktree rebase stopped/);
	assert.ok(prompt.includes(JSON.stringify(f.main)));
	assert.ok(prompt.includes('Branch being rebased: "main" onto local "feature"'));
	assert.ok(prompt.includes(original));
	assert.ok(prompt.includes(topic));
	assert.match(prompt, /Do not modify the branch\/worktree being used as the onto source/);
	assert.equal(f.git(["diff", "--name-only", "--diff-filter=U"]), "shared.txt");
	assert.equal(f.git(["rev-parse", "feature"]), topic);
	fs.writeFileSync(path.join(f.main, "shared.txt"), "topic + main first\n");
	f.git(["add", "--", "shared.txt"]);
	assert.equal(f.run(["-c", "core.editor=true", "rebase", "--continue"]).exitCode, 1);
	fs.writeFileSync(path.join(f.main, "shared.txt"), "topic + main first + main second\n");
	f.git(["add", "--", "shared.txt"]);
	f.git(["-c", "core.editor=true", "rebase", "--continue"]);
	f.git(["merge-base", "--is-ancestor", topic, "main"]);
	assert.equal(f.git(["rev-parse", "feature"]), topic);
	assert.equal(f.git(["symbolic-ref", "--short", "HEAD"]), "main");
	assert.equal(f.git(["status", "--porcelain"]), "");
});

test("conflicted temporary main checkout is retained and the Pi prompt includes safe post-success cleanup", async (t) => {
	const f = fixture(t);
	f.commit(f.main, "shared.txt", "main\n");
	f.git(["switch", "-c", "primary-topic", "feature"]);
	const topic = f.commit(f.main, "shared.txt", "topic\n");
	const result = await f.call(f.main, "", { command: "rebase" });
	const checkout = temporaryCheckout(result);
	try {
		assert.equal(result.prompts.length, 1);
		assert.ok(result.prompts[0].includes(JSON.stringify(checkout)));
		assert.match(result.prompts[0], /ONLY after successful completion and a clean worktree/);
		assert.match(result.prompts[0], /Never use --force and never delete the main\/master branch/);
		assert.equal(fs.existsSync(checkout), true);
		assert.equal(f.git(["diff", "--name-only", "--diff-filter=U"], checkout), "shared.txt");
		assert.equal(f.git(["rev-parse", "primary-topic"]), topic);
		assert.ok(!result.commands.some((command) => command.args[0] === "worktree" && command.args[1] === "remove"));
	} finally {
		removeTemporaryFixture(f, checkout);
	}
});

test("temporary cleanup failures never force-remove data or delete main", async (t) => {
	const f = fixture(t);
	f.git(["switch", "-c", "primary-topic"]);
	const topic = f.commit(f.main, "topic.txt", "topic\n");
	const result = await f.call(f.main, "", {
		command: "rebase",
		run: (args, cwd) => args[0] === "worktree" && args[1] === "remove"
			? { stdout: "", stderr: "cannot safely remove", exitCode: 1 } : f.run(args, cwd),
	});
	const checkout = temporaryCheckout(result);
	try {
		assert.equal(fs.existsSync(checkout), true);
		assert.match(result.notices.at(-1)!.text, /Could not safely remove temporary checkout/);
		assert.ok(!result.commands.some((command) => command.args.includes("--force") || command.args.includes("-D")));
		f.git(["merge-base", "--is-ancestor", topic, "main"]);
	} finally {
		removeTemporaryFixture(f, checkout);
	}
});

test("an uncertain Git execution retains the temporary checkout but releases in-process locks", async (t) => {
	const f = fixture(t);
	f.git(["switch", "-c", "primary-topic"]);
	f.commit(f.main, "topic.txt", "topic\n");
	const result = await f.call(f.main, "", {
		command: "rebase",
		run: (args, cwd) => {
			if (args.includes("rebase")) throw new Error("lost Git process");
			return f.run(args, cwd);
		},
	});
	const checkout = temporaryCheckout(result);
	try {
		assert.equal(fs.existsSync(checkout), true);
		assert.ok(!result.commands.some((command) => command.args[0] === "worktree" && command.args[1] === "remove"));
		const retried = await f.call(f.main, "", { command: "rebase" });
		assert.match(retried.notices.at(-1)!.text, /Rebased "main" onto local primary-topic/);
	} finally {
		removeTemporaryFixture(f, checkout);
	}
});
