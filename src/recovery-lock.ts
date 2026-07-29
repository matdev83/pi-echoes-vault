import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Cross-process recovery lock: atomic acquire, ownership-safe release, and
// compare-and-delete stale reclaim. See README for the concurrency contract.
// ---------------------------------------------------------------------------

/** Lock file location, relative to the project cwd. */
export const RECOVERY_LOCK_RELATIVE = path.join(".pi", "echoes-recovery.lock");
/** Default stale-lock lease; foreign-host or dead-PID locks older than this are reclaimable. */
export const RECOVERY_LOCK_LEASE_MS = 30 * 60 * 1000;
/** Persisted lock schema version. */
export const RECOVERY_LOCK_VERSION = 1;
/** Wall-clock budget for waiting out in-flight quarantine operations. */
const ACQUIRE_RETRY_BUDGET_MS = 2000;
/** Backoff between acquire retries while a quarantine is in flight. */
const ACQUIRE_BACKOFF_MS = 25;

/** Metadata written atomically into the lock file. */
export type RecoveryLockInfo = {
	version: number;
	/** Unique owner token for this acquisition; used for ownership-safe release. */
	token: string;
	pid: number;
	hostname: string;
	/** Canonical project directory the lock protects. */
	cwd: string;
	/** Interrupted session transcript associated with the recovery, if any. */
	sessionFile: string | null;
	/** ISO timestamp of acquisition. */
	at: string;
};

export type AcquireLockOptions = {
	/** Injectable clock for deterministic tests. */
	now?: Date;
	sessionFile?: string | null;
	/** Override the stale lease window. */
	leaseMs?: number;
};

export type AcquireLockResult =
	| { acquired: true; info: RecoveryLockInfo; release: () => Promise<boolean> }
	| { acquired: false; reason: "held"; holder: RecoveryLockInfo }
	| { acquired: false; reason: "error"; error: string };

/** Outcome of an attempt to remove a lock that was observed as stale. */
export type ReclaimOutcome =
	| { outcome: "reclaimed" }
	| { outcome: "held"; holder: RecoveryLockInfo }
	| { outcome: "missing" };

function lockPath(cwd: string): string {
	return path.join(cwd, RECOVERY_LOCK_RELATIVE);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isLockStale(info: RecoveryLockInfo, now: Date, leaseMs: number): boolean {
	const age = now.getTime() - Date.parse(info.at);
	return (
		!Number.isFinite(age) ||
		age > leaseMs ||
		(info.hostname === os.hostname() && !isPidAlive(info.pid))
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quarantine sibling name carrying its creation time for crash-leftover GC. */
function quarantinePath(target: string, kind: "reclaim" | "release"): string {
	return `${target}.${process.pid}.${Date.now()}.${randomUUID()}.${kind}`;
}

/**
 * Detect an in-flight quarantine beside the lock path. While a reclaim or
 * release holds the lock aside, the canonical path is missing; claiming it
 * then could produce two owners. Stale leftovers from a crashed process are
 * garbage-collected. Uses the wall clock, never the injectable lock clock.
 */
async function quarantineInFlight(cwd: string, leaseMs: number): Promise<boolean> {
	const dir = path.dirname(lockPath(cwd));
	const base = path.basename(lockPath(cwd));
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return false;
	}
	const nowMs = Date.now();
	let busy = false;
	for (const name of names) {
		if (!name.startsWith(`${base}.`)) continue;
		const parts = name.slice(base.length + 1).split(".");
		const kind = parts[parts.length - 1];
		if (kind !== "reclaim" && kind !== "release") continue;
		const age = nowMs - Number(parts[1]);
		if (Number.isFinite(age) && age >= 0 && age <= leaseMs) busy = true;
		else await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
	}
	return busy;
}

async function readLockFile(file: string): Promise<RecoveryLockInfo | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as RecoveryLockInfo;
		return parsed && typeof parsed === "object" && parsed.token ? parsed : null;
	} catch {
		return null;
	}
}

/** Read current lock metadata, or null when unlocked/unreadable. */
export async function readRecoveryLock(cwd: string): Promise<RecoveryLockInfo | null> {
	return readLockFile(lockPath(cwd));
}

/**
 * Put a quarantined lock back at `target` without overwriting a lock that
 * another process created while the path was empty. Hard-linking is atomic and
 * fails on EEXIST; when the path is already taken the canonical owner wins and
 * the quarantined copy is dropped so exactly one lock identity survives.
 */
async function restoreQuarantine(quarantine: string, target: string): Promise<void> {
	try {
		await fs.link(quarantine, target);
		await fs.rm(quarantine, { force: true }).catch(() => {});
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			await fs.rm(quarantine, { force: true }).catch(() => {});
			return;
		}
	}
	// Hard links unsupported on this filesystem: restore only into a free path.
	if ((await fs.stat(target).catch(() => null)) === null) {
		await fs.rename(quarantine, target).catch(() => {});
	}
}

type QuarantineVerdict<T> = { action: "remove"; result: T } | { action: "restore"; result: T };

/**
 * Move the lock aside, let `decide` judge the quarantined contents, then remove
 * or restore it accordingly. Returns `{ moved: false }` when no lock existed at
 * rename time. This is the single place that owns the compare-and-delete
 * invariant: a foreign or changed lock is restored, never deleted.
 */
