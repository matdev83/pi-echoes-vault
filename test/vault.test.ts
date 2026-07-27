import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import {
	activateVault,
	appendDailyLog,
	bootstrapVault,
	commitMemory,
	createOrUpdatePage,
	DEFAULT_INDEX,
	hasExistingEchoesPresence,
	hasExistingVault,
	needsAutomaticEnd,
	readState,
	recordEndPendingOnQuit,
	sanitizeFilename,
	searchVaultPages,
	startSession,
	STATE_VERSION,
	toPageFilename,
	validatePageFilename,
	writeFileAtomic,
	writeState,
	statePath,
	resolveVaultPaths,
	MAX_SEARCH_RESULTS,
} from "../src/vault.ts";

describe("filename helpers", () => {
	it("normalizes .md and accepts safe names", () => {
		assert.equal(toPageFilename("foo"), "foo.md");
		assert.equal(toPageFilename("foo.md"), "foo.md");
		assert.equal(toPageFilename("foo.md.md"), "foo.md.md");
		assert.equal(validatePageFilename("auth-architecture.md"), "auth-architecture.md");
		assert.equal(sanitizeFilename("ok_page.md"), "ok_page.md");
	});

	it("rejects traversal, invalid chars, trailing junk, and reserved names", () => {
		assert.throws(() => validatePageFilename("../evil/../x.md"), /path separators|bare name/);
		assert.throws(() => validatePageFilename("a\\b/c.md"), /path separators|bare name/);
		assert.throws(() => validatePageFilename("bad:name.md"), /invalid characters/);
		assert.throws(() => validatePageFilename("has*star.md"), /invalid characters/);
		assert.throws(() => validatePageFilename("nul.md"), /reserved Windows device name/i);
		assert.throws(() => validatePageFilename("CON"), /reserved Windows device name/i);
		assert.throws(() => validatePageFilename("com1.md"), /reserved Windows device name/i);
		assert.throws(() => validatePageFilename("ends-with-dot."), /space or dot/);
		assert.throws(() => validatePageFilename("ends-with-space "), /whitespace|space or dot/);
		assert.throws(() => validatePageFilename("has\u0001ctrl.md"), /invalid characters/);
		assert.throws(() => validatePageFilename(""), /empty/);
	});
});

describe("writeFileAtomic", () => {
	const dirs: string[] = [];
	after(async () => {
		for (const d of dirs) await rm(d, { recursive: true, force: true });
	});

	it("replaces an existing file while preserving content on success", async () => {
		const d = await mkdtemp(path.join(tmpdir(), "echoes-atomic-"));
		dirs.push(d);
		const target = path.join(d, "index.md");
		await writeFileAtomic(target, "first\n");
		await writeFileAtomic(target, "second\n");
		assert.equal(await readFile(target, "utf-8"), "second\n");
	});

	it("restores the prior file when the replacement rename fails", async () => {
		const d = await mkdtemp(path.join(tmpdir(), "echoes-atomic-fail-"));
		dirs.push(d);
		const target = path.join(d, "page.md");
		await writeFileAtomic(target, "original\n");

		const fsPromises = await import("node:fs/promises");
		let renameCalls = 0;
		const failingRename = async (src: string, dest: string) => {
			renameCalls++;
			// 1: tmp→target fails (simulate Windows rename-over)
			// 2: target→backup ok
			// 3: tmp→target fails again → restore backup
			if (renameCalls === 1 || renameCalls === 3) {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			}
			await fsPromises.rename(src, dest);
		};

		await assert.rejects(
			() => writeFileAtomic(target, "replacement\n", { rename: failingRename }),
			/EPERM/,
		);
		assert.equal(await readFile(target, "utf-8"), "original\n");
		assert.ok(renameCalls >= 4, "expected backup + restore rename attempts");
	});
});

