/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Pi Worktree Extension - Manage git worktrees with tmux integration
 *
 * Provides commands to create, manage, switch, rename, and clean up
 * git worktrees running pi coding agents in tmux without prompts.
 *
 * Commands:
 *   /worktree [branch]                - Create worktree & run pi, or open interactive menu if no args
 *   /worktree create <branch> [base]  - Create new worktree (optionally from base branch) & run pi
 *   /worktree list                    - List all worktrees with managed & tmux status
 *   /worktree clean                   - Clean up all managed worktrees and their branches
 *   /worktree remove [branch]         - Remove a specific worktree and delete its branch
 *   /worktree rename [old] [new]      - Rename a worktree's branch
 *   /worktree switch [branch]         - Switch/attach to a worktree's tmux window or session
 *   /worktree help                    - Show worktree command help
 *
 * Also provides alias shortcuts:
 *   /worktrees                        - Quick alias for /worktree list
 *   /worktree-clean                   - Quick alias for /worktree clean
 *   /worktree-remove [branch]         - Quick alias for /worktree remove
 *   /worktree-rename [old] [new]      - Quick alias for /worktree rename
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WORKTREE_REGISTRY_FILE = "worktrees.json";
const WORKTREE_ENTRY_TYPE = "worktree-entry";

interface ManagedRecord {
	branch: string;
	path: string;
	baseBranch?: string;
	createdAt: number;
	tmuxSession?: string;
	tmuxWindowId?: string;
	tmuxWindowIndex?: number;
}

interface RegistryData {
	version: 1;
	worktrees: Record<string, ManagedRecord>;
}

interface GitWorktreeInfo {
	path: string;
	branch?: string;
	commit?: string;
	bare?: boolean;
	locked?: boolean;
	prunable?: boolean;
}

interface FullWorktreeStatus extends GitWorktreeInfo {
	isMain: boolean;
	isManaged: boolean;
	managedRecord?: ManagedRecord;
	tmuxActive: boolean;
	tmuxTarget?: string;
}

// ---------------------------------------------------------------------------
// Shell & Git Helpers
// ---------------------------------------------------------------------------

async function exec(
	cmd: string,
	args: string[],
	cwd?: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
		});

		proc.on("error", (err) => {
			resolve({ stdout: "", stderr: err.message, exitCode: 1 });
		});

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 3000);
				},
				{ once: true },
			);
		}
	});
}

async function getGitRoot(cwd: string): Promise<string | null> {
	const res = await exec("git", ["rev-parse", "--show-toplevel"], cwd);
	return res.exitCode === 0 && res.stdout ? res.stdout : null;
}

async function getGitWorktrees(gitRoot: string): Promise<GitWorktreeInfo[]> {
	const res = await exec("git", ["worktree", "list", "--porcelain"], gitRoot);
	if (res.exitCode !== 0) return [];

	const list: GitWorktreeInfo[] = [];
	let current: Partial<GitWorktreeInfo> = {};

	for (const line of res.stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("worktree ")) {
			if (current.path) {
				list.push(current as GitWorktreeInfo);
			}
			current = { path: trimmed.slice(9) };
		} else if (trimmed.startsWith("HEAD ")) {
			current.commit = trimmed.slice(5);
		} else if (trimmed.startsWith("branch ")) {
			current.branch = trimmed.slice(7).replace(/^refs\/heads\//, "");
		} else if (trimmed === "bare") {
			current.bare = true;
		} else if (trimmed.startsWith("locked")) {
			current.locked = true;
		} else if (trimmed.startsWith("prunable")) {
			current.prunable = true;
		} else if (trimmed === "") {
			if (current.path) {
				list.push(current as GitWorktreeInfo);
				current = {};
			}
		}
	}
	if (current.path) {
		list.push(current as GitWorktreeInfo);
	}
	return list;
}

