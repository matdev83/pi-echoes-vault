import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { captureGitSnapshot, formatGitContext } from "../src/git-context.ts";

const exec = promisify(execFile);
const cleanup: string[] = [];
after(async () => Promise.all(cleanup.map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))));

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
	});

	it("reports a non-repository without throwing", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "echoes-nongit-"));
		cleanup.push(cwd);
		assert.equal(await captureGitSnapshot(cwd), null);
		assert.match(formatGitContext(null, null), /not inside a Git repository/);
	});
});
