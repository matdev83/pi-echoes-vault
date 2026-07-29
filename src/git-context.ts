import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PATHS = 12;

export type GitSnapshot = {
	repoRoot: string;
	gitDir: string;
	commonDir: string;
	branch: string;
	head: string;
	headSubject: string;
	upstream: string | null;
	upstreamHead: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
	paths: string[];
	operation: string | null;
	fingerprint: string;
	/** Phase 2+: changes split into project work vs EchoesVault-managed files. */
	categorized?: CategorizedChanges;
};

/** Directory whose contents are managed by EchoesVault, not user project work. */
export const VAULT_DIR = "EchoesVault";
/** Maximum recent commits included in a structured delta. */
export const MAX_DELTA_COMMITS = 5;
/** Maximum changed paths reported per category. */
export const MAX_CATEGORY_PATHS = 12;

/** One parsed `git status --porcelain=v1 -z` record. */
export type StatusEntry = {
	/** Two-character XY status code, e.g. "M ", " M", "??", "R ". */
	xy: string;
	/** Destination/current path (repo-relative). */
	path: string;
	/** Source path for rename/copy records. */
	origPath?: string;
};

/** Aggregate change counts and bounded paths for one side of the split. */
export type ChangeGroup = {
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
	paths: string[];
};

/** Project work vs EchoesVault-managed changes, both always visible. */
export type CategorizedChanges = {
	project: ChangeGroup;
	vaultManaged: ChangeGroup;
};

/** Direction of HEAD movement relative to the baseline. */
export type HeadRelation = "same" | "advanced" | "rewound" | "diverged" | "changed";

/** Structured, offline comparison of current Git state vs the saved baseline. */
export type GitDelta = {
	branchChanged: boolean;
	fromBranch: string | null;
	toBranch: string | null;
	headChanged: boolean;
	/** Direction of HEAD movement; never implies advancement for resets/divergence. */
	headRelation: HeadRelation;
	commitCount: number;
	/** Commits on the baseline side not reachable from current (rewind/divergence). */
	behindCount: number;
	/** "<short-hash> <subject>" lines, bounded by MAX_DELTA_COMMITS. */
	commits: string[];
	upstreamMoved: boolean;
	fromUpstreamHead: string | null;
	toUpstreamHead: string | null;
	ahead: number;
	behind: number;
	newPaths: string[];
	resolvedPaths: string[];
	projectDirty: boolean;
	vaultDirty: boolean;
};

/** Two-character porcelain codes that represent unmerged (conflicted) entries. */
const CONFLICTED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function emptyGroup(): ChangeGroup {
	return { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, paths: [] };
}

function groupSummary(g: {
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
}): string {
	return `${g.staged} staged, ${g.unstaged} unstaged, ${g.untracked} untracked, ${g.conflicted} conflicted`;
}

function groupDirty(g: ChangeGroup): boolean {
	return g.staged + g.unstaged + g.untracked + g.conflicted > 0;
}

/** Human-readable HEAD movement that never mislabels resets as advancement. */
function describeHeadRelation(delta: GitDelta): string {
	switch (delta.headRelation) {
		case "advanced":
			return `advanced by ${delta.commitCount} commit(s)`;
		case "rewound":
			return `rewound by ${delta.behindCount} commit(s)`;
		case "diverged":
			return `diverged (+${delta.commitCount}/-${delta.behindCount} commits)`;
		case "changed":
			return "changed (unrelated or rewritten history)";
		default:
			return "unchanged";
	}
}

/** True when a repo-relative path lives under the EchoesVault directory. */
export function isVaultManagedPath(repoRelativePath: string): boolean {
	const normalized = repoRelativePath.replace(/\\/g, "/");
	return normalized === VAULT_DIR || normalized.startsWith(`${VAULT_DIR}/`);
}

/** Parse `git status --porcelain=v1 -z` output into structured records. */
export function parsePorcelainZ(status: string): StatusEntry[] {
	const records = status ? status.split("\0").filter(Boolean) : [];
	const entries: StatusEntry[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const xy = record.slice(0, 2);
		const entry: StatusEntry = { xy, path: record.slice(3) };
		if (xy[0] === "R" || xy[0] === "C") entry.origPath = records[++i];
		entries.push(entry);
	}
	return entries;
}