async function checkBranchExists(gitRoot: string, branch: string): Promise<boolean> {
	const res = await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`], gitRoot);
	return res.exitCode === 0;
}

async function getCurrentBranch(gitRoot: string): Promise<string> {
	const res = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitRoot);
	return res.exitCode === 0 ? res.stdout : "main";
}

function sanitizeBranchForPath(branch: string): string {
	return branch.replace(/[\/\\:*?"<>|]/g, "-").replace(/^-+|-+$/g, "");
}

function computeWorktreePath(gitRoot: string, branch: string): string {
	const repoName = path.basename(gitRoot);
	const parentDir = path.dirname(gitRoot);
	const sanitized = sanitizeBranchForPath(branch);
	return path.join(parentDir, `${repoName}-${sanitized}`);
}

// ---------------------------------------------------------------------------
// Registry / Persistence
// ---------------------------------------------------------------------------

function getRegistryFilePath(gitRoot: string): string {
	const piDir = path.join(gitRoot, ".pi");
	return path.join(piDir, WORKTREE_REGISTRY_FILE);
}

async function loadRegistry(gitRoot: string): Promise<RegistryData> {
	const filePath = getRegistryFilePath(gitRoot);
	try {
		const raw = await fs.promises.readFile(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (data && data.version === 1 && typeof data.worktrees === "object") {
			return data as RegistryData;
		}
	} catch {
		// File does not exist or invalid
	}
	return { version: 1, worktrees: {} };
}

async function saveRegistry(gitRoot: string, data: RegistryData): Promise<void> {
	const filePath = getRegistryFilePath(gitRoot);
	const dir = path.dirname(filePath);
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
	} catch {
		// Ignore write error
	}
}

async function registerManagedWorktree(gitRoot: string, record: ManagedRecord): Promise<void> {
	const reg = await loadRegistry(gitRoot);
	reg.worktrees[record.branch] = record;
	await saveRegistry(gitRoot, reg);
}

async function unregisterManagedWorktree(gitRoot: string, branch: string): Promise<void> {
	const reg = await loadRegistry(gitRoot);
	delete reg.worktrees[branch];
	await saveRegistry(gitRoot, reg);
}

async function renameManagedWorktreeRecord(gitRoot: string, oldBranch: string, newBranch: string): Promise<void> {
	const reg = await loadRegistry(gitRoot);
	if (reg.worktrees[oldBranch]) {
		const rec = reg.worktrees[oldBranch];
		rec.branch = newBranch;
		delete reg.worktrees[oldBranch];
		reg.worktrees[newBranch] = rec;
		await saveRegistry(gitRoot, reg);
	}
}

// ---------------------------------------------------------------------------
// Tmux Helpers
// ---------------------------------------------------------------------------

async function isTmuxAvailable(): Promise<boolean> {
	const res = await exec("tmux", ["-V"]);
	return res.exitCode === 0;
}

function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX);
}

async function getCurrentTmuxSession(): Promise<string | null> {
	if (!isInsideTmux()) return null;
	const res = await exec("tmux", ["display-message", "-p", "#{session_name}"]);
	return res.exitCode === 0 && res.stdout ? res.stdout : null;
}

async function checkTmuxWindowExists(target: string): Promise<boolean> {
	const res = await exec("tmux", ["display-message", "-p", "-t", target, "#{window_id}"]);
	return res.exitCode === 0;
}

async function checkTmuxSessionExists(sessionName: string): Promise<boolean> {
	const res = await exec("tmux", ["has-session", "-t", sessionName]);
	return res.exitCode === 0;
}

async function killTmuxTarget(target: string): Promise<void> {
	// Try killing window first, then session
	if (target.startsWith("@") || target.includes(":")) {
		await exec("tmux", ["kill-window", "-t", target]);
	} else {
		await exec("tmux", ["kill-session", "-t", target]);
	}
}

interface SpawnTmuxResult {
	success: boolean;
	isNewWindow: boolean;
	tmuxTarget: string;
	windowIndex?: number;
	error?: string;
}

async function spawnPiInTmux(
	worktreePath: string,
	branch: string,
	signal?: AbortSignal,
): Promise<SpawnTmuxResult> {
	const hasTmux = await isTmuxAvailable();
	if (!hasTmux) {
		return { success: false, isNewWindow: false, tmuxTarget: "", error: "tmux is not installed or not in PATH" };
	}

	const windowName = `wt:${sanitizeBranchForPath(branch)}`;
	// Command to run inside tmux: starts pi interactively with session name, no initial prompt!
	const piCommand = `pi --name "wt:${branch}"`;

	if (isInsideTmux()) {
		// Inside tmux: create a new window in the active session
		const currentSession = await getCurrentTmuxSession();
		const targetSession = currentSession ? `${currentSession}:` : "";

		const res = await exec(
			"tmux",
			[
				"new-window",
				"-P",
				"-F",
				"#{window_id}:#{window_index}",
				"-t",
				targetSession,
				"-n",
				windowName,
				"-c",
				worktreePath,
				piCommand,
			],
			worktreePath,
			signal,
		);

		if (res.exitCode === 0 && res.stdout) {
			const parts = res.stdout.split(":");
			const windowId = parts[0];
			const windowIndex = Number.parseInt(parts[1], 10);
			return {
				success: true,
				isNewWindow: true,
				tmuxTarget: windowId,
				windowIndex: Number.isFinite(windowIndex) ? windowIndex : undefined,
			};
		}

		// Fallback: spawn without -P output parsing
		const fallback = await exec(
			"tmux",
			["new-window", "-n", windowName, "-c", worktreePath, piCommand],
			worktreePath,
			signal,
		);
		if (fallback.exitCode === 0) {
			return { success: true, isNewWindow: true, tmuxTarget: windowName };
		}
		return { success: false, isNewWindow: true, tmuxTarget: "", error: res.stderr || fallback.stderr };
	}

	// Outside tmux: create a dedicated detached session
	const sessionName = `pi-wt-${sanitizeBranchForPath(branch)}`;
	const exists = await checkTmuxSessionExists(sessionName);
	if (exists) {
		return {
			success: true,
			isNewWindow: false,
			tmuxTarget: sessionName,
		};
	}

	const res = await exec(
		"tmux",
		["new-session", "-d", "-s", sessionName, "-c", worktreePath, piCommand],
		worktreePath,
		signal,
	);

	if (res.exitCode === 0) {
		return {
			success: true,
			isNewWindow: false,
			tmuxTarget: sessionName,
		};
	}

	return { success: false, isNewWindow: false, tmuxTarget: "", error: res.stderr };
}

async function switchToTmuxTarget(target: string): Promise<{ success: boolean; error?: string }> {
	if (isInsideTmux()) {
		const res = await exec("tmux", ["select-window", "-t", target]);
		if (res.exitCode === 0) return { success: true };
		return { success: false, error: res.stderr };
	}
	return { success: true };
}

// ---------------------------------------------------------------------------
// High-Level Worktree Operations
// ---------------------------------------------------------------------------

async function getAllWorktreeStatuses(gitRoot: string): Promise<FullWorktreeStatus[]> {
	const gitWorktrees = await getGitWorktrees(gitRoot);
	const reg = await loadRegistry(gitRoot);

	const statuses: FullWorktreeStatus[] = [];

	for (const wt of gitWorktrees) {
		const isMain = path.resolve(wt.path) === path.resolve(gitRoot);
		const branch = wt.branch ?? "";
		const record = branch ? reg.worktrees[branch] : undefined;
		const isManaged = Boolean(record);

		let tmuxActive = false;
		let tmuxTarget: string | undefined;

		if (record) {
			if (record.tmuxWindowId && (await checkTmuxWindowExists(record.tmuxWindowId))) {
				tmuxActive = true;
				tmuxTarget = record.tmuxWindowId;
			} else if (record.tmuxSession && (await checkTmuxSessionExists(record.tmuxSession))) {
				tmuxActive = true;
				tmuxTarget = record.tmuxSession;
			}
		}

		// Also check window by standard name pattern
		if (!tmuxActive && branch) {
			const expectedWindowName = `wt:${sanitizeBranchForPath(branch)}`;
			if (isInsideTmux() && (await checkTmuxWindowExists(expectedWindowName))) {
				tmuxActive = true;
				tmuxTarget = expectedWindowName;
			} else {
				const expectedSessionName = `pi-wt-${sanitizeBranchForPath(branch)}`;
				if (await checkTmuxSessionExists(expectedSessionName)) {
					tmuxActive = true;
					tmuxTarget = expectedSessionName;
				}
			}
		}

		statuses.push({
			...wt,
			isMain,
			isManaged,
			managedRecord: record,
			tmuxActive,
			tmuxTarget,
		});
	}

	return statuses;
}

interface CreateWorktreeOptions {
	branch: string;
	baseBranch?: string;
	signal?: AbortSignal;
}

interface CreateWorktreeResult {
	success: boolean;
	worktreePath: string;
	branch: string;
	tmuxTarget?: string;
	windowIndex?: number;
	isInsideTmux: boolean;
	error?: string;
}

async function createWorktreeAndSpawnPi(
	gitRoot: string,
	options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
	const { branch, baseBranch, signal } = options;
	const worktreePath = computeWorktreePath(gitRoot, branch);

	// Check if path already exists
	if (fs.existsSync(worktreePath)) {
		return {
			success: false,
			worktreePath,
			branch,
			isInsideTmux: isInsideTmux(),
			error: `Directory already exists: ${worktreePath}`,
		};
	}

	// Check if branch already exists in git
	const branchExists = await checkBranchExists(gitRoot, branch);
	let addResult: { stdout: string; stderr: string; exitCode: number };

	if (branchExists) {
		// Checkout existing branch into new worktree
		addResult = await exec("git", ["worktree", "add", worktreePath, branch], gitRoot, signal);
	} else {
		// Create new branch
		const args = ["worktree", "add", "-b", branch, worktreePath];
		if (baseBranch) {
			args.push(baseBranch);
		}
		addResult = await exec("git", args, gitRoot, signal);
	}

	if (addResult.exitCode !== 0) {
		return {
			success: false,
			worktreePath,
			branch,
			isInsideTmux: isInsideTmux(),
			error: `git worktree add failed: ${addResult.stderr || addResult.stdout}`,
		};
	}

	// Spawn Pi inside tmux
	const tmuxRes = await spawnPiInTmux(worktreePath, branch, signal);

	// Register in metadata
	const record: ManagedRecord = {
		branch,
		path: worktreePath,
		baseBranch: baseBranch || (await getCurrentBranch(gitRoot)),
		createdAt: Date.now(),
		tmuxSession: isInsideTmux() ? await getCurrentTmuxSession() || undefined : tmuxRes.tmuxTarget,
		tmuxWindowId: isInsideTmux() ? tmuxRes.tmuxTarget : undefined,
		tmuxWindowIndex: tmuxRes.windowIndex,
	};
	await registerManagedWorktree(gitRoot, record);

	return {
		success: true,
		worktreePath,
		branch,
		tmuxTarget: tmuxRes.tmuxTarget,
		windowIndex: tmuxRes.windowIndex,
		isInsideTmux: isInsideTmux(),
		error: tmuxRes.error,
	};
}

interface CleanWorktreesResult {
	cleaned: Array<{ branch: string; path: string }>;
	failed: Array<{ branch: string; error: string }>;
}

async function cleanManagedWorktrees(gitRoot: string): Promise<CleanWorktreesResult> {
	const reg = await loadRegistry(gitRoot);
	const entries = Object.values(reg.worktrees);

	const cleaned: Array<{ branch: string; path: string }> = [];
	const failed: Array<{ branch: string; error: string }> = [];

	for (const rec of entries) {
		try {
			// 1. Kill tmux window / session
			if (rec.tmuxWindowId) {
				await killTmuxTarget(rec.tmuxWindowId);
			}
			if (rec.tmuxSession) {
				await killTmuxTarget(rec.tmuxSession);
			}
			// Also kill by name convention
			await killTmuxTarget(`wt:${sanitizeBranchForPath(rec.branch)}`);
			await killTmuxTarget(`pi-wt-${sanitizeBranchForPath(rec.branch)}`);

			// 2. Remove git worktree
			const rmRes = await exec("git", ["worktree", "remove", "--force", rec.path], gitRoot);
			if (rmRes.exitCode !== 0) {
				// If git worktree remove fails, try deleting directory manually
				try {
					await fs.promises.rm(rec.path, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}

			// 3. Delete git branch
			await exec("git", ["branch", "-D", rec.branch], gitRoot);

			// 4. Remove from registry
			await unregisterManagedWorktree(gitRoot, rec.branch);

			cleaned.push({ branch: rec.branch, path: rec.path });
		} catch (err: any) {
			failed.push({ branch: rec.branch, error: err.message || String(err) });
		}
	}

	// Prune git worktree administrative files
	await exec("git", ["worktree", "prune"], gitRoot);

	return { cleaned, failed };
}

async function removeSingleWorktree(
	gitRoot: string,
	branch: string,
	deleteBranch = true,
): Promise<{ success: boolean; error?: string }> {
	const statuses = await getAllWorktreeStatuses(gitRoot);
	const target = statuses.find((s) => s.branch === branch);

	if (!target) {
		return { success: false, error: `Worktree for branch "${branch}" not found` };
	}
	if (target.isMain) {
		return { success: false, error: "Cannot remove the main repository worktree" };
	}

	// 1. Kill tmux window/session if active
	if (target.tmuxTarget) {
		await killTmuxTarget(target.tmuxTarget);
	}
	await killTmuxTarget(`wt:${sanitizeBranchForPath(branch)}`);
	await killTmuxTarget(`pi-wt-${sanitizeBranchForPath(branch)}`);

	// 2. Remove git worktree
	const rmRes = await exec("git", ["worktree", "remove", "--force", target.path], gitRoot);
	if (rmRes.exitCode !== 0) {
		try {
			await fs.promises.rm(target.path, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	}

	// 3. Delete branch
	if (deleteBranch) {
		await exec("git", ["branch", "-D", branch], gitRoot);
	}

	// 4. Remove from registry
	await unregisterManagedWorktree(gitRoot, branch);

	// 5. Prune
	await exec("git", ["worktree", "prune"], gitRoot);

	return { success: true };
}

async function renameWorktreeBranch(
	gitRoot: string,
	oldBranch: string,
	newBranch: string,
): Promise<{ success: boolean; error?: string }> {
	const branchExists = await checkBranchExists(gitRoot, oldBranch);
	if (!branchExists) {
		return { success: false, error: `Branch "${oldBranch}" does not exist` };
	}

	const newExists = await checkBranchExists(gitRoot, newBranch);
	if (newExists) {
		return { success: false, error: `Branch "${newBranch}" already exists` };
	}

	// Rename git branch
	const res = await exec("git", ["branch", "-m", oldBranch, newBranch], gitRoot);
	if (res.exitCode !== 0) {
		return { success: false, error: res.stderr || "Failed to rename git branch" };
	}

	// Update registry
	await renameManagedWorktreeRecord(gitRoot, oldBranch, newBranch);

	// If in tmux, attempt to rename window
	if (isInsideTmux()) {
		const oldWindowName = `wt:${sanitizeBranchForPath(oldBranch)}`;
		const newWindowName = `wt:${sanitizeBranchForPath(newBranch)}`;
		await exec("tmux", ["rename-window", "-t", oldWindowName, newWindowName]);
	}

	return { success: true };
}

// ---------------------------------------------------------------------------
// Interactive UI Menus & Output Formatting
// ---------------------------------------------------------------------------

function formatWorktreeListText(statuses: FullWorktreeStatus[]): string {
	if (statuses.length === 0) return "No worktrees found.";

	const lines: string[] = ["Git Worktrees:", ""];
	for (const wt of statuses) {
		const branchStr = wt.branch || "(detached)";
		const badge = wt.isMain ? "[main]" : wt.isManaged ? "[managed]" : "[external]";
		const tmuxBadge = wt.tmuxActive ? "⚡ tmux:active" : "";

		lines.push(`• ${branchStr} ${badge} ${tmuxBadge}`.trim());
		lines.push(`  Path: ${wt.path}`);
		if (wt.commit) {
			lines.push(`  Commit: ${wt.commit.slice(0, 8)}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

async function showInteractiveWorktreeMenu(ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	const choices = [
		"➕ Create new worktree",
		"📋 List all worktrees",
		"🔀 Switch/attach to worktree",
		"✏️  Rename worktree branch",
		"🗑️  Remove a worktree",
		"🧹 Clean up all managed worktrees",
		"❓ Help",
	];

	const selected = await ctx.ui.select("Worktree Management", choices);
	if (!selected) return;

	if (selected.startsWith("➕")) {
		const branch = await ctx.ui.input("Enter new branch name for worktree:");
		if (!branch || !branch.trim()) return;
		await handleCreateCommand(branch.trim(), ctx, gitRoot);
	} else if (selected.startsWith("📋")) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		ctx.ui.notify(formatWorktreeListText(statuses), "info");
	} else if (selected.startsWith("🔀")) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const nonMain = statuses.filter((s) => !s.isMain && s.branch);
		if (nonMain.length === 0) {
			ctx.ui.notify("No other worktrees available to switch to", "warning");
			return;
		}
		const branchChoice = await ctx.ui.select(
			"Select worktree to switch to:",
			nonMain.map((s) => s.branch!),
		);
		if (branchChoice) {
			await handleSwitchCommand(branchChoice, ctx, gitRoot);
		}
	} else if (selected.startsWith("✏️")) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const nonMain = statuses.filter((s) => !s.isMain && s.branch);
		if (nonMain.length === 0) {
			ctx.ui.notify("No worktrees available to rename", "warning");
			return;
		}
		const oldBranch = await ctx.ui.select(
			"Select branch to rename:",
			nonMain.map((s) => s.branch!),
		);
		if (!oldBranch) return;
		const newBranch = await ctx.ui.input(`Enter new name for branch "${oldBranch}":`);
		if (!newBranch || !newBranch.trim()) return;
		await handleRenameCommand(`${oldBranch} ${newBranch.trim()}`, ctx, gitRoot);
	} else if (selected.startsWith("🗑️")) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const nonMain = statuses.filter((s) => !s.isMain && s.branch);
		if (nonMain.length === 0) {
			ctx.ui.notify("No worktrees available to remove", "warning");
			return;
		}
		const branchToRemove = await ctx.ui.select(
			"Select worktree to remove:",
			nonMain.map((s) => s.branch!),
		);
		if (branchToRemove) {
			await handleRemoveCommand(branchToRemove, ctx, gitRoot);
		}
	} else if (selected.startsWith("🧹")) {
		await handleCleanCommand(ctx, gitRoot);
	} else if (selected.startsWith("❓")) {
		showHelp(ctx);
	}
}

