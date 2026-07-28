import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GitSnapshot } from "./git-context.ts";

export const PACKAGE_VERSION = "0.3.2";
/** Persisted `.pi/echoes-state.json` schema version (v3 adds isolated recovery metadata). */
export const STATE_VERSION = 3;
export const STATE_RELATIVE = path.join(".pi", "echoes-state.json");
export const MAX_SEARCH_RESULTS = 50;
export const MAX_LINE_PREVIEW = 200;

/** Windows reserved device basenames (with or without extension). */
const WINDOWS_RESERVED_BASENAME =
	/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Characters illegal in Windows filenames, plus C0 controls. */
const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Conservative allowed page basename charset (plus optional .md). */
const SAFE_PAGE_NAME = /^[a-zA-Z0-9._-]+$/;

export type VaultPaths = {
	vault: string;
	raw: string;
	pages: string;
	daily: string;
	assets: string;
	index: string;
};

export type VaultStats = {
	totalPages: number;
	totalDailyLogs: number;
	deprecatedPages: number;
};

export type EchoesSessionState = {
	started: boolean;
	saved: boolean;
	/**
	 * Informational: last start prompt was queued. Deduping within a Pi runtime
	 * uses extension-instance memory — this persisted flag must not suppress
	 * start after process restart or session_start new/resume/fork.
	 */
	startPromptSent: boolean;
	/**
	 * True after the end/distill prompt was queued. Cleared by successful commit
	 * or by agent_settled recovery when the turn finished without committing.
	 */
	endPromptSent: boolean;
	/** True when a prior quit left the session unsaved; cleared only by successful commit. */
	endPending: boolean;
	/** Session transcript associated with endPending, when Pi persisted one. */
	pendingSessionFile: string | null;
	/** ISO timestamp lease preventing concurrent background recovery attempts. */
	recoveryClaimedAt: string | null;
	lastStart: string | null;
	lastSave: string | null;
};

export type EchoesState = {
	version: number;
	pluginVersion: string;
	initialized: boolean;
	session: EchoesSessionState;
	stats: VaultStats;
	gitSnapshot: GitSnapshot | null;
};

export const DEFAULT_INDEX = `# EchoesVault Index

Welcome to the EchoesVault knowledge base.

This index tracks all structured pages in the vault.
`;

