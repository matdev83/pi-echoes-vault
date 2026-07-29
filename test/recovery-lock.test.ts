import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import {
	acquireRecoveryLock,
	readRecoveryLock,
	reclaimStaleLock,
	releaseRecoveryLock,
} from "../src/recovery-lock.ts";

const cleanup: string[] = [];
after(async () =>
	Promise.all(cleanup.map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))),
);

async function dir(): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "echoes-lock-"));
	cleanup.push(cwd);
	return cwd;
}

describe("Recovery lock", () => {
	it("acquires, reports metadata, and releases ownership-safely", async () => {
		const cwd = await dir();
		const first = await acquireRecoveryLock(cwd, { sessionFile: "s.jsonl" });
		assert.equal(first.acquired, true);
		if (!first.acquired) return;
		assert.equal(first.info.cwd, path.resolve(cwd));
		assert.equal(first.info.sessionFile, "s.jsonl");
		assert.ok(first.info.token);

		const held = await acquireRecoveryLock(cwd);
		assert.equal(held.acquired, false);
		if (!held.acquired) assert.equal(held.reason, "held");

		assert.equal(await releaseRecoveryLock(cwd, "wrong-token"), false, "foreign token must not release");
		assert.equal(await releaseRecoveryLock(cwd, first.info.token), true);
		assert.equal(await readRecoveryLock(cwd), null);
	});

	it("reclaims stale locks but preserves live ones", async () => {
		const cwd = await dir();
		const old = await acquireRecoveryLock(cwd, { now: new Date(Date.now() - 60 * 60 * 1000) });
		assert.equal(old.acquired, true);
		const reclaimed = await acquireRecoveryLock(cwd, { leaseMs: 60 * 1000 });
		assert.equal(reclaimed.acquired, true, "stale lock must be reclaimable");
	});

	it("a live lock blocks other processes; a released lock is reclaimable", async () => {
		const exec = promisify(execFile);
		const cwd = await dir();
		const childPath = path.join(cwd, "lock-child.ts");
		await writeFile(
			childPath,
			"const mod = await import(process.argv[3]);\n" +
				"const r = await mod.acquireRecoveryLock(process.argv[2]);\n" +
				'process.stdout.write(r.acquired ? "won" : "lost");\n',
		);
		const moduleUrl = new URL("../src/recovery-lock.ts", import.meta.url).href;
		const runChild = () =>
			exec("node", ["--experimental-strip-types", childPath, cwd, moduleUrl]).then((r) => r.stdout);

		const parentLock = await acquireRecoveryLock(cwd);
		assert.equal(parentLock.acquired, true);
		const whileHeld = await Promise.all(Array.from({ length: 4 }, runChild));
		assert.equal(
			whileHeld.filter((o) => o.includes("won")).length,
			0,
			`live lock must block other processes: ${JSON.stringify(whileHeld)}`,
		);

		assert.equal(await parentLock.release(), true);
		assert.match(await runChild(), /won/, "released lock must be reclaimable by another process");
	});
});

