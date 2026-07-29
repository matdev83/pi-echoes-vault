import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { fetchBranchPr } from "../src/pr-context.ts";

const exec = promisify(execFile);

const cleanup: string[] = [];
after(async () =>
	Promise.all(cleanup.map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))),
);

async function dir(): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "echoes-pr-"));
	cleanup.push(cwd);
	await mkdir(path.join(cwd, ".pi"), { recursive: true });
	return cwd;
}

async function repo(): Promise<string> {
	const cwd = await dir();
	await exec("git", ["init", "-q", "-b", "main"], { cwd });
	await exec("git", ["config", "user.email", "t@t"], { cwd });
	await exec("git", ["config", "user.name", "t"], { cwd });
	await writeFile(path.join(cwd, "a.txt"), "x\n");
	await exec("git", ["add", "."], { cwd });
	await exec("git", ["commit", "-qm", "init"], { cwd });
	return cwd;
}

async function enablePr(cwd: string): Promise<void> {
	await writeFile(path.join(cwd, ".pi", "echoes-config.json"), JSON.stringify({ prContext: true }) + "\n");
}

function prRunner(pr: { ok: boolean; stdout?: string; error?: string }) {
	return async (args: string[]) =>
		args[0] === "--version"
			? { ok: true, stdout: "gh version 2.0", timedOut: false, enoent: false }
			: { ok: pr.ok, stdout: pr.stdout ?? "", timedOut: false, enoent: false, error: pr.error };
}

describe("PR context", () => {
	it("is disabled by default", async () => {
		const cwd = await dir();
		const result = await fetchBranchPr(cwd);
		assert.equal(result.status, "disabled");
		assert.equal(result.info, undefined);
	});

	it("automaticActions:false overrides an explicit prContext opt-in", async () => {
		const cwd = await dir();
		await writeFile(
			path.join(cwd, ".pi", "echoes-config.json"),
			JSON.stringify({ automaticActions: false, prContext: true }) + "\n",
		);
		const result = await fetchBranchPr(cwd);
		assert.equal(result.status, "disabled", "documented precedence must disable PR context");
	});

	it("degrades to unavailable when gh is missing, even when enabled", async () => {
		const cwd = await dir();
		await writeFile(
			path.join(cwd, ".pi", "echoes-config.json"),
			JSON.stringify({ prContext: true }) + "\n",
		);
		const result = await fetchBranchPr(cwd, { ghPath: "definitely-not-gh-xyz", timeoutMs: 250 });
		assert.ok(["unavailable", "timeout", "error"].includes(result.status));
		assert.equal(result.info, undefined);
	});

	it("returns sanitized PR info on success and summarizes checks", async () => {
		const cwd = await repo();
		await enablePr(cwd);
		const json = JSON.stringify({
			number: 42,
			title: "Add feature",
			state: "OPEN",
			url: "https://github.com/x/y/pull/42",
			reviewDecision: "APPROVED",
			statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { state: "SUCCESS" }],
		});
		const result = await fetchBranchPr(cwd, { ghRunner: prRunner({ ok: true, stdout: json }) });
		assert.equal(result.status, "ok");
		assert.equal(result.info?.number, 42);
		assert.equal(result.info?.reviewDecision, "APPROVED");
		assert.equal(result.info?.checksSummary, "2/3 checks passing");
	});

	it("maps gh 'no pull requests found' to no-pr", async () => {
		const cwd = await repo();
		await enablePr(cwd);
		const result = await fetchBranchPr(cwd, {
			ghRunner: prRunner({ ok: false, error: "no pull requests found for branch main" }),
		});
		assert.equal(result.status, "no-pr");
		assert.equal(result.info, undefined);
	});

	it("caches within TTL, refetches when stale, and honors forceRefresh", async () => {
		const cwd = await repo();
		await enablePr(cwd);
		let prCalls = 0;
		const runner = async (args: string[]) => {
			if (args[0] === "--version") return { ok: true, stdout: "v", timedOut: false, enoent: false };
			prCalls++;
			return {
				ok: true,
				stdout: JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u" }),
				timedOut: false,
				enoent: false,
			};
		};
		const t0 = new Date("2026-01-01T00:00:00Z");
		assert.equal((await fetchBranchPr(cwd, { ghRunner: runner, now: t0 })).status, "ok");
		assert.equal(prCalls, 1);
		assert.equal((await fetchBranchPr(cwd, { ghRunner: runner, now: new Date(t0.getTime() + 60_000) })).status, "ok");
		assert.equal(prCalls, 1, "served from cache within TTL");
		assert.equal((await fetchBranchPr(cwd, { ghRunner: runner, now: new Date(t0.getTime() + 11 * 60_000) })).status, "ok");
		assert.equal(prCalls, 2, "stale cache refetches");
		assert.equal((await fetchBranchPr(cwd, { ghRunner: runner, now: t0, forceRefresh: true })).status, "ok");
		assert.equal(prCalls, 3, "forceRefresh bypasses cache");
	});

	it("invalidates the cache when HEAD moves on the same branch", async () => {
		const cwd = await repo();
		await enablePr(cwd);
		let prCalls = 0;
		const runner = async (args: string[]) => {
			if (args[0] === "--version") return { ok: true, stdout: "v", timedOut: false, enoent: false };
			prCalls++;
			return {
				ok: true,
				stdout: JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u" }),
				timedOut: false,
				enoent: false,
			};
		};
		const now = new Date("2026-01-01T00:00:00Z");
		assert.equal((await fetchBranchPr(cwd, { ghRunner: runner, now })).status, "ok");
		assert.equal(prCalls, 1);

		// Same branch, new commit: checks/review may have changed, so the cached
		// branch-only result must not be reused.
		await writeFile(path.join(cwd, "b.txt"), "y\n");
		await exec("git", ["add", "."], { cwd });
		await exec("git", ["commit", "-qm", "second"], { cwd });

		assert.equal((await fetchBranchPr(cwd, { ghRunner: runner, now })).status, "ok");
		assert.equal(prCalls, 2, "HEAD movement on the same branch must bypass the cache");
	});
});