/** Split parsed status records into project vs vault-managed groups. */
export function categorizeEntries(entries: StatusEntry[]): CategorizedChanges {
	const result: CategorizedChanges = { project: emptyGroup(), vaultManaged: emptyGroup() };
	for (const entry of entries) {
		const group = isVaultManagedPath(entry.path) ? result.vaultManaged : result.project;
		if (entry.xy === "??") group.untracked++;
		else {
			if (entry.xy[0] !== " ") group.staged++;
			if (entry.xy[1] !== " ") group.unstaged++;
			if (CONFLICTED_CODES.has(entry.xy)) group.conflicted++;
		}
		group.paths.push(entry.path);
	}
	result.project.paths = result.project.paths.slice(0, MAX_CATEGORY_PATHS);
	result.vaultManaged.paths = result.vaultManaged.paths.slice(0, MAX_CATEGORY_PATHS);
	return result;
}

/** Compute a bounded, offline delta between the current state and a baseline. */
export async function computeGitDelta(
	cwd: string,
	current: GitSnapshot,
	saved: GitSnapshot | null,
): Promise<GitDelta> {
	const branchChanged = saved?.branch !== current.branch;
	const headChanged = saved?.head !== current.head;
	const upstreamMoved = saved?.upstreamHead !== current.upstreamHead;
	let commitCount = 0;
	let behindCount = 0;
	let commits: string[] = [];
	let headRelation: HeadRelation = headChanged ? "changed" : "same";
	if (saved && headChanged && saved.head !== "unborn" && current.head !== "unborn") {
		commitCount = Number(await git(cwd, ["rev-list", "--count", `${saved.head}..${current.head}`]).catch(() => "0")) || 0;
		behindCount = Number(await git(cwd, ["rev-list", "--count", `${current.head}..${saved.head}`]).catch(() => "0")) || 0;
		if (commitCount > 0 && behindCount === 0) headRelation = "advanced";
		else if (commitCount === 0 && behindCount > 0) headRelation = "rewound";
		else if (commitCount > 0 && behindCount > 0) headRelation = "diverged";
		else headRelation = "changed";
		const log = await git(cwd, [
			"log",
			`${saved.head}..${current.head}`,
			`--max-count=${MAX_DELTA_COMMITS}`,
			"--pretty=%h %s",
		]).catch(() => "");
		commits = log ? log.split("\n").filter(Boolean) : [];
	}
	const savedPaths = new Set(saved?.paths ?? []);
	const currentPaths = new Set(current.paths);
	const newPaths = current.paths.filter((p) => !savedPaths.has(p));
	const resolvedPaths = (saved?.paths ?? []).filter((p) => !currentPaths.has(p));
	const cat = current.categorized;
	const projectDirty = cat ? groupDirty(cat.project) : current.staged + current.unstaged + current.untracked + current.conflicted > 0;
	const vaultDirty = cat ? groupDirty(cat.vaultManaged) : false;
	return {
		branchChanged,
		fromBranch: saved?.branch ?? null,
		toBranch: current.branch,
		headChanged,
		headRelation,
		commitCount,
		behindCount,
		commits,
		upstreamMoved,
		fromUpstreamHead: saved?.upstreamHead ?? null,
		toUpstreamHead: current.upstreamHead,
		ahead: current.ahead,
		behind: current.behind,
		newPaths,
		resolvedPaths,
		projectDirty,
		vaultDirty,
	};
}

/** Canonical git spawn wrapper: trimmed stdout on success, throws on failure. */
export async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	return stdout.trimEnd();
}