describe("Recovery lock race regressions", () => {
	async function staleLock(cwd: string): Promise<void> {
		const first = await acquireRecoveryLock(cwd, { now: new Date(Date.now() - 2 * 60 * 60 * 1000) });
		assert.equal(first.acquired, true);
	}

	it("exactly one acquirer wins a simultaneous stale-lock reclaim", async () => {
		for (let round = 0; round < 8; round++) {
			const cwd = await dir();
			await staleLock(cwd);
			const results = await Promise.all(
				Array.from({ length: 6 }, () => acquireRecoveryLock(cwd, { leaseMs: 60 * 1000 })),
			);
			const winners = results.filter((r) => r.acquired);
			assert.equal(winners.length, 1, `round ${round}: exactly one reclaim winner`);
			for (const w of winners) if (w.acquired) await w.release();
		}
	});

	it("concurrent contenders never displace a live lock", async () => {
		for (let round = 0; round < 8; round++) {
			const cwd = await dir();
			const owner = await acquireRecoveryLock(cwd);
			assert.equal(owner.acquired, true);
			if (!owner.acquired) return;
			const results = await Promise.all(
				Array.from({ length: 6 }, () => acquireRecoveryLock(cwd)),
			);
			assert.equal(
				results.filter((r) => r.acquired).length,
				0,
				`round ${round}: a live lock must block every concurrent contender`,
			);
			const holder = await readRecoveryLock(cwd);
			assert.equal(holder?.token, owner.info.token, `round ${round}: owner lock must stay intact`);
			await owner.release();
		}
	});

	it("independent processes never both win a simultaneous stale reclaim", async () => {
		const exec = promisify(execFile);
		for (let round = 0; round < 4; round++) {
			const cwd = await dir();
			await staleLock(cwd);
			const childPath = path.join(cwd, "reclaim-child.ts");
			// The winner must hold the lock while siblings contend: a process that
			// exits right after acquiring leaves a dead-PID lock that is legitimately
			// reclaimable, which would be a second — but sequential — winner.
			await writeFile(
				childPath,
				"const mod = await import(process.argv[3]);\n" +
					"const r = await mod.acquireRecoveryLock(process.argv[2], { leaseMs: 60000 });\n" +
					'process.stdout.write(r.acquired ? "won" : "lost");\n' +
					"await new Promise((s) => setTimeout(s, 800));\n",
			);
			const moduleUrl = new URL("../src/recovery-lock.ts", import.meta.url).href;
			const results = await Promise.all(
				Array.from({ length: 3 }, () =>
					exec("node", ["--experimental-strip-types", childPath, cwd, moduleUrl]).then((r) => r.stdout),
				),
			);
			assert.equal(
				results.filter((o) => o.includes("won")).length,
				1,
				`round ${round}: exactly one cross-process reclaim winner: ${JSON.stringify(results)}`,
			);
		}
	});

	it("release never deletes a lock that changed owner between check and delete", async () => {
		const cwd = await dir();
		const a = await acquireRecoveryLock(cwd);
		assert.equal(a.acquired, true);
		if (!a.acquired) return;

		// Simulate the owner changing after A observed its own token: replace the
		// lock contents with a foreign owner B while A still holds token A.
		const foreign = {
			version: 1,
			token: "foreign-owner-token",
			pid: process.pid,
			hostname: "host",
			cwd: path.resolve(cwd),
			sessionFile: null,
			at: new Date().toISOString(),
		};
		await writeFile(path.join(cwd, ".pi", "echoes-recovery.lock"), JSON.stringify(foreign, null, 2) + "\n");

		assert.equal(await releaseRecoveryLock(cwd, a.info.token), false, "stale owner must not release");
		const holder = await readRecoveryLock(cwd);
		assert.equal(holder?.token, "foreign-owner-token", "foreign lock must survive a stale release");
	});

	it("an acquirer never claims the hole while a quarantine is in flight", async () => {
		const cwd = await dir();
		const owner = await acquireRecoveryLock(cwd);
		assert.equal(owner.acquired, true);
		if (!owner.acquired) return;
		const target = path.join(cwd, ".pi", "echoes-recovery.lock");
		const quarantine = `${target}.${process.pid}.${Date.now()}.00000000-0000-0000-0000-000000000000.reclaim`;
		await rename(target, quarantine);

		let settled = false;
		const attempt = acquireRecoveryLock(cwd).then((r) => {
			settled = true;
			return r;
		});
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(settled, false, "acquire must wait while a quarantine is in flight");

		await rename(quarantine, target);
		const result = await attempt;
		assert.equal(result.acquired, false);
		if (!result.acquired) assert.equal(result.reason, "held");
		assert.equal((await readRecoveryLock(cwd))?.token, owner.info.token, "original owner intact");
		await owner.release();
	});

	it("crash-leftover quarantine files are garbage-collected and never block acquire", async () => {
		const cwd = await dir();
		const target = path.join(cwd, ".pi", "echoes-recovery.lock");
		await mkdir(path.dirname(target), { recursive: true });
		const staleTs = Date.now() - 2 * 60 * 60 * 1000;
		await writeFile(`${target}.999999.${staleTs}.00000000-0000-0000-0000-000000000000.reclaim`, "{}\n");

		const result = await acquireRecoveryLock(cwd);
		assert.equal(result.acquired, true, "stale quarantine leftover must not block acquire");
		if (result.acquired) await result.release();
	});

	it("a reclaim that moves a different lock than it observed must restore it and back off", async () => {
		const cwd = await dir();
		// A live lock owned by B.
		const b = await acquireRecoveryLock(cwd);
		assert.equal(b.acquired, true);
		if (!b.acquired) return;
		const bToken = b.info.token;

		// A stale observation that no longer matches the live file: a reclaim keyed
		// to this observation must NOT delete B's lock.
		const staleObserved = {
			version: 1,
			token: "stale-observed-token",
			pid: 999999,
			hostname: "host",
			cwd: path.resolve(cwd),
			sessionFile: null,
			at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
		};
		const reclaim = await reclaimStaleLock(cwd, staleObserved, { leaseMs: 60 * 1000 });
		assert.notEqual(reclaim.outcome, "reclaimed", "must not reclaim a lock it did not observe");
		const holder = await readRecoveryLock(cwd);
		assert.equal(holder?.token, bToken, "B's live lock must be restored intact");
		await b.release();
	});

});