function showHelp(ctx: ExtensionContext): void {
	const helpText = [
		"🌿 Worktree Management Commands:",
		"",
		"  /worktree <branch>               Create worktree & run pi agent in tmux without prompt",
		"  /worktree create <branch> [base] Create worktree from base branch & run pi in tmux",
		"  /worktree list                   List all worktrees, managed status, and tmux state",
		"  /worktree clean                  Clean up all managed worktrees and branches",
		"  /worktree remove [branch]        Remove specific worktree and delete branch",
		"  /worktree rename <old> <new>     Rename worktree branch",
		"  /worktree switch [branch]        Switch/attach to worktree's tmux window/session",
		"  /worktree help                   Show this help message",
		"",
		"💡 Shorthand aliases: /worktrees, /worktree-clean, /worktree-remove, /worktree-rename",
	].join("\n");

	ctx.ui.notify(helpText, "info");
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

async function handleCreateCommand(args: string, ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const branch = parts[0];
	const baseBranch = parts[1];

	if (!branch) {
		ctx.ui.notify("Usage: /worktree <branch-name> [base-branch]", "error");
		return;
	}

	ctx.ui.notify(`Creating worktree for "${branch}" and launching pi in tmux...`, "info");

	const res = await createWorktreeAndSpawnPi(gitRoot, { branch, baseBranch });
	if (!res.success) {
		ctx.ui.notify(`Failed to create worktree: ${res.error}`, "error");
		return;
	}

	let msg = `✓ Created worktree "${branch}"\n  Path: ${res.worktreePath}\n`;
	if (res.isInsideTmux) {
		const winHint = res.windowIndex !== undefined ? ` (Window ${res.windowIndex})` : "";
		msg += `  Tmux: New window opened${winHint}.\n  Switch with: tmux select-window -t ${res.tmuxTarget || `wt:${sanitizeBranchForPath(branch)}`}`;
	} else {
		msg += `  Tmux: Session "${res.tmuxTarget}" created.\n  Attach with: tmux attach -t ${res.tmuxTarget}`;
	}

	ctx.ui.notify(msg, "info");
}

async function handleListCommand(ctx: ExtensionContext, gitRoot: string): Promise<void> {
	const statuses = await getAllWorktreeStatuses(gitRoot);
	ctx.ui.notify(formatWorktreeListText(statuses), "info");
}

async function handleCleanCommand(ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	const reg = await loadRegistry(gitRoot);
	const managedCount = Object.keys(reg.worktrees).length;

	if (managedCount === 0) {
		ctx.ui.notify("No managed worktrees to clean up.", "info");
		return;
	}

	const listPreview = Object.values(reg.worktrees)
		.map((w) => `  • ${w.branch} (${w.path})`)
		.join("\n");

	const ok = await ctx.ui.confirm(
		"Clean up worktrees & branches?",
		`This will permanently remove ${managedCount} managed worktree(s) and delete their git branches:\n\n${listPreview}`,
	);

	if (!ok) {
		ctx.ui.notify("Cleanup cancelled.", "info");
		return;
	}

	ctx.ui.notify("Cleaning up worktrees...", "info");
	const result = await cleanManagedWorktrees(gitRoot);

	const summaryLines: string[] = ["Cleanup Complete:"];
	for (const c of result.cleaned) {
		summaryLines.push(`  ✓ Removed ${c.branch}`);
	}
	for (const f of result.failed) {
		summaryLines.push(`  ✗ ${f.branch}: ${f.error}`);
	}

	ctx.ui.notify(summaryLines.join("\n"), result.failed.length > 0 ? "warning" : "info");
}

async function handleRemoveCommand(args: string, ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	let branch = args.trim();

	if (!branch) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const nonMain = statuses.filter((s) => !s.isMain && s.branch);
		if (nonMain.length === 0) {
			ctx.ui.notify("No worktrees available to remove.", "warning");
			return;
		}
		const chosen = await ctx.ui.select(
			"Select worktree to remove:",
			nonMain.map((s) => s.branch!),
		);
		if (!chosen) return;
		branch = chosen;
	}

	const ok = await ctx.ui.confirm(
		`Remove worktree "${branch}"?`,
		`This will delete the worktree directory and branch "${branch}".`,
	);

	if (!ok) {
		ctx.ui.notify("Removal cancelled.", "info");
		return;
	}

	const res = await removeSingleWorktree(gitRoot, branch, true);
	if (!res.success) {
		ctx.ui.notify(`Failed to remove worktree: ${res.error}`, "error");
		return;
	}

	ctx.ui.notify(`✓ Successfully removed worktree and branch "${branch}".`, "info");
}

