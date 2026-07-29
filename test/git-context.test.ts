import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
	captureGitSnapshot,
	categorizeEntries,
	computeGitDelta,
	formatGitContext,
	isVaultManagedPath,
	parsePorcelainZ,
	type StatusEntry,
} from "../src/git-context.ts";

const exec = promisify(execFile);
const cleanup: string[] = [];
after(async () => Promise.all(cleanup.map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))));

async function repo(): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "echoes-git-"));
	cleanup.push(cwd);
	await exec("git", ["init", "-b", "main"], { cwd });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd });
	await exec("git", ["config", "user.name", "Test"], { cwd });
	await writeFile(path.join(cwd, "tracked.txt"), "one\n");
	await exec("git", ["add", "."], { cwd });
	await exec("git", ["commit", "-m", "initial"], { cwd });
	return cwd;
}

describe("Git context", () => {
	it("returns a bounded changed-path summary and detects unchanged snapshots", async () => {
		const cwd = await repo();
		const saved = await captureGitSnapshot(cwd);
		assert.ok(saved);
		assert.match(formatGitContext(saved, saved), /matches the last vault update/);

		await writeFile(path.join(cwd, "tracked.txt"), "two\n");
		await writeFile(path.join(cwd, "new.txt"), "new\n");
		const changed = await captureGitSnapshot(cwd);
		assert.ok(changed);
		assert.equal(changed.unstaged, 1);
		assert.equal(changed.untracked, 1);
		const text = formatGitContext(changed, saved);
		assert.match(text, /local Git state changed/);
		assert.match(text, /tracked\.txt/);

		const unchangedDirty = formatGitContext(changed, changed);
		assert.match(unchangedDirty, /DIRTY worktree/);
		assert.match(unchangedDirty, /1 unstaged, 1 untracked/);
		assert.match(unchangedDirty, /new\.txt/);
		assert.doesNotMatch(unchangedDirty, /status clean/);
	});

	it("reports a non-repository without throwing", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "echoes-nongit-"));
		cleanup.push(cwd);
		assert.equal(await captureGitSnapshot(cwd), null);
		assert.match(formatGitContext(null, null), /not inside a Git repository/);
	});
});

