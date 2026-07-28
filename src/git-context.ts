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
};

async function git(cwd: string, args: string[]): Promise<string> {
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
		const entries = status ? status.split("\0").filter(Boolean) : [];
		let staged = 0, unstaged = 0, untracked = 0, conflicted = 0;
		const changedPaths: string[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const xy = entry.slice(0, 2);
			if (xy === "??") untracked++;
			else {
				if (xy[0] !== " ") staged++;
				if (xy[1] !== " ") unstaged++;
				if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) conflicted++;
			}
			changedPaths.push(entry.slice(3));
			if (xy[0] === "R" || xy[0] === "C") i++;
		}
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
		return { repoRoot, gitDir, commonDir, branch: branchRaw, head, headSubject: subject, upstream, upstreamHead, ahead, behind, staged, unstaged, untracked, conflicted, paths: changedPaths.slice(0, MAX_PATHS), operation, fingerprint };
	} catch {
		return null;
	}
}

export function formatGitContext(current: GitSnapshot | null, saved: GitSnapshot | null): string {
	if (!current) return "EchoesVault environment: current directory is not inside a Git repository.";
	const unchanged = saved?.repoRoot === current.repoRoot && saved.fingerprint === current.fingerprint;
	const dirty = current.staged + current.unstaged + current.untracked + current.conflicted;
	if (unchanged) {
		const status = dirty
			? `DIRTY worktree: ${current.staged} staged, ${current.unstaged} unstaged, ${current.untracked} untracked, ${current.conflicted} conflicted`
			: "CLEAN worktree";
		const paths = current.paths.length
			? ` Changed paths: ${current.paths.map((p) => `\`${p}\``).join(", ")}.`
			: "";
		return `EchoesVault environment: branch \`${current.branch}\`; ${status}; this exact local Git state matches the last vault update.${paths}`;
	}
	const worktree = current.gitDir !== current.commonDir ? `linked worktree (common Git dir: \`${current.commonDir}\`)` : "regular checkout";
	const lines = [
		"EchoesVault local Git snapshot:",
		`- Repository: \`${current.repoRoot}\`; ${worktree}`,
		`- Branch: \`${current.branch}\`; HEAD \`${current.head.slice(0, 8)}\` (${current.headSubject})`,
		current.upstream ? `- Cached upstream: \`${current.upstream}\`; ahead ${current.ahead}, behind ${current.behind}` : "- Upstream: not configured",
		`- Worktree: ${current.staged} staged, ${current.unstaged} unstaged, ${current.untracked} untracked, ${current.conflicted} conflicted`,
	];
	if (current.operation) lines.push(`- Git operation in progress: ${current.operation}`);
	if (saved) lines.push(`- Since last vault update: ${saved.fingerprint === current.fingerprint ? "no local Git changes" : "local Git state changed"}`);
	if (current.paths.length) lines.push(`- Changed paths: ${current.paths.map((p) => `\`${p}\``).join(", ")}`);
	return lines.join("\n");
}
