import * as fs from "node:fs/promises";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	claimPendingRecovery,
	commitMemory,
	readState,
	releasePendingRecovery,
	type CommitArgs,
} from "./vault.ts";

export type RecoveryResult = "not-pending" | "started";

export type RecoveryDeps = {
	run?: (cwd: string, transcript: string) => Promise<void>;
};

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

async function readTranscript(sessionFile: string): Promise<string> {
	if (!sessionFile) return "No persisted transcript was available. Recover only from EchoesVault daily logs.";
	try {
		return await fs.readFile(sessionFile, "utf-8");
	} catch {
		return "The interrupted session transcript was unavailable. Recover only from EchoesVault daily logs.";
	}
}

async function runSdkRecovery(cwd: string, transcript: string): Promise<void> {
	const commitTool: ToolDefinition = {
		name: "commit_memory_to_echoes_vault",
		label: "Commit Recovered Memory",
		description: "Commit recovered interrupted-session memory to this project's EchoesVault.",
		parameters: Type.Object({
			dailySummary: Type.String(),
			newPages: Type.Optional(Type.Array(Type.Object({ filename: Type.String(), content: Type.String() }))),
			indexAppends: Type.Optional(Type.Array(Type.String())),
			indexUpdates: Type.Optional(
				Type.Array(Type.Object({ oldLine: Type.String(), newLine: Type.String() })),
			),
		}),
		async execute(_id, params) {
			return textResult(await commitMemory(cwd, params as CommitArgs, { recovery: true }));
		},
	};

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: process.env.PI_CODING_AGENT_DIR ?? process.cwd(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are an isolated EchoesVault recovery worker. Do not modify project files except through the commit tool.",
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		noTools: "builtin",
		tools: ["commit_memory_to_echoes_vault"],
		customTools: [commitTool],
	});
	try {
		await session.prompt(`Recover only factual, unsaved outcomes from the interrupted session transcript below. Call commit_memory_to_echoes_vault exactly once with a concise dailySummary and any justified documentation updates. If there are no recoverable facts, still commit a short summary stating that no additional facts were recoverable so this recovery does not repeat.\n\n<interrupted_session_jsonl>\n${transcript}\n</interrupted_session_jsonl>`);
		if ((await readState(cwd)).session.endPending) {
			throw new Error("Background recovery finished without committing memory");
		}
	} finally {
		session.dispose();
	}
}

/** Claim and launch isolated recovery without adding anything to the interactive agent context. */
export async function startBackgroundRecovery(
	cwd: string,
	deps: RecoveryDeps = {},
): Promise<RecoveryResult> {
	const sessionFile = await claimPendingRecovery(cwd);
	if (sessionFile === null) return "not-pending";
	const transcript = await readTranscript(sessionFile);
	const run = deps.run ?? runSdkRecovery;
	void run(cwd, transcript).catch(async () => {
		await releasePendingRecovery(cwd).catch(() => {});
	});
	return "started";
}