describe("Git context delta and categories", () => {
	it("classifies EchoesVault paths as vault-managed, everything else as project", () => {
		assert.equal(isVaultManagedPath("EchoesVault/daily/2026-01-01.md"), true);
		assert.equal(isVaultManagedPath("EchoesVault/index.md"), true);
		assert.equal(isVaultManagedPath("src/EchoesVault.ts"), false, "basename match is not enough");
		assert.equal(isVaultManagedPath("src/main.ts"), false);
	});

	it("parses porcelain -z records including rename/copy source paths", () => {
		const status = " M src/a.ts\u0000?? new.txt\u0000R  dest.ts\u0000orig.ts\u0000";
		const entries = parsePorcelainZ(status);
		assert.equal(entries.length, 3);
		assert.deepEqual(entries[0], { xy: " M", path: "src/a.ts" });
		assert.deepEqual(entries[1], { xy: "??", path: "new.txt" });
		assert.equal(entries[2].xy, "R ");
		assert.equal(entries[2].path, "dest.ts");
		assert.equal(entries[2].origPath, "orig.ts");
	});

	it("splits parsed entries into project vs vault-managed groups with counts", () => {
		const entries: StatusEntry[] = [
			{ xy: " M", path: "src/a.ts" },
			{ xy: "??", path: "new.txt" },
			{ xy: " M", path: "EchoesVault/daily/2026-01-01.md" },
			{ xy: "??", path: "EchoesVault/pages/draft.md" },
		];
		const cat = categorizeEntries(entries);
		assert.equal(cat.project.unstaged, 1);
		assert.equal(cat.project.untracked, 1);
		assert.deepEqual(cat.project.paths.sort(), ["new.txt", "src/a.ts"]);
		assert.equal(cat.vaultManaged.unstaged, 1);
		assert.equal(cat.vaultManaged.untracked, 1);
		assert.deepEqual(cat.vaultManaged.paths.sort(), [
			"EchoesVault/daily/2026-01-01.md",
			"EchoesVault/pages/draft.md",
		]);
	});

	it("captureGitSnapshot populates categorized project/vault splits", async () => {
		const cwd = await repo();
		await mkdir(path.join(cwd, "EchoesVault", "daily"), { recursive: true });
		await writeFile(path.join(cwd, "EchoesVault", "daily", "note.md"), "vault only\n");
		const snap = await captureGitSnapshot(cwd);
		assert.ok(snap);
		assert.ok(snap.categorized, "snapshot must carry categorized changes");
		assert.equal(snap.categorized.project.untracked, 0, "project worktree is clean");
		assert.equal(snap.categorized.project.unstaged, 0);
		assert.equal(snap.categorized.vaultManaged.untracked, 1, "vault change still visible");
	});

	it("computes a structured delta with recent commits and path movement", async () => {
		const cwd = await repo();
		const saved = await captureGitSnapshot(cwd);
		assert.ok(saved);

		await writeFile(path.join(cwd, "tracked.txt"), "two\n");
		await exec("git", ["add", "."], { cwd });
		await exec("git", ["commit", "-m", "second commit"], { cwd });
		await writeFile(path.join(cwd, "fresh.txt"), "new\n");

		const current = await captureGitSnapshot(cwd);
		assert.ok(current);
		const delta = await computeGitDelta(cwd, current, saved);
		assert.equal(delta.branchChanged, false);
		assert.equal(delta.headChanged, true);
		assert.equal(delta.commitCount, 1);
		assert.match(delta.commits[0] ?? "", /second commit/);
		assert.equal(delta.projectDirty, true);
		assert.ok(delta.newPaths.includes("fresh.txt"));
		assert.equal((delta as { headRelation?: string }).headRelation, "advanced");
	});

	it("classifies a reset as rewound, not advanced", async () => {
		const cwd = await repo();
		const base = await captureGitSnapshot(cwd);
		assert.ok(base);
		await writeFile(path.join(cwd, "tracked.txt"), "two\n");
		await exec("git", ["commit", "-aqm", "second"], { cwd });
		const tip = await captureGitSnapshot(cwd);
		assert.ok(tip);
		await exec("git", ["reset", "--hard", "HEAD~1"], { cwd });
		const rewound = await captureGitSnapshot(cwd);
		assert.ok(rewound);

		const delta = await computeGitDelta(cwd, rewound, tip);
		assert.equal((delta as { headRelation?: string }).headRelation, "rewound");
		const text = formatGitContext(rewound, tip, delta);
		assert.match(text, /rewound/i);
		assert.doesNotMatch(text, /advanced by 0/);
	});

	it("classifies an amended (rewritten) HEAD as divergence, never advancement-by-zero", async () => {
		const cwd = await repo();
		const before = await captureGitSnapshot(cwd);
		assert.ok(before);
		await exec("git", ["commit", "--amend", "-qm", "initial rewritten"], { cwd });
		const after = await captureGitSnapshot(cwd);
		assert.ok(after);

		const delta = await computeGitDelta(cwd, after, before);
		assert.equal(delta.headChanged, true);
		assert.equal((delta as { headRelation?: string }).headRelation, "diverged");
		assert.doesNotMatch(formatGitContext(after, before, delta), /advanced by 0/);
	});

	it("classifies divergent history as diverged", async () => {
		const cwd = await repo();
		const base = await captureGitSnapshot(cwd);
		assert.ok(base);
		await exec("git", ["checkout", "-qb", "feature"], { cwd });
		await writeFile(path.join(cwd, "f.txt"), "f\n");
		await exec("git", ["add", "."], { cwd });
		await exec("git", ["commit", "-qm", "feature work"], { cwd });
		await exec("git", ["checkout", "-q", "main"], { cwd });
		await writeFile(path.join(cwd, "m.txt"), "m\n");
		await exec("git", ["add", "."], { cwd });
		await exec("git", ["commit", "-qm", "main work"], { cwd });
		const mainNow = await captureGitSnapshot(cwd);
		assert.ok(mainNow);

		// Baseline was the feature tip; current is a diverged main.
		await exec("git", ["checkout", "-q", "feature"], { cwd });
		const featureTip = await captureGitSnapshot(cwd);
		assert.ok(featureTip);
		await exec("git", ["checkout", "-q", "main"], { cwd });

		const delta = await computeGitDelta(cwd, mainNow, featureTip);
		assert.equal((delta as { headRelation?: string }).headRelation, "diverged");
		assert.match(formatGitContext(mainNow, featureTip, delta), /diverged/i);
	});
});
