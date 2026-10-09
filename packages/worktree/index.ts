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
 *   /worktree [branch]                - Create worktree & run pi, or open the fuzzy-search command menu if no args.
 *                                     Sessions is one menu choice. Inside a git repo it uses a /resume-style picker.
 *                                     Outside a git repo, that choice opens the usual session list.
 *   /worktree create <branch> [base]  - Create new worktree (optionally from base branch) & run pi
 *   /worktree list                    - List all worktrees with managed & tmux status
 *   /worktree sessions                - Resume a session from any recorded worktree, even if that checkout is gone.
 *                                     Tab switches the current folder and all recorded worktrees. Search, sort,
 *                                     and filter by branch or worktree name. Outside a git repo, opens the usual session list.
 *   /worktree clean                   - Clean up all managed worktrees and their branches
 *   /worktree remove [branch]         - Remove a specific worktree and delete its branch
 *   /worktree rename [old] [new]      - Rename a worktree's branch
 *   /worktree switch [branch]         - Switch/attach to a worktree's tmux window or session
 *   /worktree rebase [branch]         - Rebase local main/master onto current/selected topic worktree; Pi resolves conflicts
 *   /worktree tip [branch]            - Rebase current/selected topic worktree onto local main/master; Pi resolves conflicts
 *   /worktree pr [branch]             - Select a worktree, rebase onto remote main/master, create PR, and ensure green CI
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
import * as os from "node:os";
import * as path from "node:path";
import {
	SessionManager,
	SessionSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { routeWorktreeCommand } from "./route.ts";
import { selectWorktreeCommand } from "./command-menu.ts";
import { handleWorktreeRebase, handleWorktreeTip, isRebaseTarget } from "./rebase.ts";
import { WorktreePrWorkflow } from "./pr.ts";
import { WorktreeSessionSelector, renameSessionFile } from "./session-picker.ts";
import { toWorktreeSessionRow, type WorktreeSessionRow } from "./session-query.ts";

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

/** A worktree path recorded at creation. Kept after the checkout is removed. */
interface KnownWorktree {
	branch: string;
	path: string;
	baseBranch?: string;
	createdAt: number;
}

interface RegistryData {
	version: 1;
	/** Worktrees the extension currently manages. Removed on /worktree remove and clean. */
	worktrees: Record<string, ManagedRecord>;
	/** Every worktree this extension has created. Never deleted, so its sessions stay reachable. */
	known: KnownWorktree[];
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

/**
 * Main worktree root for this repository.
 * Linked worktrees report their own toplevel; the registry has to live on the
 * main checkout so it is still readable after one of those checkouts is removed.
 */
async function getGitRoot(cwd: string): Promise<string | null> {
	const main = await resolveMainGitRoot(cwd);
	if (!main) return null;
	await mergeLinkedCheckoutRegistry(cwd, main);
	return main;
}

async function resolveMainGitRoot(cwd: string): Promise<string | null> {
	const absolute = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	let commonRaw = absolute.exitCode === 0 ? absolute.stdout : "";
	if (!commonRaw) {
		const relative = await exec("git", ["rev-parse", "--git-common-dir"], cwd);
		if (relative.exitCode === 0) commonRaw = relative.stdout;
	}
	if (commonRaw) {
		const commonDir = path.resolve(cwd, commonRaw);
		if (path.basename(commonDir) === ".git") return path.dirname(commonDir);
	}
	const top = await exec("git", ["rev-parse", "--show-toplevel"], cwd);
	return top.exitCode === 0 && top.stdout ? top.stdout : null;
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

function recordToKnown(record: ManagedRecord): KnownWorktree {
	return {
		branch: record.branch,
		path: record.path,
		baseBranch: record.baseBranch,
		createdAt: record.createdAt,
	};
}

function isKnownWorktree(value: unknown): value is KnownWorktree {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<KnownWorktree>;
	return typeof record.branch === "string" && typeof record.path === "string" && typeof record.createdAt === "number";
}

function canonicalPath(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

function sameDirectory(a: string, b: string): boolean {
	if (!a || !b) return false;
	try {
		return canonicalPath(a) === canonicalPath(b);
	} catch {
		return false;
	}
}

function resolveUserPath(input: string, base: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(base, trimmed);
}

function directoryExists(dir: string): boolean {
	try {
		return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function upsertKnownWorktree(reg: RegistryData, record: ManagedRecord): boolean {
	const existing = reg.known.find((known) => sameDirectory(known.path, record.path));
	if (existing) {
		let changed = false;
		if (existing.branch !== record.branch) {
			existing.branch = record.branch;
			changed = true;
		}
		if (record.baseBranch && existing.baseBranch !== record.baseBranch) {
			existing.baseBranch = record.baseBranch;
			changed = true;
		}
		return changed;
	}
	reg.known.push(recordToKnown(record));
	return true;
}

async function loadRegistry(gitRoot: string): Promise<RegistryData> {
	const filePath = getRegistryFilePath(gitRoot);
	try {
		const raw = await fs.promises.readFile(filePath, "utf-8");
		const data = JSON.parse(raw) as Partial<RegistryData> | null;
		if (data && data.version === 1 && data.worktrees && typeof data.worktrees === "object") {
			const hadKnown = Array.isArray(data.known);
			const known = hadKnown
				? data.known!.filter(isKnownWorktree)
				: Object.values(data.worktrees).map(recordToKnown);
			const reg: RegistryData = { version: 1, worktrees: data.worktrees, known };
			// Older registries only stored active worktrees. Keep those paths for sessions.
			if (!hadKnown) {
				await saveRegistry(gitRoot, reg);
			}
			return reg;
		}
	} catch {
		// File does not exist or invalid
	}
	return { version: 1, worktrees: {}, known: [] };
}

function asManagedRecord(value: unknown): ManagedRecord | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<ManagedRecord>;
	if (typeof record.branch !== "string" || typeof record.path !== "string") return null;
	return {
		branch: record.branch,
		path: record.path,
		baseBranch: typeof record.baseBranch === "string" ? record.baseBranch : undefined,
		createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
		tmuxSession: typeof record.tmuxSession === "string" ? record.tmuxSession : undefined,
		tmuxWindowId: typeof record.tmuxWindowId === "string" ? record.tmuxWindowId : undefined,
		tmuxWindowIndex: typeof record.tmuxWindowIndex === "number" ? record.tmuxWindowIndex : undefined,
	};
}

/**
 * Older builds stored `.pi/worktrees.json` in whichever checkout ran the command.
 * Copy that into the main checkout once so removed linked worktrees stay listed.
 */
async function mergeLinkedCheckoutRegistry(cwd: string, mainRoot: string): Promise<void> {
	const top = await exec("git", ["rev-parse", "--show-toplevel"], cwd);
	if (top.exitCode !== 0 || !top.stdout) return;
	if (sameDirectory(top.stdout, mainRoot)) return;

	let parsed: Partial<RegistryData> | null = null;
	try {
		const raw = await fs.promises.readFile(getRegistryFilePath(top.stdout), "utf-8");
		parsed = JSON.parse(raw) as Partial<RegistryData>;
	} catch {
		return;
	}
	if (!parsed || parsed.version !== 1 || !parsed.worktrees || typeof parsed.worktrees !== "object") return;

	const incomingActive = Object.values(parsed.worktrees)
		.map(asManagedRecord)
		.filter((record): record is ManagedRecord => record !== null);
	const incomingKnown = Array.isArray(parsed.known)
		? parsed.known.map(asManagedRecord).filter((record): record is ManagedRecord => record !== null)
		: incomingActive;
	if (incomingActive.length === 0 && incomingKnown.length === 0) return;

	const reg = await loadRegistry(mainRoot);
	let changed = false;
	for (const record of incomingActive) {
		if (!reg.worktrees[record.branch]) {
			reg.worktrees[record.branch] = record;
			changed = true;
		}
		if (upsertKnownWorktree(reg, record)) changed = true;
	}
	for (const record of incomingKnown) {
		if (upsertKnownWorktree(reg, record)) changed = true;
	}
	if (changed) await saveRegistry(mainRoot, reg);
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
	upsertKnownWorktree(reg, record);
	await saveRegistry(gitRoot, reg);
}

async function unregisterManagedWorktree(gitRoot: string, branch: string): Promise<void> {
	const reg = await loadRegistry(gitRoot);
	delete reg.worktrees[branch];
	await saveRegistry(gitRoot, reg);
}

async function renameManagedWorktreeRecord(gitRoot: string, oldBranch: string, newBranch: string): Promise<void> {
	const reg = await loadRegistry(gitRoot);
	const rec = reg.worktrees[oldBranch];
	if (rec) {
		rec.branch = newBranch;
		delete reg.worktrees[oldBranch];
		reg.worktrees[newBranch] = rec;
	}
	let changed = Boolean(rec);
	for (const known of reg.known) {
		const matchesRecord = rec ? sameDirectory(known.path, rec.path) : false;
		if (matchesRecord || (!rec && known.branch === oldBranch)) {
			known.branch = newBranch;
			changed = true;
		}
	}
	if (changed) {
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
	// display-message can succeed with empty output for a missing target.
	return res.exitCode === 0 && /^@\d+$/.test(res.stdout);
}

async function checkTmuxSessionExists(sessionName: string): Promise<boolean> {
	const res = await exec("tmux", ["has-session", "-t", sessionName]);
	return res.exitCode === 0;
}

/** Close worktree windows by ID; never kill the shared session that hosts them. */
async function closeWorktreeTmuxWindows(worktreePath: string, record?: ManagedRecord): Promise<void> {
	const panes = await exec("tmux", [
		"list-panes", "-a", "-F", "#{window_id}\t#{session_name}\t#{window_name}\t#{pane_current_path}",
	]);
	if (panes.exitCode !== 0) {
		// No tmux installation/server means there are no windows to close.
		if (!(await isTmuxAvailable()) || /no server running|No such file or directory/i.test(panes.stderr)) return;
		throw new Error(`Cannot list tmux windows: ${panes.stderr || panes.stdout}`);
	}

	const root = canonicalPath(worktreePath);
	const windows = new Set<string>();
	for (const line of panes.stdout.split("\n")) {
		const [windowId, sessionName, windowName, panePath] = line.split("\t");
		if (!/^@\d+$/.test(windowId)) continue;
		const relative = panePath ? path.relative(root, canonicalPath(panePath)) : undefined;
		const inWorktree = relative !== undefined &&
			(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)));
		// Old creation fallbacks recorded the window name instead of its ID.
		// Compare literal names here: `wt:topic` is not a valid tmux target expression.
		const recordedWindow = record?.tmuxWindowId &&
			((record.tmuxWindowId === windowId && (!record.tmuxSession || record.tmuxSession === sessionName)) ||
				(record.tmuxWindowId === windowName && record.tmuxSession === sessionName));
		const dedicatedSession = record && !record.tmuxWindowId &&
			record.tmuxSession === `pi-wt-${sanitizeBranchForPath(record.branch)}` &&
			record.tmuxSession === sessionName;
		if (inWorktree || recordedWindow || dedicatedSession) windows.add(windowId);
	}

	for (const windowId of windows) {
		const result = await exec("tmux", ["kill-window", "-t", windowId]);
		// A window may have exited between discovery and cleanup.
		if (result.exitCode !== 0 && await checkTmuxWindowExists(windowId)) {
			throw new Error(`Cannot close tmux window ${windowId}: ${result.stderr || result.stdout}`);
		}
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
	/** Directory the command was run from. Used for the default base branch. */
	invokedFrom?: string;
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
	const { branch, baseBranch, invokedFrom, signal } = options;
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
		baseBranch: baseBranch || (await getCurrentBranch(invokedFrom || gitRoot)),
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
			// 1. Close only this worktree's tmux windows.
			await closeWorktreeTmuxWindows(rec.path, rec);

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

	// 1. Close its windows even when metadata is missing or the command runs outside tmux.
	try {
		await closeWorktreeTmuxWindows(target.path, target.managedRecord);
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}

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
// Worktree sessions
// ---------------------------------------------------------------------------

interface WorktreeSessionSource {
	branch: string;
	path: string;
}

/**
 * Paths whose sessions /worktree sessions should list.
 * Recorded worktrees win. `git worktree list` is used only when nothing has been written down.
 */
async function getSessionWorktreeSources(gitRoot: string): Promise<WorktreeSessionSource[]> {
	const reg = await loadRegistry(gitRoot);
	if (reg.known.length > 0) {
		const seen = new Set<string>();
		const sources: WorktreeSessionSource[] = [];
		for (const known of reg.known) {
			const resolved = canonicalPath(known.path);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			sources.push({ branch: known.branch, path: known.path });
		}
		return sources;
	}
	const gitWorktrees = await getGitWorktrees(gitRoot);
	return gitWorktrees
		.filter((wt) => !wt.bare && wt.path)
		.map((wt) => ({ branch: wt.branch ?? "(detached)", path: wt.path }));
}

function truncateText(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

async function listWorktreeSessions(
	gitRoot: string,
	signal?: AbortSignal,
	sessionDir?: string,
): Promise<WorktreeSessionRow[]> {
	const sources = await getSessionWorktreeSources(gitRoot);
	const listed: WorktreeSessionRow[] = [];
	for (const source of sources) {
		if (signal?.aborted) break;
		let sessions: SessionInfo[] = [];
		try {
			sessions = await SessionManager.list(source.path, sessionDir, undefined, signal);
		} catch {
			if (signal?.aborted) break;
			continue;
		}
		const missing = !directoryExists(source.path);
		for (const session of sessions) {
			listed.push(toWorktreeSessionRow(session, { branch: source.branch, path: source.path, missing }));
		}
	}
	listed.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
	return listed;
}

async function branchForDirectory(dir: string): Promise<string> {
	const res = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
	if (res.exitCode !== 0 || !res.stdout || res.stdout === "HEAD") return "(detached)";
	return res.stdout;
}

async function loadCurrentFolderRows(
	cwd: string,
	gitRoot: string,
	sessionDir: string | undefined,
	signal?: AbortSignal,
): Promise<WorktreeSessionRow[]> {
	const sessions = await SessionManager.list(cwd, sessionDir, undefined, signal);
	const sources = await getSessionWorktreeSources(gitRoot);
	const source = sources.find((item) => sameDirectory(item.path, cwd));
	const branch = source?.branch ?? (await branchForDirectory(cwd));
	return sessions
		.slice()
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.map((session) =>
			toWorktreeSessionRow(session, {
				branch,
				path: source?.path ?? cwd,
				missing: !directoryExists(source?.path ?? cwd),
			}),
		);
}

function formatSessionChoice(item: WorktreeSessionRow, index: number): string {
	const title = item.session.name?.trim() || truncateText(item.session.firstMessage, 48) || "(empty)";
	const when = item.session.modified.toISOString().slice(0, 16).replace("T", " ");
	const state = item.missing ? "missing" : "present";
	return `${index + 1}. ${item.branch} · ${item.worktreeName} [${state}] ${title} (${when})`;
}

interface DestinationChoice {
	label: string;
	path: string;
}

async function listResumeDestinations(gitRoot: string, currentCwd: string): Promise<DestinationChoice[]> {
	const choices: DestinationChoice[] = [];
	const add = (label: string, dir: string) => {
		if (!directoryExists(dir)) return;
		const resolved = canonicalPath(dir);
		if (choices.some((choice) => choice.path === resolved)) return;
		choices.push({ label, path: resolved });
	};

	add(`Current folder (${currentCwd})`, currentCwd);

	const reg = await loadRegistry(gitRoot);
	if (reg.known.length > 0) {
		for (const known of reg.known) {
			add(`${known.branch} (${known.path})`, known.path);
		}
	} else {
		const gitWorktrees = await getGitWorktrees(gitRoot);
		for (const wt of gitWorktrees) {
			if (wt.bare) continue;
			add(`${wt.branch ?? "(detached)"} (${wt.path})`, wt.path);
		}
	}
	return choices;
}

const OTHER_FOLDER_CHOICE = "Other folder...";

async function handleSessionsCommand(ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	const customDir = sessionUsesCustomDir(ctx) ? ctx.sessionManager.getSessionDir() : undefined;
	let picked: WorktreeSessionRow | null = null;

	if (ctx.mode === "tui") {
		picked = await ctx.ui.custom<WorktreeSessionRow | null>((tui, theme, keybindings, done) => {
			const visible = Math.max(8, (tui.terminal?.rows ?? 24) - 8);
			return new WorktreeSessionSelector({
				theme,
				keybindings,
				requestRender: () => tui.requestRender(),
				maxVisible: visible,
				currentSessionFilePath: ctx.sessionManager.getSessionFile() ?? undefined,
				loadCurrent: (signal) => loadCurrentFolderRows(ctx.cwd, gitRoot, ctx.sessionManager.getSessionDir(), signal),
				loadWorktrees: (signal) => listWorktreeSessions(gitRoot, signal, customDir),
				onSelect: (row) => done(row),
				onCancel: () => done(null),
				renameSession: async (sessionPath, nextName) => {
					await renameSessionFile(sessionPath, nextName);
				},
			});
		});
	} else {
		ctx.ui.notify("Loading worktree sessions...", "info");
		const sessions = await listWorktreeSessions(gitRoot, undefined, customDir);
		if (sessions.length === 0) {
			ctx.ui.notify("No sessions found for recorded worktrees.", "info");
			return;
		}
		const labels = sessions.map((session, index) => formatSessionChoice(session, index));
		const selected = await ctx.ui.select("Worktree sessions", labels);
		if (!selected) return;
		picked = sessions[labels.indexOf(selected)] ?? null;
	}
	if (!picked) return;

	const destinations = await listResumeDestinations(gitRoot, ctx.cwd);
	const destinationLabels = [...destinations.map((choice) => choice.label), OTHER_FOLDER_CHOICE];
	const destinationChoice = await ctx.ui.select(`Resume "${picked.branch}" in:`, destinationLabels);
	if (!destinationChoice) return;

	let destination = destinations.find((choice) => choice.label === destinationChoice)?.path;
	if (destinationChoice === OTHER_FOLDER_CHOICE) {
		const entered = await ctx.ui.input("Folder to resume in:", ctx.cwd);
		if (!entered?.trim()) return;
		destination = resolveUserPath(entered, ctx.cwd);
		if (!directoryExists(destination)) {
			ctx.ui.notify(`Not a directory: ${destination}`, "error");
			return;
		}
	}
	if (!destination) return;

	try {
		let sessionFile = picked.session.path;
		let resumedInPlace = false;
		if (sameDirectory(picked.session.cwd, destination)) {
			resumedInPlace = true;
		} else {
			const forked = SessionManager.forkFrom(picked.session.path, destination);
			const forkedFile = forked.getSessionFile();
			if (!forkedFile) {
				ctx.ui.notify("Fork did not produce a session file.", "error");
				return;
			}
			sessionFile = forkedFile;
		}

		const result = await ctx.switchSession(sessionFile, {
			withSession: async (next) => {
				const how = resumedInPlace ? "Resumed" : "Forked and resumed";
				next.ui.notify(`${how} in ${destination}`, "info");
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("Session switch cancelled.", "info");
		}
	} catch (err: any) {
		ctx.ui.notify(`Failed to resume session: ${err?.message || String(err)}`, "error");
	}
}

function sessionUsesCustomDir(ctx: ExtensionCommandContext): boolean {
	const manager = ctx.sessionManager as { usesDefaultSessionDir?: () => boolean };
	return manager.usesDefaultSessionDir?.() === false;
}

/**
 * Same picker `/resume` uses: current folder, with Tab for every session.
 * Used when this directory is not a git repository.
 */
async function handleFolderSessionsCommand(ctx: ExtensionCommandContext): Promise<void> {
	const currentFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const sessionDir = ctx.sessionManager.getSessionDir();
	const customDir = sessionUsesCustomDir(ctx);

	const selectedPath = await ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => {
		return new SessionSelectorComponent(
			(onProgress, signal) => SessionManager.list(ctx.cwd, sessionDir, onProgress, signal),
			(onProgress, signal) =>
				customDir
					? SessionManager.listAll(sessionDir, onProgress, signal)
					: SessionManager.listAll(onProgress, signal),
			(sessionPath) => done(sessionPath),
			() => done(null),
			() => done(null),
			() => tui.requestRender(),
			{
				showRenameHint: true,
				keybindings,
				renameSession: async (sessionFilePath, nextName) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					const mgr = SessionManager.open(sessionFilePath);
					mgr.appendSessionInfo(next);
				},
			},
			currentFile,
		);
	});
	if (!selectedPath) return;

	try {
		const result = await ctx.switchSession(selectedPath, {
			withSession: async (next) => {
				next.ui.notify("Resumed session", "info");
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("Session switch cancelled.", "info");
		}
	} catch (err: any) {
		ctx.ui.notify(`Failed to resume session: ${err?.message || String(err)}`, "error");
	}
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

function notifyNeedsGit(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Current directory is not inside a git repository.", "error");
}

async function showInteractiveWorktreeMenu(
	ctx: ExtensionCommandContext,
	gitRoot: string | null,
	pi: ExtensionAPI,
	handlePrCommand: (args: string, ctx: ExtensionCommandContext, root: string) => Promise<void>,
): Promise<void> {
	const selected = await selectWorktreeCommand(ctx);
	if (!selected) return;

	if (selected === "sessions") {
		if (gitRoot) await handleSessionsCommand(ctx, gitRoot);
		else await handleFolderSessionsCommand(ctx);
		return;
	}
	if (selected === "help") {
		showHelp(ctx);
		return;
	}
	if (!gitRoot) {
		notifyNeedsGit(ctx);
		return;
	}

	if (selected === "create") {
		const branch = await ctx.ui.input("Enter new branch name for worktree:");
		if (!branch || !branch.trim()) return;
		await handleCreateCommand(branch.trim(), ctx, gitRoot);
	} else if (selected === "list") {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		ctx.ui.notify(formatWorktreeListText(statuses), "info");
	} else if (selected === "switch") {
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
	} else if (selected === "rebase") {
		await handleRebaseCommand("", ctx, gitRoot, pi);
	} else if (selected === "tip") {
		await handleRebaseCommand("", ctx, gitRoot, pi, "tip");
	} else if (selected === "pr") {
		await handlePrCommand("", ctx, gitRoot);
	} else if (selected === "rename") {
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
	} else if (selected === "remove") {
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
	} else if (selected === "clean") {
		await handleCleanCommand(ctx, gitRoot);
	}
}

function showHelp(ctx: ExtensionContext): void {
	const helpText = [
		"🌿 Worktree Management Commands:",
		"",
		"  /worktree <branch>               Create worktree & run pi agent in tmux without prompt",
		"  /worktree create <branch> [base] Create worktree from base branch & run pi in tmux",
		"  /worktree list                   List all worktrees, managed status, and tmux state",
		"  /worktree                        Searchable menu: type to fuzzy-search commands, then Enter to select",
		"  /worktree sessions               Resume a session from a recorded worktree, even if it was removed",
		"                                   Tab: current folder / all worktrees. Search, sort, filter by branch or worktree",
		"                                   Outside a git repo, opens the usual session list",
		"  /worktree clean                  Clean up all managed worktrees and branches",
		"  /worktree remove [branch]        Remove specific worktree and delete branch",
		"  /worktree rename <old> <new>     Rename worktree branch",
		"  /worktree switch [branch]        Switch/attach to worktree's tmux window/session",
		"  /worktree rebase [branch]        Rebase local main/master onto the current/selected topic",
		"  /worktree tip [branch]           Rebase the current/selected topic onto local main/master",
		"                                   On main/master: select a topic. Pi resolves conflicts in either direction",
		"  /worktree pr [branch]            Select a topic worktree, rebase onto remote main/master, create PR",
		"                                   Use /skill:pr for the body; repair failures until CI is verified green",
		"  /worktree help                   Show this help message",
		"",
		"💡 Shorthand aliases: /worktrees, /worktree-clean, /worktree-remove, /worktree-rename",
	].join("\n");

	ctx.ui.notify(helpText, "info");
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

async function handleRebaseCommand(args: string, ctx: ExtensionCommandContext, gitRoot: string, pi: ExtensionAPI, command: "rebase" | "tip" = "rebase"): Promise<void> {
	const handler = command === "tip" ? handleWorktreeTip : handleWorktreeRebase;
	await handler(args, ctx, gitRoot, {
		git: (gitArgs, cwd) => exec("git", gitArgs, cwd),
		getWorktrees: getGitWorktrees,
		sendUserMessage: (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp" }),
	});
}

async function handleCreateCommand(args: string, ctx: ExtensionCommandContext, gitRoot: string): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const branch = parts[0];
	const baseBranch = parts[1];

	if (!branch) {
		ctx.ui.notify("Usage: /worktree <branch-name> [base-branch]", "error");
		return;
	}

	ctx.ui.notify(`Creating worktree for "${branch}" and launching pi in tmux...`, "info");

	const res = await createWorktreeAndSpawnPi(gitRoot, { branch, baseBranch, invokedFrom: ctx.cwd });
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
		{ value: "sessions", label: "sessions", description: "Browse worktree sessions and resume one" },
		{ value: "clean", label: "clean", description: "Clean up managed worktrees & branches" },
		{ value: "remove", label: "remove <branch>", description: "Remove worktree & delete branch" },
		{ value: "rename", label: "rename <old> <new>", description: "Rename worktree branch" },
		{ value: "switch", label: "switch <branch>", description: "Switch/attach to worktree" },
		{ value: "rebase", label: "rebase [branch]", description: "Rebase local main/master onto topic worktree; Pi resolves conflicts" },
		{ value: "tip", label: "tip [branch]", description: "Rebase topic worktree onto local main/master; Pi resolves conflicts" },
		{ value: "pr", label: "pr [branch]", description: "Remote-base rebase, create PR with /skill:pr, and verify green CI" },
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

	if (["remove", "rm", "delete", "switch", "attach", "rename", "rebase", "tip", "pr"].includes(sub) && gitRoot) {
		const statuses = await getAllWorktreeStatuses(gitRoot);
		const branchMatches = statuses
			.filter((s) => (["rebase", "tip", "pr"].includes(sub) ? isRebaseTarget(s) : !s.isMain) && s.branch && s.branch.startsWith(subArg))
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
	const prWorkflow = new WorktreePrWorkflow({
		run: (command, args, cwd) => exec(command, args, cwd),
		getWorktrees: getGitWorktrees,
		sendUserMessage: (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp" }),
	});
	const handlePrCommand = async (args: string, ctx: ExtensionCommandContext, root: string) => {
		await prWorkflow.start(args, ctx, root);
	};
	pi.on("session_start", () => prWorkflow.reset());
	pi.on("session_switch", () => prWorkflow.reset());
	pi.on("session_fork", () => prWorkflow.reset());
	pi.on("session_tree", () => prWorkflow.reset());
	pi.on("session_shutdown", () => prWorkflow.reset());
	pi.on("agent_before_settle", (event) => prWorkflow.beforeSettle(event.outcome, event.continue));

	// Primary command: /worktree
	pi.registerCommand("worktree", {
		description: "Manage git worktrees with tmux (create, list, sessions, clean, remove, rename, switch, rebase, tip, pr)",
		getArgumentCompletions: async (prefix) => {
			const gitRoot = await getGitRoot(process.cwd());
			return getWorktreeArgumentCompletions(prefix, gitRoot);
		},
		handler: async (args, ctx) => {
			const gitRoot = await getGitRoot(ctx.cwd);
			// Non-git behavior is decided in routeWorktreeCommand. Do not return early here.
			const route = routeWorktreeCommand(args, gitRoot);
			switch (route.type) {
				case "folder-sessions":
					await handleFolderSessionsCommand(ctx);
					return;
				case "need-git":
					ctx.ui.notify("Current directory is not inside a git repository.", "error");
					return;
				case "menu":
					await showInteractiveWorktreeMenu(ctx, route.gitRoot, pi, handlePrCommand);
					return;
				case "list":
					await handleListCommand(ctx, route.gitRoot);
					return;
				case "sessions":
					await handleSessionsCommand(ctx, route.gitRoot);
					return;
				case "clean":
					await handleCleanCommand(ctx, route.gitRoot);
					return;
				case "remove":
					await handleRemoveCommand(route.args, ctx, route.gitRoot);
					return;
				case "rename":
					await handleRenameCommand(route.args, ctx, route.gitRoot);
					return;
				case "switch":
					await handleSwitchCommand(route.args, ctx, route.gitRoot);
					return;
				case "rebase":
					await handleRebaseCommand(route.args, ctx, route.gitRoot, pi);
					return;
				case "tip":
					await handleRebaseCommand(route.args, ctx, route.gitRoot, pi, "tip");
					return;
				case "pr":
					await handlePrCommand(route.args, ctx, route.gitRoot);
					return;
				case "help":
					showHelp(ctx);
					return;
				case "create":
					await handleCreateCommand(route.args, ctx, route.gitRoot);
					return;
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

	pi.registerTool({
		name: "worktree_pr_pause",
		label: "Pause PR Workflow",
		description: "Pause an active /worktree pr workflow when blocked or awaiting user input. Does not mark CI green or undo Git/PR changes.",
		parameters: Type.Object({
			reason: Type.String({ minLength: 1, description: "Concrete blocker requiring user input, credentials, or an unsafe/ambiguous repair" }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const message = prWorkflow.pause(params.reason);
			ctx.ui.notify(message, "warning");
			return { content: [{ type: "text", text: message }], details: { status: "paused", reason: params.reason } };
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
				invokedFrom: ctx.cwd,
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