describe("vault domain", () => {
	const dirs: string[] = [];
	after(async () => {
		for (const d of dirs) await rm(d, { recursive: true, force: true });
	});

	async function tempCwd(): Promise<string> {
		const d = await mkdtemp(path.join(tmpdir(), "echoes-vault-"));
		dirs.push(d);
		return d;
	}

	it("bootstraps dirs and index idempotently", async () => {
		const cwd = await tempCwd();
		const first = await bootstrapVault(cwd);
		const createdAgain = await bootstrapVault(cwd);
		assert.equal(first.vault, createdAgain.vault);
		const index = await readFile(first.index, "utf-8");
		assert.equal(index, DEFAULT_INDEX);
	});

	it("activates with neutral session and starts with initialized+started", async () => {
		const cwd = await tempCwd();
		const activated = await activateVault(cwd);
		assert.equal(activated.initialized, true);
		assert.equal(activated.session.started, false);
		assert.equal(activated.session.saved, false);
		const started = await startSession(cwd);
		assert.equal(started.initialized, true);
		assert.equal(started.session.started, true);
		assert.equal(started.session.saved, false);
		assert.ok(started.session.lastStart);
		const raw = await readFile(statePath(cwd), "utf-8");
		assert.match(raw, /"initialized": true/);
		assert.ok(statePath(cwd).includes(path.join(".pi", "echoes-state.json")));
	});

	it("commit sets initialized=true, started=false, saved=true", async () => {
		const cwd = await tempCwd();
		await startSession(cwd);
		await commitMemory(cwd, { dailySummary: "Done." });
		const st = await readState(cwd);
		assert.equal(st.initialized, true);
		assert.equal(st.session.started, false);
		assert.equal(st.session.saved, true);
		assert.ok(st.session.lastSave);
	});

	it("appends daily log, creates page, commits memory with index coverage", async () => {
		const cwd = await tempCwd();
		await activateVault(cwd);
		await appendDailyLog(cwd, "- noted A");
		const pageResult = await createOrUpdatePage(cwd, {
			filename: "auth.md",
			content: "---\ntype: architecture\nstatus: active\n---\n\n# Auth\n",
			indexDescription: "- [[auth]]: Auth overview.",
		});
		assert.match(pageResult, /created/);
		const commit = await commitMemory(cwd, {
			dailySummary: "Wrapped session.",
			newPages: [
				{
					filename: "extra.md",
					content: "---\nstatus: active\n---\n\n# Extra\n",
				},
			],
			indexAppends: ["- [[extra]]: Extra note."],
		});
		assert.match(commit, /Memory committed/);
		const paths = resolveVaultPaths(cwd);
		const index = await readFile(paths.index, "utf-8");
		assert.match(index, /\[\[auth\]\]/);
		assert.match(index, /\[\[extra\]\]/);
	});

	it("rejects creating a page without indexDescription", async () => {
		const cwd = await tempCwd();
		await bootstrapVault(cwd);
		await assert.rejects(
			() =>
				createOrUpdatePage(cwd, {
					filename: "orphan.md",
					content: "---\nstatus: active\n---\n\n# Orphan\n",
				}),
			/indexDescription is required/,
		);
		const paths = resolveVaultPaths(cwd);
		await assert.rejects(async () => readFile(path.join(paths.pages, "orphan.md"), "utf-8"));
	});

	it("rejects creating a page when indexDescription lacks the page wikilink", async () => {
		const cwd = await tempCwd();
		await bootstrapVault(cwd);
		const paths = resolveVaultPaths(cwd);
		const indexBefore = await readFile(paths.index, "utf-8");
		await assert.rejects(
			() =>
				createOrUpdatePage(cwd, {
					filename: "auth.md",
					content: "---\nstatus: active\n---\n\n# Auth\n",
					indexDescription: "- [[wrong]]: Wrong link.",
				}),
			/must include the wikilink \[\[auth\]\]/,
		);
		await assert.rejects(async () => readFile(path.join(paths.pages, "auth.md"), "utf-8"));
		const indexAfter = await readFile(paths.index, "utf-8");
		assert.equal(indexAfter, indexBefore);
	});

	it("allows updating an existing page without indexDescription", async () => {
		const cwd = await tempCwd();
		await bootstrapVault(cwd);
		await createOrUpdatePage(cwd, {
			filename: "keep.md",
			content: "---\nstatus: active\n---\n\nv1\n",
			indexDescription: "- [[keep]]: Keep page.",
		});
		const updated = await createOrUpdatePage(cwd, {
			filename: "keep.md",
			content: "---\nstatus: active\n---\n\nv2\n",
		});
		assert.match(updated, /updated/);
		const body = await readFile(path.join(resolveVaultPaths(cwd).pages, "keep.md"), "utf-8");
		assert.match(body, /v2/);
	});

	it("rejects commit of orphan new pages without index coverage", async () => {
		const cwd = await tempCwd();
		await activateVault(cwd);
		await assert.rejects(
			() =>
				commitMemory(cwd, {
					dailySummary: "Bad commit",
					newPages: [
						{
							filename: "lonely.md",
							content: "---\nstatus: active\n---\n\n# Lonely\n",
						},
					],
				}),
			/requires an indexAppend/,
		);
	});

	it("bounds search results and finds matches", async () => {
		const cwd = await tempCwd();
		await bootstrapVault(cwd);
		await createOrUpdatePage(cwd, {
			filename: "needle.md",
			content: "---\nstatus: active\n---\n\nunique-token-xyz\n",
			indexDescription: "- [[needle]]: Needle page.",
		});
		const hit = await searchVaultPages(cwd, "unique-token-xyz");
		assert.match(hit, /needle\.md:.*unique-token-xyz/);

		const many = "match-line\n".repeat(MAX_SEARCH_RESULTS + 5);
		await createOrUpdatePage(cwd, {
			filename: "spam.md",
			content: `---\nstatus: active\n---\n\n${many}`,
			indexDescription: "- [[spam]]: Spam page.",
		});
		const bounded = await searchVaultPages(cwd, "match-line");
		assert.match(bounded, /truncated/);
	});

	it("rejects path-like filenames instead of writing outside pages/", async () => {
		const cwd = await tempCwd();
		await bootstrapVault(cwd);
		await assert.rejects(
			() =>
				createOrUpdatePage(cwd, {
					filename: "../../outside.md",
					content: "---\nstatus: active\n---\n\nsafe\n",
					indexDescription: "- [[outside]]: Outside attempt.",
				}),
			/bare name|path separators/,
		);
	});

	it("reports no Echoes presence until vault or state exists", async () => {
		const cwd = await tempCwd();
		assert.equal(await hasExistingEchoesPresence(cwd), false);
		await mkdir(path.join(cwd, "EchoesVault"), { recursive: true });
		assert.equal(await hasExistingEchoesPresence(cwd), true);
		const empty = await tempCwd();
		await mkdir(path.join(empty, ".pi"), { recursive: true });
		await writeFile(statePath(empty), JSON.stringify({ version: 1 }) + "\n");
		assert.equal(await hasExistingEchoesPresence(empty), true);
	});

	it("hasExistingVault requires directory + index.md, not state-only", async () => {
		const cwd = await tempCwd();
		assert.equal(await hasExistingVault(cwd), false);
		await mkdir(path.join(cwd, "EchoesVault"), { recursive: true });
		assert.equal(await hasExistingVault(cwd), false);
		await writeFile(path.join(cwd, "EchoesVault", "index.md"), DEFAULT_INDEX);
		assert.equal(await hasExistingVault(cwd), true);

		const stateOnly = await tempCwd();
		await mkdir(path.join(stateOnly, ".pi"), { recursive: true });
		await writeFile(statePath(stateOnly), JSON.stringify({ version: 1, initialized: true }) + "\n");
		assert.equal(await hasExistingVault(stateOnly), false);
		assert.equal(await hasExistingEchoesPresence(stateOnly), true);
	});

	it("migrates v1 state to v2 defaults without dropping old fields", async () => {
		const cwd = await tempCwd();
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			statePath(cwd),
			JSON.stringify({
				version: 1,
				pluginVersion: "0.0.9",
				initialized: true,
				session: {
					started: true,
					saved: false,
					lastStart: "2026-01-01T00:00:00.000Z",
					lastSave: null,
				},
				stats: { totalPages: 3, totalDailyLogs: 1, deprecatedPages: 0 },
			}) + "\n",
		);
		const st = await readState(cwd);
		assert.equal(st.version, STATE_VERSION);
		assert.equal(st.initialized, true);
		assert.equal(st.pluginVersion, "0.0.9");
		assert.equal(st.session.started, true);
		assert.equal(st.session.saved, false);
		assert.equal(st.session.lastStart, "2026-01-01T00:00:00.000Z");
		assert.equal(st.session.startPromptSent, false);
		assert.equal(st.session.endPromptSent, false);
		assert.equal(st.session.endPending, false);
		assert.equal(st.stats.totalPages, 3);
	});

	it("normalizes malformed-but-valid JSON state fields by type", async () => {
		const cwd = await tempCwd();
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			statePath(cwd),
			JSON.stringify({
				version: 2,
				pluginVersion: 123,
				initialized: "yes",
				session: {
					started: 1,
					saved: "false",
					startPromptSent: "true",
					endPromptSent: null,
					endPending: {},
					lastStart: 42,
					lastSave: false,
				},
				stats: {
					totalPages: -3,
					totalDailyLogs: "5",
					deprecatedPages: Number.NaN,
				},
			}) + "\n",
		);
		const st = await readState(cwd);
		assert.equal(st.version, STATE_VERSION);
		assert.equal(st.pluginVersion, "0.1.0");
		assert.equal(st.initialized, false);
		assert.equal(st.session.started, false);
		assert.equal(st.session.saved, false);
		assert.equal(st.session.startPromptSent, false);
		assert.equal(st.session.endPromptSent, false);
		assert.equal(st.session.endPending, false);
		assert.equal(st.session.lastStart, null);
		assert.equal(st.session.lastSave, null);
		assert.equal(st.stats.totalPages, 0);
		assert.equal(st.stats.totalDailyLogs, 0);
		assert.equal(st.stats.deprecatedPages, 0);
	});

	it("serializes concurrent state mutations for the same cwd", async () => {
		const cwd = await tempCwd();
		await activateVault(cwd);
		const { withVaultMutation, writeState: ws, readState: rs } = await import("../src/vault.ts");

		let midReadSaved: boolean | undefined;
		const writer = withVaultMutation(cwd, async () => {
			const st = await rs(cwd);
			st.session.started = true;
			st.session.saved = false;
			await new Promise((r) => setTimeout(r, 30));
			st.session.saved = true;
			st.session.started = false;
			await ws(cwd, st);
			return "writer";
		});
		const reader = (async () => {
			await new Promise((r) => setTimeout(r, 5));
			return withVaultMutation(cwd, async () => {
				const st = await rs(cwd);
				midReadSaved = st.session.saved;
				return "reader";
			});
		})();

		const [a, b] = await Promise.all([writer, reader]);
		assert.equal(a, "writer");
		assert.equal(b, "reader");
		assert.equal(midReadSaved, true, "reader must observe writer completion");
		assert.equal((await rs(cwd)).session.saved, true);
	});

	it("serializes concurrent createOrUpdatePage so both pages and index entries survive", async () => {
		const cwd = await tempCwd();
		await bootstrapVault(cwd);
		const paths = resolveVaultPaths(cwd);

		const [a, b] = await Promise.all([
			createOrUpdatePage(cwd, {
				filename: "alpha.md",
				content: "---\nstatus: active\n---\n\n# Alpha\n",
				indexDescription: "- [[alpha]]: Alpha page.",
			}),
			createOrUpdatePage(cwd, {
				filename: "beta.md",
				content: "---\nstatus: active\n---\n\n# Beta\n",
				indexDescription: "- [[beta]]: Beta page.",
			}),
		]);
		assert.match(a, /created/);
		assert.match(b, /created/);

		const alpha = await readFile(path.join(paths.pages, "alpha.md"), "utf-8");
		const beta = await readFile(path.join(paths.pages, "beta.md"), "utf-8");
		assert.match(alpha, /# Alpha/);
		assert.match(beta, /# Beta/);

		const index = await readFile(paths.index, "utf-8");
		assert.match(index, /\[\[alpha\]\]/);
		assert.match(index, /\[\[beta\]\]/);

		const st = await readState(cwd);
		assert.equal(st.stats.totalPages, 2);
	});

	it("startSession preserves endPending; commit clears it and marks saved", async () => {
		const cwd = await tempCwd();
		await activateVault(cwd);
		const pending = await readState(cwd);
		pending.session.endPending = true;
		await writeState(cwd, pending);

		const started = await startSession(cwd);
		assert.equal(started.session.started, true);
		assert.equal(started.session.saved, false);
		assert.equal(started.session.startPromptSent, false);
		assert.equal(started.session.endPromptSent, false);
		assert.equal(started.session.endPending, true);
		assert.equal(await needsAutomaticEnd(cwd), true);

		await commitMemory(cwd, { dailySummary: "Recovered and saved." });
		const after = await readState(cwd);
		assert.equal(after.session.started, false);
		assert.equal(after.session.saved, true);
		assert.equal(after.session.endPromptSent, true);
		assert.equal(after.session.endPending, false);
		assert.equal(await needsAutomaticEnd(cwd), false);
	});

	it("recordEndPendingOnQuit only for unsaved started vault sessions", async () => {
		const bare = await tempCwd();
		assert.equal(await recordEndPendingOnQuit(bare), false);

		const cwd = await tempCwd();
		await activateVault(cwd);
		assert.equal(await recordEndPendingOnQuit(cwd), false, "not started yet");

		await startSession(cwd);
		assert.equal(await recordEndPendingOnQuit(cwd), true);
		assert.equal((await readState(cwd)).session.endPending, true);

		await commitMemory(cwd, { dailySummary: "Saved before quit." });
		assert.equal(await recordEndPendingOnQuit(cwd), false, "already saved");
		assert.equal((await readState(cwd)).session.endPending, false);
	});
});
