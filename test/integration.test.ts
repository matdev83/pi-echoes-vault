import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import echoesExtension from "../extensions/echoes-vault.ts";

const cleanup: string[] = [];
after(async () =>
	Promise.all(cleanup.map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))),
);

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

type InjectedMessage = { role?: string; content?: Array<{ type?: string; text?: string }> };
type ContextResult = { messages?: InjectedMessage[] } | undefined;

function createMockPi(mode = "tui") {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const api = {
		registerTool(def: { name: string }) {
			tools.push(def.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	function ctx(cwd: string) {
		return {
			cwd,
			mode,
			hasUI: mode === "tui",
			isIdle: () => true,
			getSystemPrompt: () => "base system prompt",
			sessionManager: { getSessionFile: () => undefined },
			ui: { notify() {} },
		};
	}
	async function emit(event: string, payload: unknown, cwd: string) {
		const results: unknown[] = [];
		for (const h of handlers.get(event) ?? []) results.push(await h(payload, ctx(cwd)));
		return results;
	}
	return { api, handlers, emit, sent, tools, commands };
}

async function vaultDir(): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "echoes-int-"));
	cleanup.push(cwd);
	await mkdir(path.join(cwd, "EchoesVault"), { recursive: true });
	await writeFile(path.join(cwd, "EchoesVault", "index.md"), "# Index\n");
	return cwd;
}

const BEFORE = { type: "before_agent_start", prompt: "hi", systemPrompt: "base system prompt" };
const CONTEXT = {
	type: "context",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
};

function injectedText(result: ContextResult): string | undefined {
	const appended = result?.messages?.at(-1);
	if (appended?.role !== "user") return undefined;
	return appended.content?.map((c) => c.text ?? "").join("\n");
}

describe("Extension chain integration (mock harness)", () => {
	it("injects git context as a genuine user-role message once per logical session", async () => {
		const cwd = await vaultDir();
		const mock = createMockPi();
		echoesExtension(mock.api as never);

		const first = (await mock.emit("context", CONTEXT, cwd))[0] as ContextResult;
		assert.ok(first?.messages, "context handler returns modified messages");
		const appended = first.messages!.at(-1)!;
		assert.equal(appended.role, "user", "injected message must use the standard user role");
		assert.match(injectedText(first) ?? "", /EchoesVault|not inside a Git repository/);
		assert.equal(first.messages!.length, CONTEXT.messages.length + 1, "original messages preserved");

		const second = (await mock.emit("context", CONTEXT, cwd))[0] as ContextResult;
		assert.equal(second, undefined, "injects only once per logical session");

		const beforeResults = await mock.emit("before_agent_start", BEFORE, cwd);
		assert.equal(beforeResults.length, 0, "no before_agent_start handler remains");
	});

	it("git-context injection does not depend on system-prompt overrides", async () => {
		const cwd = await vaultDir();
		const mock = createMockPi();
		echoesExtension(mock.api as never);
		mock.api.on("before_agent_start", async () => ({ systemPrompt: "OVERWRITTEN" }));

		const results = (await mock.emit("context", CONTEXT, cwd))[0] as ContextResult;
		assert.match(injectedText(results) ?? "", /EchoesVault|not inside a Git repository/);
	});

	it("respects gitContext opt-out", async () => {
		const cwd = await vaultDir();
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(cwd, ".pi", "echoes-config.json"), JSON.stringify({ gitContext: false }));
		const mock = createMockPi();
		echoesExtension(mock.api as never);
		const results = await mock.emit("context", CONTEXT, cwd);
		assert.equal(results[0], undefined);
	});

	it("respects automaticActions opt-out", async () => {
		const cwd = await vaultDir();
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "echoes-config.json"),
			JSON.stringify({ automaticActions: false }),
		);
		const mock = createMockPi();
		echoesExtension(mock.api as never);
		const results = await mock.emit("context", CONTEXT, cwd);
		assert.equal(results[0], undefined);
	});

	it("injects nothing when there is no EchoesVault directory", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "echoes-novault-"));
		cleanup.push(cwd);
		const mock = createMockPi();
		echoesExtension(mock.api as never);
		const results = await mock.emit("context", CONTEXT, cwd);
		assert.equal(results[0], undefined);
	});

	it("logical session replacement resets injection and never sends an automatic turn", async () => {
		const cwd = await vaultDir();
		const mock = createMockPi();
		echoesExtension(mock.api as never);

		const first = (await mock.emit("context", CONTEXT, cwd))[0] as ContextResult;
		assert.ok(first?.messages, "injects on first turn");
		const second = (await mock.emit("context", CONTEXT, cwd))[0] as ContextResult;
		assert.equal(second, undefined, "deduped within a session");

		for (const reason of ["new", "resume", "fork"] as const) {
			await mock.emit("session_start", { type: "session_start", reason }, cwd);
			const after = (await mock.emit("context", CONTEXT, cwd))[0] as ContextResult;
			assert.ok(after?.messages, `re-injects after ${reason}`);
		}
		assert.equal(mock.sent.length, 0, "no automatic user turn is ever sent");
	});
});

