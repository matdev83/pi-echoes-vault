/**
 * Deterministic smoke checks that do not require a live Pi session.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	activateVault,
	appendDailyLog,
	commitMemory,
	createOrUpdatePage,
	hasExistingEchoesPresence,
	hasExistingVault,
	readState,
	searchVaultPages,
	startSession,
	statePath,
	resolveVaultPaths,
	STATE_VERSION,
	writeState,
} from "../src/vault.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type ToolDef = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type CommandDef = {
	description?: string;
	handler: (args: string, ctx: MockCommandContext) => Promise<void>;
};

type MockCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: { getSessionFile: () => string | undefined };
	isIdle: () => boolean;
	ui: { notify: (message: string, level?: string) => void };
};

type SessionHandler = (event: unknown, ctx: MockCommandContext) => Promise<unknown>;

function createMockPi() {
	const tools: ToolDef[] = [];
	const commands = new Map<string, CommandDef>();
	const handlers = new Map<string, SessionHandler[]>();
	const messages: Array<{ content: string; opts?: { deliverAs?: string }; idle: boolean }> = [];
	const notifies: string[] = [];
	let idle = true;
	let failNextSend = false;

	const api = {
		registerTool(def: ToolDef) {
			tools.push(def);
		},
		registerCommand(name: string, def: CommandDef) {
			commands.set(name, def);
		},
		sendUserMessage(content: string, opts?: { deliverAs?: string }) {
			if (failNextSend) {
				failNextSend = false;
				throw new Error("simulated sendUserMessage failure");
			}
			messages.push({ content, opts, idle });
		},
		on(event: string, handler: SessionHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	function makeCtx(cwd: string): MockCommandContext {
		return {
			cwd,
			hasUI: true,
			sessionManager: { getSessionFile: () => undefined },
			isIdle: () => idle,
			ui: {
				notify(message: string) {
					notifies.push(message);
				},
			},
		};
	}

	async function emit(event: string, payload: unknown, cwd: string) {
		const list = handlers.get(event) ?? [];
		const results: unknown[] = [];
		for (const handler of list) {
			results.push(await handler(payload, makeCtx(cwd)));
		}
		return results;
	}

	return {
		api,
		tools,
		commands,
		handlers,
		messages,
		notifies,
		setIdle(value: boolean) {
			idle = value;
		},
		failNextSendOnce() {
			failNextSend = true;
		},
		makeCtx,
		emit,
	};
}

async function loadExtension() {
	const pkg = require(path.join(root, "package.json")) as {
		pi?: { extensions?: string[]; skills?: string[] };
		name?: string;
		peerDependencies?: Record<string, string>;
		description?: string;
	};
	assert.equal(pkg.name, "pi-echoes-vault");
	assert.ok(pkg.pi?.extensions?.length, "package.json pi.extensions required");
	assert.ok(pkg.pi?.skills?.length, "package.json pi.skills required");
	assert.ok(
		pkg.peerDependencies?.["@earendil-works/pi-coding-agent"],
		"peer must target @earendil-works/pi-coding-agent",
	);
	assert.match(pkg.description ?? "", /persistent agent memory/i);
	assert.match(pkg.description ?? "", /@earendil-works\/pi-coding-agent/);

	const extPath = path.join(root, pkg.pi!.extensions![0]!);
	const mod = await import(pathToFileURL(extPath).href);
	assert.equal(typeof mod.default, "function", "extension default export must be a function");
	return { pkg, mod };
}

async function main() {
	const { mod } = await loadExtension();
	const mock = createMockPi();
	mod.default(mock.api);

	const toolNames = mock.tools.map((t) => t.name).sort();
	assert.deepEqual(toolNames, [
		"commit_memory_to_echoes_vault",
		"echoes_append_to_daily_log",
		"echoes_create_or_update_page",
		"echoes_search_vault_pages",
	]);
	assert.deepEqual(
		[...mock.commands.keys()].sort(),
		["echoes-end", "echoes-init", "echoes-start", "echoes-status"],
	);
	assert.equal((mock.handlers.get("session_start") ?? []).length, 1);
	assert.equal((mock.handlers.get("session_before_switch") ?? []).length, 1);
	assert.equal((mock.handlers.get("session_before_fork") ?? []).length, 1);
	assert.equal((mock.handlers.get("session_shutdown") ?? []).length, 1);
	assert.equal((mock.handlers.get("agent_start") ?? []).length, 1);
	assert.equal((mock.handlers.get("agent_settled") ?? []).length, 1);

	const cwd = await mkdtemp(path.join(tmpdir(), "echoes-smoke-"));
	const unrelated = await mkdtemp(path.join(tmpdir(), "echoes-unrelated-"));
	const lifecycle = await mkdtemp(path.join(tmpdir(), "echoes-life-"));
	const dirsToClean = [cwd, unrelated, lifecycle];

	try {
		// session_start must not create a vault in an unrelated project
		await mock.emit("session_start", { type: "session_start", reason: "startup" }, unrelated);
		assert.equal(await hasExistingEchoesPresence(unrelated), false);
		assert.equal(await hasExistingVault(unrelated), false);
		await assert.rejects(() => access(resolveVaultPaths(unrelated).vault));

		mock.setIdle(true);
		await mock.commands.get("echoes-init")!.handler("", mock.makeCtx(cwd));
		assert.ok(mock.messages.some((m) => m.content.includes("EchoesVault Keeper") && !m.opts));
		const initState = await readState(cwd);
		assert.equal(initState.version, STATE_VERSION);
		assert.equal(initState.session.started, false);
		assert.equal(initState.session.startPromptSent, false);

		mock.messages.length = 0;
		mock.notifies.length = 0;
		mock.setIdle(false);
		await mock.commands.get("echoes-start")!.handler("", mock.makeCtx(cwd));
		assert.ok(
			mock.messages.some(
				(m) => m.content.includes("Context Restoration") && m.opts?.deliverAs === "followUp",
			),
			"busy start should queue followUp delivery",
		);
		assert.ok(mock.notifies.some((n) => /busy/i.test(n) || /session started/i.test(n)));
		assert.equal((await readState(cwd)).session.startPromptSent, true);

		// Manual dedupe within same runtime
		mock.messages.length = 0;
		mock.setIdle(true);
		await mock.commands.get("echoes-start")!.handler("", mock.makeCtx(cwd));
		assert.equal(mock.messages.length, 0);
		assert.ok(mock.notifies.some((n) => /already started/i.test(n)));

		await appendDailyLog(cwd, "- smoke note");
		await createOrUpdatePage(cwd, {
			filename: "smoke.md",
			content: "---\ntype: note\nstatus: active\n---\n\n# Smoke\nkeyword-smoke-42\n",
			indexDescription: "- [[smoke]]: Smoke page.",
		});
		const found = await searchVaultPages(cwd, "keyword-smoke-42");
		assert.match(found, /smoke\.md/);
		const committed = await commitMemory(cwd, { dailySummary: "Smoke complete." });
		assert.match(committed, /Memory committed/);
		const state = JSON.parse(await readFile(statePath(cwd), "utf-8"));
		assert.equal(state.initialized, true);
		assert.equal(state.session.started, false);
		assert.equal(state.session.saved, true);
		assert.equal(state.session.endPending, false);

		// --- Lifecycle project ---
		await activateVault(lifecycle);
		mock.messages.length = 0;
		mock.notifies.length = 0;
		mock.setIdle(true);

		await mock.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			lifecycle,
		);
		assert.equal(mock.messages.length, 0, "automatic startup must not inject agent context");
		assert.equal((await readState(lifecycle)).session.started, true);
		assert.equal((await readState(lifecycle)).session.startPromptSent, false);

		// Reload must not re-send start
		mock.messages.length = 0;
		await mock.emit("session_start", { type: "session_start", reason: "reload" }, lifecycle);
		assert.equal(mock.messages.length, 0);

		// Unsaved before_switch: send end once and cancel
		mock.messages.length = 0;
		mock.notifies.length = 0;
		const switchResults = await mock.emit(
			"session_before_switch",
			{ type: "session_before_switch", reason: "new" },
			lifecycle,
		);
		assert.deepEqual(switchResults[0], { cancel: true });
		assert.ok(
			mock.messages.some(
				(m) =>
					m.content.includes("Session Distillation") &&
					m.content.includes("automatic pre-session-close"),
			),
		);
		assert.equal((await readState(lifecycle)).session.endPromptSent, true);

		// Second before_switch while in-flight: cancel again, no duplicate prompt
		mock.messages.length = 0;
		const switchAgain = await mock.emit(
			"session_before_switch",
			{ type: "session_before_switch", reason: "new" },
			lifecycle,
		);
		assert.deepEqual(switchAgain[0], { cancel: true });
		assert.equal(mock.messages.length, 0);

		// Failed/no-commit end turn: agent_settled clears endPromptSent (no auto-loop)
		mock.messages.length = 0;
		mock.notifies.length = 0;
		await mock.emit("agent_settled", { type: "agent_settled" }, lifecycle);
		assert.equal((await readState(lifecycle)).session.endPromptSent, false);
		assert.equal((await readState(lifecycle)).session.saved, false);
		assert.equal(mock.messages.length, 0, "agent_settled must not auto-requeue end prompt");
		assert.ok(mock.notifies.some((n) => /did not commit/i.test(n)));

		// Retry after settlement is allowed and still cancels
		mock.messages.length = 0;
		const retrySwitch = await mock.emit(
			"session_before_switch",
			{ type: "session_before_switch", reason: "new" },
			lifecycle,
		);
		assert.deepEqual(retrySwitch[0], { cancel: true });
		assert.ok(mock.messages.some((m) => m.content.includes("Session Distillation")));

		// Successful commit suppresses further end fallback
		await commitMemory(lifecycle, { dailySummary: "Lifecycle saved." });
		// Direct domain commit does not clear runtime endPhase — settle once.
		await mock.emit("agent_settled", { type: "agent_settled" }, lifecycle);
		mock.messages.length = 0;
		const afterSave = await mock.emit(
			"session_before_switch",
			{ type: "session_before_switch", reason: "new" },
			lifecycle,
		);
		assert.equal(afterSave[0], undefined);
		assert.equal(mock.messages.length, 0);

		// Automatic logical starts remain silent; explicit /echoes-start restores once.
		const sameInst = await mkdtemp(path.join(tmpdir(), "echoes-sameinst-"));
		dirsToClean.push(sameInst);
		await activateVault(sameInst);
		for (const reason of ["startup", "new", "resume", "fork"] as const) {
			if (reason !== "startup") await commitMemory(sameInst, { dailySummary: `Before ${reason}.` });
			mock.messages.length = 0;
			await mock.emit("session_start", { type: "session_start", reason }, sameInst);
			assert.equal(mock.messages.length, 0, `automatic session_start/${reason} must be silent`);
			assert.equal((await readState(sameInst)).session.started, true);
		}
		await mock.commands.get("echoes-start")!.handler("", mock.makeCtx(sameInst));
		assert.ok(mock.messages.some((m) => m.content.includes("Context Restoration")));
		mock.messages.length = 0;
		await mock.commands.get("echoes-start")!.handler("", mock.makeCtx(sameInst));
		assert.equal(mock.messages.length, 0, "manual restoration remains deduped");

		// Reload still excluded (no second start) after a prior restore on this instance
		mock.messages.length = 0;
		await mock.emit("session_start", { type: "session_start", reason: "reload" }, sameInst);
		assert.equal(mock.messages.length, 0, "reload must not re-send start on same instance");

		// FollowUp end: unrelated settlement must not clear before agent_start
		const followCwd = await mkdtemp(path.join(tmpdir(), "echoes-follow-"));
		dirsToClean.push(followCwd);
		await activateVault(followCwd);
		await startSession(followCwd);
		const mockFollow = createMockPi();
		mod.default(mockFollow.api);
		mockFollow.setIdle(false);
		mockFollow.messages.length = 0;
		await mockFollow.commands.get("echoes-end")!.handler("", mockFollow.makeCtx(followCwd));
		assert.ok(mockFollow.messages.some((m) => m.opts?.deliverAs === "followUp"));
		assert.equal((await readState(followCwd)).session.endPromptSent, true);
		await mockFollow.emit("agent_settled", { type: "agent_settled" }, followCwd);
		assert.equal(
			(await readState(followCwd)).session.endPromptSent,
			true,
			"queued followUp must ignore unrelated settlement",
		);
		await mockFollow.emit("agent_start", { type: "agent_start" }, followCwd);
		mockFollow.notifies.length = 0;
		await mockFollow.emit("agent_settled", { type: "agent_settled" }, followCwd);
		assert.equal((await readState(followCwd)).session.endPromptSent, false);
		assert.ok(mockFollow.notifies.some((n) => /did not commit/i.test(n)));
		assert.equal(mockFollow.messages.filter((m) => m.content.includes("Session Distillation")).length, 1);

		// --- new/resume/fork after prior start/save remain silent ---
		const afterCommit = await readState(lifecycle);
		assert.equal(afterCommit.session.saved, true);
		assert.equal(afterCommit.session.startPromptSent, false);

		const mock2 = createMockPi();
		mod.default(mock2.api);
		mock2.setIdle(true);
		mock2.messages.length = 0;
		await mock2.emit("session_start", { type: "session_start", reason: "new" }, lifecycle);
		assert.equal(mock2.messages.length, 0, "automatic new session must be silent");
		assert.equal((await readState(lifecycle)).session.started, true);
		assert.equal((await readState(lifecycle)).session.saved, false);

		await commitMemory(lifecycle, { dailySummary: "After new." });
		const mockResume = createMockPi();
		mod.default(mockResume.api);
		mockResume.messages.length = 0;
		await mockResume.emit(
			"session_start",
			{ type: "session_start", reason: "resume" },
			lifecycle,
		);
		assert.equal(mockResume.messages.length, 0, "automatic resume must be silent");

		await commitMemory(lifecycle, { dailySummary: "After resume." });
		const mockFork = createMockPi();
		mod.default(mockFork.api);
		mockFork.messages.length = 0;
		await mockFork.emit("session_start", { type: "session_start", reason: "fork" }, lifecycle);
		assert.equal(mockFork.messages.length, 0, "automatic fork must be silent");

		// Process-like restart with persisted startPromptSent + endPending
		await startSession(lifecycle);
		const pending = await readState(lifecycle);
		pending.session.startPromptSent = true;
		pending.session.endPending = true;
		pending.session.saved = false;
		pending.session.started = true;
		pending.session.endPromptSent = false;
		await writeState(lifecycle, pending);

		const mockCrossProject = createMockPi();
		mod.default(mockCrossProject.api);
		await mockCrossProject.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			lifecycle,
		);
		assert.equal(mockCrossProject.messages.length, 0, "cross-project startup must be silent");
		assert.ok(
			mockCrossProject.notifies.every((m) => !m.includes("Started EchoesVault updates")),
			"recovery must not start from another launch folder",
		);
		assert.equal((await readState(lifecycle)).session.endPending, true);

		const originalCwd = process.cwd();
		process.chdir(lifecycle);
		const mockRestart = createMockPi();
		try {
			mod.default(mockRestart.api);
		} finally {
			process.chdir(originalCwd);
		}
		await mockRestart.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			lifecycle,
		);
		assert.ok(
			mockRestart.notifies.some(
				(m) => m === `Started EchoesVault updates for "${lifecycle}" in the background.`,
			),
			"same-folder pending recovery notification must identify the project",
		);
		assert.ok(
			mockRestart.messages.every((m) => !m.content.includes("UNSAVED PREVIOUS SESSION RECOVERY")),
			"recovery instructions must not pollute the interactive context",
		);

		// session_shutdown quit records endPending only when unsaved+started
		const quitCwd = await mkdtemp(path.join(tmpdir(), "echoes-quit-"));
		dirsToClean.push(quitCwd);
		await activateVault(quitCwd);
		await startSession(quitCwd);
		await mockRestart.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			quitCwd,
		);
		assert.equal((await readState(quitCwd)).session.endPending, true);

		const cleared = await readState(quitCwd);
		cleared.session.endPending = false;
		cleared.session.started = true;
		cleared.session.saved = false;
		await writeState(quitCwd, cleared);
		await mockRestart.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "reload" },
			quitCwd,
		);
		assert.equal((await readState(quitCwd)).session.endPending, false);

		// Absent-vault manual end: notify, send nothing, do not create vault
		const absent = await mkdtemp(path.join(tmpdir(), "echoes-absent-"));
		dirsToClean.push(absent);
		const mockAbsent = createMockPi();
		mod.default(mockAbsent.api);
		mockAbsent.messages.length = 0;
		mockAbsent.notifies.length = 0;
		await mockAbsent.commands.get("echoes-end")!.handler("", mockAbsent.makeCtx(absent));
		assert.equal(mockAbsent.messages.length, 0);
		assert.ok(mockAbsent.notifies.some((n) => /echoes-init/i.test(n)));
		assert.equal(await hasExistingVault(absent), false);
		await assert.rejects(() => access(resolveVaultPaths(absent).vault));

		// Sync delivery failure clears end flags so retry is possible
		const failCwd = await mkdtemp(path.join(tmpdir(), "echoes-fail-"));
		dirsToClean.push(failCwd);
		await activateVault(failCwd);
		await startSession(failCwd);
		const mockFail = createMockPi();
		mod.default(mockFail.api);
		mockFail.failNextSendOnce();
		await assert.rejects(
			() => mockFail.commands.get("echoes-end")!.handler("", mockFail.makeCtx(failCwd)),
			/simulated sendUserMessage failure/,
		);
		assert.equal((await readState(failCwd)).session.endPromptSent, false);
		mockFail.messages.length = 0;
		await mockFail.commands.get("echoes-end")!.handler("", mockFail.makeCtx(failCwd));
		assert.ok(mockFail.messages.some((m) => m.content.includes("Session Distillation")));

		// State-only project: no auto-start
		const stateOnly = await mkdtemp(path.join(tmpdir(), "echoes-stateonly-"));
		dirsToClean.push(stateOnly);
		await mkdir(path.join(stateOnly, ".pi"), { recursive: true });
		await writeFile(
			statePath(stateOnly),
			JSON.stringify({ version: 1, initialized: true, session: { started: false, saved: false } }) +
				"\n",
		);
		mock.messages.length = 0;
		await mock.emit("session_start", { type: "session_start", reason: "startup" }, stateOnly);
		assert.equal(mock.messages.length, 0);
		assert.equal(await hasExistingVault(stateOnly), false);

		console.log("smoke: ok");
	} finally {
		for (const d of dirsToClean) {
			await rm(d, { recursive: true, force: true }).catch(() => {});
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