async function withQuarantinedLock<T>(
	cwd: string,
	kind: "reclaim" | "release",
	decide: (moved: RecoveryLockInfo | null) => QuarantineVerdict<T>,
): Promise<{ moved: false } | { moved: true; result: T }> {
	const target = lockPath(cwd);
	const quarantine = quarantinePath(target, kind);
	try {
		await fs.rename(target, quarantine);
	} catch {
		return { moved: false };
	}
	const verdict = decide(await readLockFile(quarantine));
	if (verdict.action === "remove") {
		await fs.rm(quarantine, { force: true }).catch(() => {});
	} else {
		await restoreQuarantine(quarantine, target);
	}
	return { moved: true, result: verdict.result };
}

/**
 * Atomically move the current lock aside and verify it is the exact lock named
 * by `token`. Returns true only when the caller's own lock was removed.
 */
async function removeIfOwner(cwd: string, token: string): Promise<boolean> {
	const outcome = await withQuarantinedLock(cwd, "release", (moved) =>
		moved?.token === token
			? { action: "remove", result: true }
			: { action: "restore", result: false },
	);
	return outcome.moved ? outcome.result : false;
}

/** Release the lock only if `token` still owns it. Returns true when released. */
export async function releaseRecoveryLock(cwd: string, token: string): Promise<boolean> {
	return removeIfOwner(cwd, token);
}

/**
 * Remove a lock that was previously observed as stale, but only if the file
 * still holds that exact observed lock. If a different owner is present (a
 * concurrent reclaim won the race), restore it and back off.
 */
export async function reclaimStaleLock(
	cwd: string,
	observed: RecoveryLockInfo,
	opts: AcquireLockOptions = {},
): Promise<ReclaimOutcome> {
	const now = opts.now ?? new Date();
	const leaseMs = opts.leaseMs ?? RECOVERY_LOCK_LEASE_MS;
	const outcome = await withQuarantinedLock(cwd, "reclaim", (moved) => {
		if (!moved || moved.token !== observed.token) return { action: "restore", result: "changed" as const };
		// Confirm the observed lock is still stale before finalizing removal.
		return isLockStale(moved, now, leaseMs)
			? { action: "remove", result: "reclaimed" as const }
			: { action: "restore", result: "changed" as const };
	});
	if (!outcome.moved) return { outcome: "missing" };
	if (outcome.result === "reclaimed") return { outcome: "reclaimed" };
	// The quarantined lock was restored; whatever now sits at the path is the
	// current holder (a concurrent owner may have appeared during the gap).
	const current = await readRecoveryLock(cwd);
	return current ? { outcome: "held", holder: current } : { outcome: "missing" };
}

/**
 * Atomically acquire the recovery lock for `cwd` using exclusive file creation.
 * Reclaims stale locks (age > lease, or dead owning PID on the same host).
 */
export async function acquireRecoveryLock(
	cwd: string,
	opts: AcquireLockOptions = {},
): Promise<AcquireLockResult> {
	const now = opts.now ?? new Date();
	const leaseMs = opts.leaseMs ?? RECOVERY_LOCK_LEASE_MS;
	const target = lockPath(cwd);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const info: RecoveryLockInfo = {
		version: RECOVERY_LOCK_VERSION,
		token: randomUUID(),
		pid: process.pid,
		hostname: os.hostname(),
		cwd: path.resolve(cwd),
		sessionFile: opts.sessionFile ?? null,
		at: now.toISOString(),
	};
	const create = () =>
		fs.writeFile(target, JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
	const release = () => releaseRecoveryLock(cwd, info.token);
	const deadline = Date.now() + ACQUIRE_RETRY_BUDGET_MS;

	for (;;) {
		if (Date.now() >= deadline) {
			const current = await readRecoveryLock(cwd);
			return current
				? { acquired: false, reason: "held", holder: current }
				: { acquired: false, reason: "error", error: "recovery lock busy: could not acquire in time" };
		}

		const holder = await readRecoveryLock(cwd);
		if (!holder) {
			// The path is missing: either the lock is legitimately free (released or
			// reclaimed), or a concurrent reclaim/release currently holds it in
			// quarantine. Claiming the hole could produce two owners, so wait out
			// the quarantine; only race on exclusive create when truly free.
			if (await quarantineInFlight(cwd, leaseMs)) {
				await sleep(ACQUIRE_BACKOFF_MS);
				continue;
			}
			try {
				await create();
				return { acquired: true, info, release };
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
					return { acquired: false, reason: "error", error: String(err) };
				}
				// Lost the create race, or the file is unparseable: re-read.
				await sleep(ACQUIRE_BACKOFF_MS);
				continue;
			}
		}

		// A live lock is never moved aside: quarantining it would open a window
		// in which the lock path is missing and harder to detect.
		if (!isLockStale(holder, now, leaseMs)) {
			return { acquired: false, reason: "held", holder };
		}

		const reclaim = await reclaimStaleLock(cwd, holder, { now, leaseMs });
		if (reclaim.outcome === "held") {
			return { acquired: false, reason: "held", holder: reclaim.holder };
		}
		// Reclaimed by us or vanished under us: loop back to the create race.
	}
}