describe("Subagent session handling", () => {
	it("registers nothing when nested-session env markers are present at load", async () => {
		const cwd = await vaultDir();
		const mock = createMockPi();
		process.env.PI_SESSION_ID = "echoes-test-subagent";
		try {
			echoesExtension(mock.api as never);
		} finally {
			delete process.env.PI_SESSION_ID;
		}
		assert.deepEqual(mock.tools, [], "no tools in a subagent session");
		assert.deepEqual(mock.commands, [], "no commands in a subagent session");
		assert.equal([...mock.handlers.values()].flat().length, 0, "no event handlers in a subagent session");

		const results = await mock.emit("context", CONTEXT, cwd);
		assert.equal(results.length, 0, "nothing to inject with");
		assert.equal(mock.sent.length, 0);
	});

	it("injects nothing at runtime when the bound mode is headless", async () => {
		const cwd = await vaultDir();
		const mock = createMockPi("json");
		echoesExtension(mock.api as never);

		const contextResults = await mock.emit("context", CONTEXT, cwd);
		assert.equal(contextResults[0], undefined, "context injection skipped in json mode");

		await mock.emit("session_start", { type: "session_start", reason: "startup" }, cwd);
		const switchResults = await mock.emit("session_before_switch", { type: "session_before_switch" }, cwd);
		assert.equal(switchResults[0], undefined, "pre-close save flow skipped in json mode");
		assert.equal(mock.sent.length, 0, "no prompts ever sent in json mode");
	});
});

describe("Real Pi resource-loader integration", () => {
	it("loads the extension through DefaultResourceLoader and its user-role message survives a competing customizer", async () => {
		const cwd = await vaultDir();
		const agentDir = await mkdtemp(path.join(tmpdir(), "echoes-agent-"));
		cleanup.push(agentDir);
		const competitor = (pi: { on: (e: string, h: Handler) => void }) => {
			pi.on("before_agent_start", async (event) => ({
				systemPrompt: `${(event as { systemPrompt: string }).systemPrompt}\nOVERWRITTEN`,
			}));
		};
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [echoesExtension as never, competitor as never],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		assert.equal(result.errors.length, 0, JSON.stringify(result.errors));

		const echoes = result.extensions.find((e) => (e.handlers.get("context")?.length ?? 0) > 0);
		assert.ok(echoes, "echoes must register a context handler");

		let injected: ContextResult;
		let systemPrompt = "base";
		for (const ext of result.extensions) {
			for (const handler of ext.handlers.get("context") ?? []) {
				const r = (await handler(structuredClone(CONTEXT), { cwd, mode: "tui", hasUI: true })) as ContextResult;
				if (r?.messages?.length) injected = r;
			}
			for (const handler of ext.handlers.get("before_agent_start") ?? []) {
				const r = (await handler(BEFORE, { cwd })) as { systemPrompt?: string };
				if (r?.systemPrompt) systemPrompt = r.systemPrompt;
			}
		}
		const appended = injected?.messages?.at(-1);
		assert.equal(appended?.role, "user", "injected message must use the standard user role");
		assert.match(
			appended?.content?.map((c) => c.text ?? "").join("\n") ?? "",
			/EchoesVault|not inside a Git repository/,
		);
		assert.match(systemPrompt, /OVERWRITTEN/, "competitor still customizes the system prompt");
	});
});