export function getDateStr(d: Date = new Date()): string {
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function defaultSessionState(): EchoesSessionState {
	return {
		started: false,
		saved: false,
		startPromptSent: false,
		endPromptSent: false,
		endPending: false,
		pendingSessionFile: null,
		recoveryClaimedAt: null,
		lastStart: null,
		lastSave: null,
	};
}

export function defaultState(pluginVersion = PACKAGE_VERSION): EchoesState {
	return {
		version: STATE_VERSION,
		pluginVersion,
		initialized: false,
		session: defaultSessionState(),
		stats: {
			totalPages: 0,
			totalDailyLogs: 0,
			deprecatedPages: 0,
		},
		gitSnapshot: null,
	};
}

export function resolveVaultPaths(cwd: string): VaultPaths {
	const vault = path.join(cwd, "EchoesVault");
	return {
		vault,
		raw: path.join(vault, "raw"),
		pages: path.join(vault, "pages"),
		daily: path.join(vault, "daily"),
		assets: path.join(vault, "assets"),
		index: path.join(vault, "index.md"),
	};
}

export function statePath(cwd: string): string {
	return path.join(cwd, STATE_RELATIVE);
}

/**
 * In-process per-cwd serialization for EchoesVault state read-modify-write.
 * Does not coordinate across processes or OS locks — only orders mutations
 * within a single Node process / extension runtime.
 */
const mutationChains = new Map<string, Promise<unknown>>();

export async function withVaultMutation<T>(
	cwd: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = path.resolve(cwd);
	const prev = mutationChains.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const next = prev.then(
		() => gate,
		() => gate,
	);
	mutationChains.set(key, next);
	await prev.catch(() => {});
	try {
		return await fn();
	} finally {
		release();
		if (mutationChains.get(key) === next) {
			mutationChains.delete(key);
		}
	}
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNonNegFinite(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

function normalizeSessionState(raw: unknown): EchoesSessionState {
	const base = defaultSessionState();
	if (!raw || typeof raw !== "object") return base;
	const s = raw as Record<string, unknown>;
	return {
		started: asBoolean(s.started, base.started),
		saved: asBoolean(s.saved, base.saved),
		startPromptSent: asBoolean(s.startPromptSent, base.startPromptSent),
		endPromptSent: asBoolean(s.endPromptSent, base.endPromptSent),
		endPending: asBoolean(s.endPending, base.endPending),
		pendingSessionFile: asNullableString(s.pendingSessionFile),
		recoveryClaimedAt: asNullableString(s.recoveryClaimedAt),
		lastStart: asNullableString(s.lastStart),
		lastSave: asNullableString(s.lastSave),
	};
}

function normalizeStats(raw: unknown): VaultStats {
	const base = defaultState().stats;
	if (!raw || typeof raw !== "object") return base;
	const s = raw as Record<string, unknown>;
	return {
		totalPages: asNonNegFinite(s.totalPages, base.totalPages),
		totalDailyLogs: asNonNegFinite(s.totalDailyLogs, base.totalDailyLogs),
		deprecatedPages: asNonNegFinite(s.deprecatedPages, base.deprecatedPages),
	};
}

/** True when an EchoesVault tree or persisted state already exists in cwd. */
export async function hasExistingEchoesPresence(cwd: string): Promise<boolean> {
	const paths = resolveVaultPaths(cwd);
	return (await pathExists(paths.vault)) || (await pathExists(statePath(cwd)));
}

/** True when `EchoesVault/` exists as a directory. */
export async function hasExistingVault(cwd: string): Promise<boolean> {
	try {
		return (await fs.stat(resolveVaultPaths(cwd).vault)).isDirectory();
	} catch {
		return false;
	}
}

/** Unsaved session that still needs an end/commit fallback. */
export async function needsAutomaticEnd(cwd: string): Promise<boolean> {
	if (!(await hasExistingVault(cwd))) return false;
	const st = await readState(cwd);
	return st.session.started && !st.session.saved;
}

/**
 * Validate a bare page filename. Rejects path traversal, Windows-invalid
 * characters, control characters, trailing dots/spaces, and reserved device
 * basenames. Does not invent a substitute name.
 */
export function validatePageFilename(name: string): string {
	if (name !== name.trim()) {
		throw new Error(`Page filename must not have leading or trailing whitespace: ${JSON.stringify(name)}`);
	}
	if (!name) {
		throw new Error("Page filename must not be empty");
	}
	if (name.includes("..") || name.includes("/") || name.includes("\\")) {
		throw new Error(`Page filename must be a bare name without path separators: ${JSON.stringify(name)}`);
	}
	if (/[. ]$/.test(name)) {
		throw new Error(`Page filename must not end with a space or dot: ${JSON.stringify(name)}`);
	}
	if (WINDOWS_INVALID_CHARS.test(name)) {
		throw new Error(`Page filename contains invalid characters: ${JSON.stringify(name)}`);
	}
	if (!SAFE_PAGE_NAME.test(name)) {
		throw new Error(`Page filename contains unsupported characters: ${JSON.stringify(name)}`);
	}

	const basename = name.replace(/\.md$/i, "");
	if (!basename) {
		throw new Error("Page filename must not be only an .md extension");
	}
	if (/[. ]$/.test(basename)) {
		throw new Error(`Page filename must not end with a space or dot: ${JSON.stringify(name)}`);
	}
	if (WINDOWS_RESERVED_BASENAME.test(basename)) {
		throw new Error(`Page filename uses a reserved Windows device name: ${JSON.stringify(name)}`);
	}

	return name;
}

/** @deprecated Use validatePageFilename — kept as an alias that rejects invalid names. */
export function sanitizeFilename(name: string): string {
	return validatePageFilename(name);
}

export function toPageFilename(name: string): string {
	const safe = validatePageFilename(name);
	return safe.endsWith(".md") ? safe : `${safe}.md`;
}

export function toPageSlug(filename: string): string {
	return filename.replace(/\.md$/i, "");
}

export type AtomicWriteDeps = {
	rename?: (src: string, dest: string) => Promise<void>;
	rm?: (target: string, opts?: { force?: boolean }) => Promise<void>;
};

/**
 * Write file via temp + rename. On Windows, when rename-over fails, move the
 * existing file aside, rename temp into place, then remove the backup. If
 * replacement fails, restore the backup when possible.
 */
export async function writeFileAtomic(
	filePath: string,
	content: string,
	deps: AtomicWriteDeps = {},
): Promise<void> {
	const rename =
		deps.rename ?? ((src, dest) => fs.rename(src, dest).then(() => undefined));
	const rm = deps.rm ?? ((target, opts) => fs.rm(target, opts).then(() => undefined));

	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, content, "utf-8");
	try {
		await rename(tmp, filePath);
		return;
	} catch {
		// Windows cannot rename over an existing file — use backup-and-restore.
	}

	const backup = `${filePath}.${process.pid}.${Date.now()}.bak`;
	try {
		await rename(filePath, backup);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}

	try {
		await rename(tmp, filePath);
	} catch (err) {
		try {
			await rename(backup, filePath);
		} catch {
			// Leave backup in place if restore rename also fails.
		}
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}

	await rm(backup, { force: true });
}

export async function ensureVaultDirs(paths: VaultPaths): Promise<void> {
	await fs.mkdir(paths.raw, { recursive: true });
	await fs.mkdir(paths.pages, { recursive: true });
	await fs.mkdir(paths.daily, { recursive: true });
	await fs.mkdir(paths.assets, { recursive: true });
}

export async function ensureIndex(paths: VaultPaths): Promise<boolean> {
	try {
		await fs.access(paths.index);
		return false;
	} catch {
		await writeFileAtomic(paths.index, DEFAULT_INDEX);
		return true;
	}
}

/** Idempotent bootstrap: dirs + default index if missing. */
export async function bootstrapVault(cwd: string): Promise<VaultPaths> {
	const paths = resolveVaultPaths(cwd);
	await ensureVaultDirs(paths);
	await ensureIndex(paths);
	return paths;
}

export async function readState(cwd: string): Promise<EchoesState> {
	try {
		const raw = await fs.readFile(statePath(cwd), "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const base = defaultState();
		return {
			version: STATE_VERSION,
			pluginVersion:
				typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : base.pluginVersion,
			initialized: asBoolean(parsed.initialized, base.initialized),
			session: normalizeSessionState(parsed.session),
			stats: normalizeStats(parsed.stats),
			gitSnapshot: parsed.gitSnapshot && typeof parsed.gitSnapshot === "object"
				? parsed.gitSnapshot as GitSnapshot
				: null,
		};
	} catch {
		return defaultState();
	}
}

export async function writeState(cwd: string, state: EchoesState): Promise<void> {
	await writeFileAtomic(statePath(cwd), JSON.stringify(state, null, 2) + "\n");
}

export async function collectStats(vaultPaths: VaultPaths): Promise<VaultStats> {
	let totalPages = 0;
	let totalDailyLogs = 0;
	let deprecatedPages = 0;

	try {
		const pageFiles = (await fs.readdir(vaultPaths.pages)).filter((f) => f.endsWith(".md"));
		totalPages = pageFiles.length;
		for (const file of pageFiles) {
			const content = await fs.readFile(path.join(vaultPaths.pages, file), "utf-8");
			if (content.includes("DEPRECATED")) deprecatedPages++;
		}
	} catch {
		/* pages may not exist */
	}

	try {
		const dailyFiles = (await fs.readdir(vaultPaths.daily)).filter((f) => f.endsWith(".md"));
		totalDailyLogs = dailyFiles.length;
	} catch {
		/* daily may not exist */
	}

	return { totalPages, totalDailyLogs, deprecatedPages };
}

/**
 * Refresh vault stats while already holding `withVaultMutation` for `cwd`.
 * Callers that are not under the lock must use `refreshStats` instead.
 */
async function refreshStatsUnlocked(cwd: string): Promise<EchoesState> {
	const paths = resolveVaultPaths(cwd);
	const st = await readState(cwd);
	st.stats = await collectStats(paths);
	await writeState(cwd, st);
	return st;
}

export async function refreshStats(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, () => refreshStatsUnlocked(cwd));
}

/** Initialize vault: dirs + index, initialized=true, neutral session flags. */
export async function activateVault(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, async () => {
		await bootstrapVault(cwd);
		const st = await readState(cwd);
		st.version = STATE_VERSION;
		st.initialized = true;
		st.session.started = false;
		st.session.saved = false;
		st.session.startPromptSent = false;
		st.session.endPromptSent = false;
		st.session.endPending = false;
		st.session.pendingSessionFile = null;
		st.session.recoveryClaimedAt = null;
		st.pluginVersion = PACKAGE_VERSION;
		st.stats = await collectStats(resolveVaultPaths(cwd));
		await writeState(cwd, st);
		return st;
	});
}

/**
 * Start session: initialized=true, started=true, saved=false.
 * Preserves `endPending` until a successful commit clears it.
 * Resets prompt-sent flags so a new restoration can be delivered once per runtime.
 */
export async function startSession(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, async () => {
		await bootstrapVault(cwd);
		const st = await readState(cwd);
		st.version = STATE_VERSION;
		st.initialized = true;
		st.session.started = true;
		st.session.saved = false;
		st.session.startPromptSent = false;
		st.session.endPromptSent = false;
		st.session.lastStart = new Date().toISOString();
		st.pluginVersion = PACKAGE_VERSION;
		st.stats = await collectStats(resolveVaultPaths(cwd));
		await writeState(cwd, st);
		return st;
	});
}