async function handleRenameCommand(args: string, ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	const parts = args.trim().split(/\s+/);
	let oldBranch = parts[0];
	let newBranch = parts[1];

	if (!oldBranch || !newBranch) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const nonMain = statuses.filter((s) => !s.isMain && s.branch);
		if (nonMain.length === 0) {
			ctx.ui.notify("No worktrees available to rename.", "warning");
			return;
		}

		if (!oldBranch) {
			const chosen = await ctx.ui.select(
				"Select branch to rename:",
				nonMain.map((s) => s.branch!),
			);
			if (!chosen) return;
			oldBranch = chosen;
		}

		if (!newBranch) {
			const entered = await ctx.ui.input(`Enter new branch name for "${oldBranch}":`);
			if (!entered || !entered.trim()) return;
			newBranch = entered.trim();
		}
	}

	const res = await renameWorktreeBranch(gitRoot, oldBranch, newBranch);
	if (!res.success) {
		ctx.ui.notify(`Failed to rename branch: ${res.error}`, "error");
		return;
	}

	ctx.ui.notify(`✓ Renamed branch "${oldBranch}" → "${newBranch}".`, "info");
}

async function handleSwitchCommand(args: string, ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	let branch = args.trim();

	if (!branch) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const nonMain = statuses.filter((s) => !s.isMain && s.branch);
		if (nonMain.length === 0) {
			ctx.ui.notify("No worktrees available.", "warning");
			return;
		}
		const chosen = await ctx.ui.select(
			"Select worktree to switch to:",
			nonMain.map((s) => s.branch!),
		);
		if (!chosen) return;
		branch = chosen;
	}

	const statuses = await getAllWorktreeStatuses(gitRoot);
	const target = statuses.find((s) => s.branch === branch);

	if (!target) {
		ctx.ui.notify(`Worktree for branch "${branch}" not found.`, "error");
		return;
	}

	if (isInsideTmux()) {
		const windowTarget = target.tmuxTarget || `wt:${sanitizeBranchForPath(branch)}`;
		const swRes = await switchToTmuxTarget(windowTarget);
		if (swRes.success) {
			ctx.ui.notify(`Switched to tmux window for "${branch}".`, "info");
		} else {
			// If window doesn't exist, spawn one
			const spawnRes = await spawnPiInTmux(target.path, branch);
			if (spawnRes.success && spawnRes.tmuxTarget) {
				await switchToTmuxTarget(spawnRes.tmuxTarget);
				ctx.ui.notify(`Launched pi in tmux window and switched to "${branch}".`, "info");
			} else {
				ctx.ui.notify(`Failed to switch window: ${swRes.error || spawnRes.error}`, "error");
			}
		}
	} else {
		const sessionName = target.tmuxTarget || `pi-wt-${sanitizeBranchForPath(branch)}`;
		ctx.ui.notify(`Run this in your terminal to attach:\n  tmux attach -t ${sessionName}`, "info");
	}
}