async function exists(target: string): Promise<boolean> {
	try { await fs.access(target); return true; } catch { return false; }
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot | null> {
	try {
		const [repoRoot, gitDirRaw, commonDirRaw, head, subject, branchRaw, status] = await Promise.all([
			git(cwd, ["rev-parse", "--show-toplevel"]),
			git(cwd, ["rev-parse", "--absolute-git-dir"]),
			git(cwd, ["rev-parse", "--git-common-dir"]),
			git(cwd, ["rev-parse", "HEAD"]).catch(() => "unborn"),
			git(cwd, ["log", "-1", "--pretty=%s"]).catch(() => "no commits"),
			git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "detached HEAD"),
			git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
		]);
		const gitDir = path.resolve(cwd, gitDirRaw);
		const commonDir = path.resolve(cwd, commonDirRaw);
		const entries = parsePorcelainZ(status);
		const categorized = categorizeEntries(entries);
		const staged = categorized.project.staged + categorized.vaultManaged.staged;
		const unstaged = categorized.project.unstaged + categorized.vaultManaged.unstaged;
		const untracked = categorized.project.untracked + categorized.vaultManaged.untracked;
		const conflicted = categorized.project.conflicted + categorized.vaultManaged.conflicted;
		const changedPaths = entries.map((e) => e.path).slice(0, MAX_PATHS);
		const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => null);
		const upstreamHead = upstream ? await git(cwd, ["rev-parse", upstream]).catch(() => null) : null;
		let ahead = 0, behind = 0;
		if (upstream) {
			const counts = await git(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]).catch(() => "0\t0");
			[ahead, behind] = counts.split(/\s+/).map(Number);
		}
		let operation: string | null = null;
		for (const [name, marker] of [["rebase", "rebase-merge"], ["rebase", "rebase-apply"], ["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"], ["bisect", "BISECT_LOG"]] as const) {
			if (await exists(path.join(gitDir, marker))) { operation = name; break; }
		}
		const fingerprint = JSON.stringify({ head, branchRaw, upstreamHead, status });
		return { repoRoot, gitDir, commonDir, branch: branchRaw, head, headSubject: subject, upstream, upstreamHead, ahead, behind, staged, unstaged, untracked, conflicted, paths: changedPaths, operation, fingerprint, categorized };
	} catch {
		return null;
	}
}

export function formatGitContext(
	current: GitSnapshot | null,
	saved: GitSnapshot | null,
	delta?: GitDelta,
): string {
	if (!current) return "EchoesVault environment: current directory is not inside a Git repository.";
	const unchanged = saved?.repoRoot === current.repoRoot && saved.fingerprint === current.fingerprint;
	const dirty = current.staged + current.unstaged + current.untracked + current.conflicted;
	const cat = current.categorized;
	if (unchanged) {
		const status = dirty ? `DIRTY worktree: ${groupSummary(current)}` : "CLEAN worktree";
		let detail = "";
		if (dirty && cat) {
			detail = ` Project: ${groupDirty(cat.project) ? groupSummary(cat.project) : "clean"}; vault-managed: ${groupDirty(cat.vaultManaged) ? groupSummary(cat.vaultManaged) : "clean"}.`;
		}
		const paths = current.paths.length
			? ` Changed paths: ${current.paths.map((p) => `\`${p}\``).join(", ")}.`
			: "";
		return `EchoesVault environment: branch \`${current.branch}\`; ${status}; this exact local Git state matches the last vault update.${detail}${paths}`;
	}
	const worktree = current.gitDir !== current.commonDir ? `linked worktree (common Git dir: \`${current.commonDir}\`)` : "regular checkout";
	const lines = [
		"EchoesVault local Git snapshot:",
		`- Repository: \`${current.repoRoot}\`; ${worktree}`,
		`- Branch: \`${current.branch}\`; HEAD \`${current.head.slice(0, 8)}\` (${current.headSubject})`,
		current.upstream ? `- Cached upstream: \`${current.upstream}\`; ahead ${current.ahead}, behind ${current.behind}` : "- Upstream: not configured",
		`- Worktree: ${groupSummary(current)}`,
	];
	if (cat) {
		lines.push(`- Project changes: ${groupDirty(cat.project) ? groupSummary(cat.project) : "clean"}`);
		lines.push(`- Vault-managed changes: ${groupDirty(cat.vaultManaged) ? groupSummary(cat.vaultManaged) : "clean"}`);
	}
	if (current.operation) lines.push(`- Git operation in progress: ${current.operation}`);
	if (saved) {
		lines.push(`- Since last vault update: ${saved.fingerprint === current.fingerprint ? "no local Git changes" : "local Git state changed"}`);
		if (delta) {
			if (delta.branchChanged) lines.push(`  - Branch changed: \`${delta.fromBranch ?? "detached"}\` -> \`${delta.toBranch}\``);
			if (delta.headChanged) lines.push(`  - HEAD ${describeHeadRelation(delta)}`);
			for (const commit of delta.commits) lines.push(`    - \`${commit}\``);
			if (delta.upstreamMoved) lines.push("  - Cached upstream reference moved");
			if (delta.newPaths.length) lines.push(`  - Newly changed: ${delta.newPaths.map((p) => `\`${p}\``).join(", ")}`);
			if (delta.resolvedPaths.length) lines.push(`  - Resolved: ${delta.resolvedPaths.map((p) => `\`${p}\``).join(", ")}`);
		}
	}
	if (current.paths.length) lines.push(`- Changed paths: ${current.paths.map((p) => `\`${p}\``).join(", ")}`);
	return lines.join("\n");
}