export async function markStartPromptSent(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, async () => {
		const st = await readState(cwd);
		st.session.startPromptSent = true;
		await writeState(cwd, st);
		return st;
	});
}

export async function markEndPromptSent(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, async () => {
		const st = await readState(cwd);
		st.session.endPromptSent = true;
		await writeState(cwd, st);
		return st;
	});
}

export async function clearStartPromptSent(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, async () => {
		const st = await readState(cwd);
		st.session.startPromptSent = false;
		await writeState(cwd, st);
		return st;
	});
}

export async function clearEndPromptSent(cwd: string): Promise<EchoesState> {
	return withVaultMutation(cwd, async () => {
		const st = await readState(cwd);
		st.session.endPromptSent = false;
		await writeState(cwd, st);
		return st;
	});
}

/**
 * On process quit with an unsaved started session, record recovery for the
 * next eligible session_start. Does nothing for reload or already-saved sessions.
 */
export async function recordEndPendingOnQuit(
	cwd: string,
	sessionFile?: string,
): Promise<boolean> {
	return withVaultMutation(cwd, async () => {
		if (!(await hasExistingVault(cwd))) return false;
		const st = await readState(cwd);
		if (st.session.saved || !st.session.started) return false;
		st.session.endPending = true;
		st.session.pendingSessionFile = sessionFile ? path.resolve(sessionFile) : null;
		st.session.recoveryClaimedAt = null;
		st.version = STATE_VERSION;
		await writeState(cwd, st);
		return true;
	});
}