// ---------------------------------------------------------------------------
// Argument Autocompletion
// ---------------------------------------------------------------------------

async function getWorktreeArgumentCompletions(
	prefix: string,
	gitRoot: string | null,
): Promise<AutocompleteItem[] | null> {
	const subcommands = [
		{ value: "create", label: "create <branch>", description: "Create worktree & run pi" },
		{ value: "list", label: "list", description: "List all worktrees" },
		{ value: "clean", label: "clean", description: "Clean up managed worktrees & branches" },
		{ value: "remove", label: "remove <branch>", description: "Remove worktree & delete branch" },
		{ value: "rename", label: "rename <old> <new>", description: "Rename worktree branch" },
		{ value: "switch", label: "switch <branch>", description: "Switch/attach to worktree" },
		{ value: "help", label: "help", description: "Show help" },
	];

	const trimmed = prefix.trimStart();
	const parts = trimmed.split(/\s+/);

	if (parts.length <= 1) {
		const matchPrefix = parts[0] || "";
		const matches = subcommands.filter((s) => s.value.startsWith(matchPrefix));

		// Also suggest existing branches if git root is available
		if (gitRoot) {
			const statuses = await getAllWorktreeStatuses(gitRoot);
			const branchMatches = statuses
				.filter((s) => !s.isMain && s.branch && s.branch.startsWith(matchPrefix))
				.map((s) => ({
					value: s.branch!,
					label: s.branch!,
					description: `Worktree at ${s.path}`,
				}));
			matches.push(...branchMatches);
		}

		return matches.length > 0 ? matches : null;
	}

	// Subcommand argument completion (e.g. /worktree remove <tab>, /worktree switch <tab>)
	const sub = parts[0].toLowerCase();
	const subArg = parts[1] || "";

	if (["remove", "rm", "delete", "switch", "attach", "rename"].includes(sub) && gitRoot) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const branchMatches = statuses
			.filter((s) => !s.isMain && s.branch && s.branch.startsWith(subArg))
			.map((s) => ({
				value: `${sub} ${s.branch!}`,
				label: s.branch!,
				description: s.path,
			}));
		return branchMatches.length > 0 ? branchMatches : null;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Main Extension Export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Synchronize session entries
	pi.on("session_start", async (_event, ctx) => {
		// Session start lifecycle
	});

	// Primary command: /worktree
	pi.registerCommand("worktree", {
		description: "Manage git worktrees with tmux (create, list, clean, remove, rename, switch)",
		getArgumentCompletions: async (prefix) => {
			const gitRoot = await getGitRoot(process.cwd());
			return getWorktreeArgumentCompletions(prefix, gitRoot);
		},
		handler: async (args, ctx) => {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				ctx.ui.notify("Error: Current directory is not inside a git repository.", "error");
				return;
			}

			const trimmed = args.trim();

			// If no argument provided, open interactive menu
			if (!trimmed) {
				await showInteractiveWorktreeMenu(ctx, gitRoot);
				return;
			}

			const parts = trimmed.split(/\s+/);
			const sub = parts[0].toLowerCase();
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "create":
				case "add":
				case "new":
					await handleCreateCommand(rest, ctx, gitRoot);
					break;

				case "list":
				case "ls":
					await handleListCommand(ctx, gitRoot);
					break;

				case "clean":
				case "cleanup":
				case "prune":
					await handleCleanCommand(ctx, gitRoot);
					break;

				case "remove":
				case "rm":
				case "del":
				case "delete":
					await handleRemoveCommand(rest, ctx, gitRoot);
					break;

				case "rename":
				case "mv":
					await handleRenameCommand(rest, ctx, gitRoot);
					break;

				case "switch":
				case "attach":
				case "go":
					await handleSwitchCommand(rest, ctx, gitRoot);
					break;

				case "help":
				case "--help":
				case "-h":
					showHelp(ctx);
					break;

				default:
					// Direct branch creation: /worktree <branch-name> [base-branch]
					await handleCreateCommand(trimmed, ctx, gitRoot);
					break;
			}
		},
	});

	// Dedicated Aliases
	pi.registerCommand("worktrees", {
		description: "List all git worktrees (alias for /worktree list)",
		handler: async (_args, ctx) => {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				ctx.ui.notify("Error: Not inside a git repository.", "error");
				return;
			}
			await handleListCommand(ctx, gitRoot);
		},
	});

	pi.registerCommand("worktree-clean", {
		description: "Clean up managed worktrees and branches (alias for /worktree clean)",
		handler: async (_args, ctx) => {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				ctx.ui.notify("Error: Not inside a git repository.", "error");
				return;
			}
			await handleCleanCommand(ctx, gitRoot);
		},
	});

	pi.registerCommand("worktree-remove", {
		description: "Remove a worktree and its branch (alias for /worktree remove)",
		handler: async (args, ctx) => {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				ctx.ui.notify("Error: Not inside a git repository.", "error");
				return;
			}
			await handleRemoveCommand(args, ctx, gitRoot);
		},
	});

	pi.registerCommand("worktree-rename", {
		description: "Rename a worktree's branch (alias for /worktree rename)",
		handler: async (args, ctx) => {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				ctx.ui.notify("Error: Not inside a git repository.", "error");
				return;
			}
			await handleRenameCommand(args, ctx, gitRoot);
		},
	});

	// -------------------------------------------------------------------------
	// LLM Tools for Agent Invocation
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "worktree_create",
		label: "Create Worktree",
		description: "Create a new git worktree with a pi agent running in tmux without prompt",
		promptSnippet: "Create a git worktree and start pi agent in tmux",
		promptGuidelines: [
			"Use worktree_create when the user asks to create an isolated worktree for a branch or feature.",
		],
		parameters: Type.Object({
			branchName: Type.String({ description: "Name of the new branch and worktree" }),
			baseBranch: Type.Optional(Type.String({ description: "Optional base branch to branch off from" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				return {
					content: [{ type: "text", text: "Error: Not inside a git repository." }],
					isError: true,
				};
			}

			const res = await createWorktreeAndSpawnPi(gitRoot, {
				branch: params.branchName,
				baseBranch: params.baseBranch,
				signal,
			});

			if (!res.success) {
				return {
					content: [{ type: "text", text: `Failed to create worktree: ${res.error}` }],
					isError: true,
				};
			}

			const outputText = [
				`Successfully created worktree for branch "${res.branch}"`,
				`Path: ${res.worktreePath}`,
				res.isInsideTmux
					? `Tmux Window: ${res.tmuxTarget || `wt:${params.branchName}`}`
					: `Tmux Session: ${res.tmuxTarget}`,
				"Pi is running in the worktree in interactive mode.",
			].join("\n");

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					worktreePath: res.worktreePath,
					branch: res.branch,
					tmuxTarget: res.tmuxTarget,
				},
			};
		},
	});

	pi.registerTool({
		name: "worktree_list",
		label: "List Worktrees",
		description: "List all git worktrees with their branches and tmux status",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				return {
					content: [{ type: "text", text: "Error: Not inside a git repository." }],
					isError: true,
				};
			}

			const statuses = await getAllWorktreeStatuses(gitRoot);
			const formatted = formatWorktreeListText(statuses);

			return {
				content: [{ type: "text", text: formatted }],
				details: { worktrees: statuses },
			};
		},
	});

	pi.registerTool({
		name: "worktree_clean",
		label: "Clean Worktrees",
		description: "Clean up managed git worktrees and delete their branches",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				return {
					content: [{ type: "text", text: "Error: Not inside a git repository." }],
					isError: true,
				};
			}

			const result = await cleanManagedWorktrees(gitRoot);
			const cleanedSummary = result.cleaned.map((c) => `Removed ${c.branch} (${c.path})`).join("\n");
			const failedSummary = result.failed.map((f) => `Failed ${f.branch}: ${f.error}`).join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Cleaned ${result.cleaned.length} worktree(s).\n${cleanedSummary}${failedSummary ? `\n${failedSummary}` : ""}`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "worktree_remove",
		label: "Remove Worktree",
		description: "Remove a specific git worktree and delete its branch",
		parameters: Type.Object({
			branchName: Type.String({ description: "Name of the branch to remove" }),
			deleteBranch: Type.Optional(Type.Boolean({ description: "Whether to delete the git branch (default: true)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				return {
					content: [{ type: "text", text: "Error: Not inside a git repository." }],
					isError: true,
				};
			}

			const res = await removeSingleWorktree(gitRoot, params.branchName, params.deleteBranch ?? true);
			if (!res.success) {
				return {
					content: [{ type: "text", text: `Failed to remove worktree: ${res.error}` }],
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: `Successfully removed worktree for "${params.branchName}".` }],
				details: { branch: params.branchName },
			};
		},
	});

	pi.registerTool({
		name: "worktree_rename",
		label: "Rename Worktree Branch",
		description: "Rename a git worktree's branch",
		parameters: Type.Object({
			oldBranch: Type.String({ description: "Current branch name" }),
			newBranch: Type.String({ description: "New branch name" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gitRoot = await getGitRoot(ctx.cwd);
			if (!gitRoot) {
				return {
					content: [{ type: "text", text: "Error: Not inside a git repository." }],
					isError: true,
				};
			}

			const res = await renameWorktreeBranch(gitRoot, params.oldBranch, params.newBranch);
			if (!res.success) {
				return {
					content: [{ type: "text", text: `Failed to rename branch: ${res.error}` }],
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Successfully renamed branch "${params.oldBranch}" to "${params.newBranch}".`,
					},
				],
				details: { oldBranch: params.oldBranch, newBranch: params.newBranch },
			};
		},
	});
}
