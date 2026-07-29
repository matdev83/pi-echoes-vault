// ---------------------------------------------------------------------------
// Opt-in current-branch PR enrichment. Disabled unless `prContext: true` is set
// in `.pi/echoes-config.json`. Never blocks first-turn local Git context and
// degrades silently when gh/auth/network/GitHub remote are unavailable.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { readResolvedEchoesConfig } from "./config.ts";
import { git } from "./git-context.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_RELATIVE = path.join(".pi", "echoes-pr-cache.json");

type PrCacheEntry = { key: string; at: string; result: PrContextResult };

/** Sanitized pull-request summary for the current branch. */
export type PrInfo = {
	number: number;
	title: string;
	state: string;
	url: string;
	reviewDecision: string | null;
	/** e.g. "2/3 checks passing"; null when unknown. */
	checksSummary: string | null;
	/** ISO timestamp when this result was cached. */
	cachedAt: string;
};

export type PrContextStatus =
	| "disabled"
	| "ok"
	| "no-pr"
	| "unavailable"
	| "timeout"
	| "error";

export type PrContextResult = {
	status: PrContextStatus;
	info?: PrInfo;
	/** Machine-readable reason for non-ok statuses (surfaced only via doctor). */
	reason?: string;
};

export type FetchPrOptions = {
	/** Hard timeout; defaults to a conservative bound. Never blocks first turn. */
	timeoutMs?: number;
	/** Injectable clock for deterministic cache tests. */
	now?: Date;
	/** Override the gh executable (tests use a fake). */
	ghPath?: string;
	/** Force a cache miss. */
	forceRefresh?: boolean;
	/** Test-only seam replacing the gh invocation entirely. */
	ghRunner?: (args: string[], timeoutMs: number) => Promise<GhRun>;
};

export type GhRun = { ok: boolean; stdout: string; timedOut: boolean; enoent: boolean; error?: string };

async function runGh(
	ghPath: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<GhRun> {
	try {
		const { stdout } = await execFileAsync(ghPath, args, {
			cwd,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			encoding: "utf-8",
			windowsHide: true,
			maxBuffer: 1024 * 1024,
		});
		return { ok: true, stdout, timedOut: false, enoent: false };
	} catch (err) {
		const e = err as { killed?: boolean; signal?: string; code?: number | string; stderr?: string };
		if (e.code === "ENOENT") return { ok: false, stdout: "", timedOut: false, enoent: true };
		if (e.killed || e.signal === "SIGKILL") return { ok: false, stdout: "", timedOut: true, enoent: false };
		return {
			ok: false,
			stdout: "",
			timedOut: false,
			enoent: false,
			error: typeof e.stderr === "string" ? e.stderr.slice(0, 200) : String(err).slice(0, 200),
		};
	}
}

function summarizeChecks(rollup: unknown): string | null {
	if (!Array.isArray(rollup) || rollup.length === 0) return null;
	const passing = rollup.filter(
		(c) => (c as { conclusion?: string; state?: string }).conclusion === "SUCCESS" || (c as { state?: string }).state === "SUCCESS",
	).length;
	return `${passing}/${rollup.length} checks passing`;
}

async function readCache(cwd: string): Promise<PrCacheEntry | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(cwd, CACHE_RELATIVE), "utf-8")) as PrCacheEntry;
	} catch {
		return null;
	}
}

async function writeCache(cwd: string, entry: PrCacheEntry): Promise<void> {
	try {
		await fs.mkdir(path.dirname(path.join(cwd, CACHE_RELATIVE)), { recursive: true });
		await fs.writeFile(path.join(cwd, CACHE_RELATIVE), JSON.stringify(entry, null, 2) + "\n");
	} catch {
		/* cache is best-effort */
	}
}

/** Render a PR summary as a single hidden-context line. */
export function formatPrContext(info: PrInfo): string {
	const review = info.reviewDecision ? `; review: ${info.reviewDecision}` : "";
	const checks = info.checksSummary ? `; ${info.checksSummary}` : "";
	return `Current branch PR: #${info.number} (${info.state}) ${info.title}${review}${checks} - ${info.url}`;
}

/**
 * Resolve the PR associated with the current branch using `gh`. Disabled unless
 * `prContext` is explicitly enabled in `.pi/echoes-config.json`.
 */
export async function fetchBranchPr(
	cwd: string,
	opts: FetchPrOptions = {},
): Promise<PrContextResult> {
	if (!(await readResolvedEchoesConfig(cwd)).prContext) return { status: "disabled" };

	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const ghPath = opts.ghPath ?? "gh";
	const now = opts.now ?? new Date();
	const gh = opts.ghRunner ?? ((args: string[], t: number) => runGh(ghPath, args, cwd, t));

	// Independent local lookups; parallel so the cache check never serializes them.
	const [branch, head, repo] = await Promise.all([
		git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => null),
		git(cwd, ["rev-parse", "HEAD"]).catch(() => null),
		git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => path.resolve(cwd)),
	]);
	// Cache identity must move when the branch, HEAD, or repository changes so a
	// new commit on the same branch invalidates stale PR/check results.
	const cacheKey = `${repo}@${branch || "detached"}@${head || "nohead"}`;

	if (!opts.forceRefresh) {
		const cached = await readCache(cwd);
		if (cached && cached.key === cacheKey) {
			const age = now.getTime() - Date.parse(cached.at);
			if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) return cached.result;
		}
	}

	const finish = async (result: PrContextResult): Promise<PrContextResult> => {
		await writeCache(cwd, { key: cacheKey, at: now.toISOString(), result });
		return result;
	};

	// Cheap local precheck separates "gh missing" from "no PR"/auth failures.
	const version = await gh(["--version"], timeoutMs);
	if (version.enoent) return finish({ status: "unavailable", reason: "gh executable not found" });
	if (version.timedOut) return finish({ status: "timeout", reason: "gh --version timed out" });

	if (!branch) return finish({ status: "no-pr", reason: "detached HEAD; no branch to query" });

	const query = await gh(
		["pr", "view", branch, "--json", "number,title,state,url,reviewDecision,statusCheckRollup"],
		timeoutMs,
	);
	if (query.timedOut) return finish({ status: "timeout", reason: `gh pr view exceeded ${timeoutMs}ms` });
	if (!query.ok) {
		const msg = query.error ?? "";
		return finish(
			/no pull requests? found/i.test(msg)
				? { status: "no-pr", reason: "no PR for current branch" }
				: { status: "unavailable", reason: msg || "gh pr view failed" },
		);
	}

	try {
		const data = JSON.parse(query.stdout) as {
			number: number;
			title: string;
			state: string;
			url: string;
			reviewDecision?: string | null;
			statusCheckRollup?: unknown;
		};
		return finish({
			status: "ok",
			info: {
				number: data.number,
				title: data.title,
				state: data.state,
				url: data.url,
				reviewDecision: data.reviewDecision ?? null,
				checksSummary: summarizeChecks(data.statusCheckRollup),
				cachedAt: now.toISOString(),
			},
		});
	} catch {
		return finish({ status: "error", reason: "could not parse gh output" });
	}
}