const RECOVERY_LEASE_MS = 30 * 60 * 1000;

/** Atomically claim pending recovery. Stale claims are reclaimable after 30 minutes. */
export async function claimPendingRecovery(cwd: string, now = new Date()): Promise<string | null> {
	return withVaultMutation(cwd, async () => {
		const st = await readState(cwd);
		if (!st.session.endPending) return null;
		const claimedAt = st.session.recoveryClaimedAt
			? Date.parse(st.session.recoveryClaimedAt)
			: Number.NaN;
		if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < RECOVERY_LEASE_MS) return null;
		st.session.recoveryClaimedAt = now.toISOString();
		await writeState(cwd, st);
		return st.session.pendingSessionFile ?? "";
	});
}

/** Release a failed recovery claim while preserving endPending for a later retry. */
export async function releasePendingRecovery(cwd: string): Promise<void> {
	await withVaultMutation(cwd, async () => {
		const st = await readState(cwd);
		if (!st.session.endPending) return;
		st.session.recoveryClaimedAt = null;
		await writeState(cwd, st);
	});
}

/** Reload-safe stats refresh that re-reads state under the mutation lock. */
export async function refreshStatsOnReload(cwd: string): Promise<EchoesState | null> {
	return withVaultMutation(cwd, async () => {
		if (!(await hasExistingVault(cwd))) return null;
		const paths = resolveVaultPaths(cwd);
		const st = await readState(cwd);
		st.stats = await collectStats(paths);
		st.version = STATE_VERSION;
		st.pluginVersion = PACKAGE_VERSION;
		await writeState(cwd, st);
		return st;
	});
}

export async function readTextOr(filePath: string, fallback: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf-8");
	} catch {
		return fallback;
	}
}

/** Newest-first daily logs, up to `limit` files. */
export async function readRecentDailyLogs(cwd: string, limit = 3): Promise<string> {
	const { daily } = resolveVaultPaths(cwd);
	try {
		const files = (await fs.readdir(daily))
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ name: f, full: path.join(daily, f) }));
		const withStat = await Promise.all(
			files.map(async (f) => {
				const st = await fs.stat(f.full);
				return { ...f, mtime: st.mtimeMs };
			}),
		);
		withStat.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
		const selected = withStat.slice(0, limit);
		if (selected.length === 0) return "No daily logs found";
		const parts: string[] = [];
		for (const f of selected) {
			const content = await fs.readFile(f.full, "utf-8");
			parts.push(`### EchoesVault/daily/${f.name}\n${content.trimEnd()}\n\n---\n`);
		}
		return parts.join("\n");
	} catch {
		return "No daily logs found";
	}
}

export type CommitArgs = {
	dailySummary: string;
	newPages?: Array<{ filename: string; content: string }>;
	indexAppends?: string[];
	indexUpdates?: Array<{ oldLine: string; newLine: string }>;
};

function indexCoversSlug(indexText: string, appends: string[], slug: string): boolean {
	const link = `[[${slug}]]`;
	if (indexText.includes(link)) return true;
	return appends.some((line) => line.includes(link));
}

export async function commitMemory(
	cwd: string,
	args: CommitArgs,
	options: { recovery?: boolean; gitSnapshot?: GitSnapshot | null } = {},
): Promise<string> {
	return withVaultMutation(cwd, async () => {
		const paths = await bootstrapVault(cwd);
		const indexAppends = args.indexAppends ?? [];
		const newPages = args.newPages ?? [];
		let indexContent = await readTextOr(paths.index, DEFAULT_INDEX);

		// Index-is-Law: every genuinely new page needs a matching index entry.
		for (const page of newPages) {
			const fileName = toPageFilename(page.filename);
			const pageFile = path.join(paths.pages, fileName);
			const existed = await pathExists(pageFile);
			if (!existed) {
				const slug = toPageSlug(fileName);
				if (!indexCoversSlug(indexContent, indexAppends, slug)) {
					throw new Error(
						`New page "${fileName}" requires an indexAppend (or existing index line) containing [[${slug}]]`,
					);
				}
			}
		}

		const today = getDateStr();
		const dailyFile = path.join(paths.daily, `${today}.md`);
		const timestamp = new Date().toISOString();
		const header = `## Session - ${timestamp}\n\n`;
		await fs.appendFile(dailyFile, header + args.dailySummary + "\n\n");

		let pagesCreated = 0;
		for (const page of newPages) {
			const fileName = toPageFilename(page.filename);
			await writeFileAtomic(path.join(paths.pages, fileName), page.content.trim() + "\n");
			pagesCreated++;
		}

		if (args.indexUpdates?.length) {
			for (const upd of args.indexUpdates) {
				if (indexContent.includes(upd.oldLine)) {
					indexContent = indexContent.split(upd.oldLine).join(upd.newLine);
				}
			}
		}

		if (indexAppends.length) {
			const toAppend = indexAppends.join("\n");
			indexContent = indexContent.trimEnd() + "\n" + toAppend + "\n";
		}

		await writeFileAtomic(paths.index, indexContent);

		const st = await readState(cwd);
		st.version = STATE_VERSION;
		st.initialized = true;
		if (!options.recovery) {
			st.session.started = false;
			st.session.saved = true;
			st.session.endPromptSent = true;
		}
		st.session.endPending = false;
		st.session.pendingSessionFile = null;
		st.session.recoveryClaimedAt = null;
		st.session.lastSave = new Date().toISOString();
		if (options.gitSnapshot !== undefined) st.gitSnapshot = options.gitSnapshot;
		st.stats = await collectStats(paths);
		await writeState(cwd, st);

		return [
			"Memory committed to EchoesVault.",
			`- Daily log: EchoesVault/daily/${today}.md`,
			`- Pages created: ${pagesCreated}`,
			`- Index: updated`,
		].join("\n");
	});
}

export async function appendDailyLog(cwd: string, logEntry: string): Promise<string> {
	return withVaultMutation(cwd, async () => {
		const paths = await bootstrapVault(cwd);
		const today = getDateStr();
		const dailyFile = path.join(paths.daily, `${today}.md`);
		const timestamp = new Date().toISOString();
		const entry = `### Scratchpad - ${timestamp}\n\n${logEntry}\n\n`;
		await fs.appendFile(dailyFile, entry);
		await refreshStatsUnlocked(cwd);
		return `Scratchpad note saved to EchoesVault/daily/${today}.md`;
	});
}

export async function searchVaultPages(
	cwd: string,
	query: string,
	options?: { maxResults?: number; maxLinePreview?: number },
): Promise<string> {
	const paths = await bootstrapVault(cwd);
	const maxResults = options?.maxResults ?? MAX_SEARCH_RESULTS;
	const maxLinePreview = options?.maxLinePreview ?? MAX_LINE_PREVIEW;
	const q = query.toLowerCase();
	const results: string[] = [];

	try {
		const files = (await fs.readdir(paths.pages)).filter((f) => f.endsWith(".md")).sort();
		for (const file of files) {
			const content = await fs.readFile(path.join(paths.pages, file), "utf-8");
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].toLowerCase().includes(q)) {
					results.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, maxLinePreview)}`);
					if (results.length >= maxResults) {
						return results.join("\n") + `\n… truncated to ${maxResults} matches`;
					}
				}
			}
		}
	} catch {
		return "_No pages found in EchoesVault/pages/_";
	}

	if (results.length === 0) {
		return `No results found for "${query}" in EchoesVault/pages/.`;
	}
	return results.join("\n");
}

export type CreateOrUpdateArgs = {
	filename: string;
	content: string;
	indexDescription?: string;
};

export async function createOrUpdatePage(cwd: string, args: CreateOrUpdateArgs): Promise<string> {
	return withVaultMutation(cwd, async () => {
		const paths = await bootstrapVault(cwd);
		const fileName = toPageFilename(args.filename);
		const pageFile = path.join(paths.pages, fileName);

		const existed = await pathExists(pageFile);
		const link = `[[${toPageSlug(fileName)}]]`;

		if (!existed) {
			if (!args.indexDescription?.trim()) {
				throw new Error(
					`indexDescription is required when creating a new page (${fileName}). Format: "- [[${toPageSlug(fileName)}]]: description."`,
				);
			}
			if (!args.indexDescription.includes(link)) {
				throw new Error(
					`indexDescription must include the wikilink ${link} when creating a new page (${fileName}).`,
				);
			}
		}

		await writeFileAtomic(pageFile, args.content.trim() + "\n");

		if (!existed && args.indexDescription) {
			let indexContent = await readTextOr(paths.index, DEFAULT_INDEX);
			if (!indexContent.includes(link)) {
				indexContent = indexContent.trimEnd() + "\n" + args.indexDescription + "\n";
				await writeFileAtomic(paths.index, indexContent);
			}
		}

		// Already under withVaultMutation — use unlocked stats helper to avoid deadlock.
		await refreshStatsUnlocked(cwd);

		const action = existed ? "updated" : "created";
		const parts = [`Page ${action}: EchoesVault/pages/${fileName}`];
		if (!existed && args.indexDescription) parts.push("Index: synced");
		return parts.join("\n");
	});
}

export function formatStatusReport(state: EchoesState, todayLogExists: boolean): string {
	const lines = [
		"EchoesVault Status",
		`* Initialized: ${state.initialized}`,
		`* Session started: ${state.session.started}`,
		`* Session saved: ${state.session.saved}`,
		`* Last start: ${state.session.lastStart ?? "never"}`,
		`* Last save: ${state.session.lastSave ?? "never"}`,
		`* Total pages: ${state.stats.totalPages}`,
		`* Daily logs: ${state.stats.totalDailyLogs}`,
		`* Deprecated pages: ${state.stats.deprecatedPages}`,
		`* Today's log present: ${todayLogExists}`,
		`* Package version: ${state.pluginVersion}`,
	];
	if (state.stats.totalPages > 200) {
		lines.push("");
		lines.push("> [!warning] SCALE ALERT");
		lines.push(
			"> The vault has exceeded 200 pages. Consider a hybrid RAG approach for `/echoes-start` context.",
		);
	}
	return lines.join("\n");
}
