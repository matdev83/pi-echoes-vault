/**
 * EchoesVault — Pi coding-agent extension.
 * Port of echoes-vault-opencode (MIT, Copyright 2026 Fail).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import {
	activateVault,
	appendDailyLog,
	bootstrapVault,
	clearEndPromptSent,
	commitMemory,
	createOrUpdatePage,
	formatStatusReport,
	getDateStr,
	hasExistingVault,
	markEndPromptSent,
	markStartPromptSent,
	needsAutomaticEnd,
	readRecentDailyLogs,
	readState,
	readTextOr,
	recordEndPendingOnQuit,
	refreshStats,
	refreshStatsOnReload,
	resolveVaultPaths,
	searchVaultPages,
	startSession,
	clearStartPromptSent,
} from "../src/vault.ts";
import { startBackgroundRecovery } from "../src/recovery.ts";

type DeliverCtx = {
	hasUI: boolean;
	isIdle: () => boolean;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
};

type PromptTrigger = "manual" | "automatic";

const AUTO_START_REASONS = new Set<SessionStartEvent["reason"]>([
	"startup",
	"new",
	"resume",
	"fork",
]);

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function notify(ctx: DeliverCtx, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function cwdKey(cwd: string): string {
	return path.resolve(cwd);
}

/** Deliver a materialized prompt even if the agent is busy. */
function deliverPrompt(pi: ExtensionAPI, ctx: DeliverCtx, content: string) {
	if (ctx.isIdle()) {
		pi.sendUserMessage(content);
	} else {
		pi.sendUserMessage(content, { deliverAs: "followUp" });
		notify(ctx, "EchoesVault prompt queued (agent busy)", "info");
	}
}

const INIT_PROMPT = `# ROLE: EchoesVault Keeper (Knowledge Base Architect)
You are an AI developer agent equipped with persistent memory. Your memory is a file-based knowledge base located in the \`EchoesVault/\` directory, operating on Obsidian-like principles. Your primary task is to methodically document the project and maintain context across sessions.

## MEMORY STRUCTURE
* \`EchoesVault/raw/\`: Raw source materials. Read-only.
* \`EchoesVault/pages/\`: The project encyclopedia. Markdown files detailing concepts, architecture, and logic.
* \`EchoesVault/daily/\`: The work log containing session summaries (YYYY-MM-DD.md).
* \`EchoesVault/assets/\`: Local storage for images, schematics, and diagrams.
* \`EchoesVault/index.md\`: The master registry. A list of all files in pages/ with a one-sentence description of each.

## CORE RULES (STRICTLY ENFORCED)
1. **Read-Before-Write:** Never hallucinate file contents. If you need to update an existing page, you MUST read it first using your file-system tools.
2. **Technical Density (ADR):** Write with maximum technical density. Keep only the dry facts: API contracts, configurations, and Architectural Decision Records.
3. **YAML Frontmatter:** Every new page MUST start with a YAML block for metadata at the very top of the file.
4. **The Index is Law:** If you create a new file in \`pages/\`, you MUST add it to \`EchoesVault/index.md\`. Format: \`- [[filename]]: One-sentence description.\`
5. **Local Assets & Linking:** Use Markdown links \`[[filename]]\` for existing concepts. Reference visuals with \`![[image.png]]\` from \`assets/\`.
6. **Deprecation over Deletion:** NEVER delete old documentation files. Prepend \`> [!warning] DEPRECATED\` and link to the replacement.
7. **Active Memory Management:** Use the \`echoes_append_to_daily_log\` tool during the conversation to offload context. Use \`echoes_search_vault_pages\` before inventing documentation.

## ACTION
The vault has already been activated and bootstrapped by the extension.

Read the current \`EchoesVault/index.md\` content below. If the index is empty/default, acknowledge a fresh vault. Otherwise, briefly acknowledge the rules and list key concepts already present.

<index>
{{INDEX}}
</index>
`;

const START_PROMPT = `# SYSTEM MESSAGE: Context Restoration
You are the EchoesVault Keeper. We are starting a new working session. Load context from previous sessions and audit knowledge-base integrity.

## TRIGGER
{{TRIGGER}}

## KEY REMINDERS
1. Maintain technical density (ADR style).
2. Enforce YAML metadata and use \`assets/\` for visual context (\`![[image.png]]\`).
3. Use \`> [!warning] DEPRECATED\` instead of deleting outdated files.
4. Read-Before-Write: do not invent file contents.
5. Active memory: use \`echoes_append_to_daily_log\` and \`echoes_search_vault_pages\` as needed.

## INPUT DATA
Here is the current registry (\`EchoesVault/index.md\`):
<index>
{{INDEX}}
</index>

Here is the concatenated work log from our LAST 3 SESSIONS:
<recent_logs>
{{RECENT_LOGS}}
</recent_logs>

## ACTION
The session has already been marked as started by the extension.
1. **Restore:** Briefly summarize where we left off and immediate next steps.
2. **Linting:** Briefly review the index for duplicates/orphans. If clean, say: "Index is healthy. Ready to code."
`;

const END_PROMPT = `# SYSTEM MESSAGE: Session Distillation (Distill & Save)
Our current session is coming to an end. Crystallize the knowledge gained today and commit it to EchoesVault.

Adhere to technical density: dry architectural facts, bug fixes, applied configurations, and explicit decisions. Use \`> [!warning] DEPRECATED\` if legacy logic was rewritten.

## TRIGGER
{{TRIGGER}}

## ACTION
You MUST invoke the tool \`commit_memory_to_echoes_vault\` immediately with:
* **dailySummary**: Dense wrap-up (final outcomes, blockers, next steps). Intermediate notes may already exist in today's log.
* **newPages**: Optional new encyclopedia pages for global concepts / ADRs.
* **indexAppends**: New index lines (e.g. \`- [[new-page]]: Description.\`).
* **indexUpdates**: Optional \`{ oldLine, newLine }\` replacements in the index.

If memory has already been committed during this session, do not commit again.
Otherwise compile these and call the tool exactly once now.
`;

const STATUS_PROMPT = `# SYSTEM MESSAGE: Vault Status Report
Provide a fast, token-efficient metrics dashboard. Do NOT analyze deep architectural meaning.

## INPUT DATA
<index>
{{INDEX}}
</index>

<today_log>
{{TODAY_LOG}}
</today_log>

## Extension-computed stats
{{STATS}}

## ACTION
Output a concise bulleted dashboard:
* **Total Topics:** [count from index / pages]
* **Deprecated Pages:** [count]
* **Today's Session:** [Active / Not started]
* **Index Health:** [Healthy / Warning]

If total topics > 200, append a \`> [!warning] SCALE ALERT\` block. Keep under 90 words. No filler.
`;

function startTriggerText(trigger: PromptTrigger): string {
	return trigger === "automatic"
		? "automatic Pi session-start restoration. Do not ask the user to run /echoes-start."
		: "manual /echoes-start.";
}

function endTriggerText(trigger: PromptTrigger): string {
	return trigger === "automatic"
		? "automatic pre-session-close fallback. If memory was already committed, do nothing further; otherwise call commit_memory_to_echoes_vault exactly once."
		: "manual /echoes-end.";
}

export default function (pi: ExtensionAPI) {
	// A resumed session can retain its original cwd even when Pi was launched elsewhere.
	// Recovery must never cross that launch-directory boundary.
	const launchCwd = cwdKey(process.cwd());

	/**
	 * Runtime-local start dedupe keyed by cwd for this extension instance.
	 * Cleared on each logical session_start (startup/new/resume/fork) so the
	 * same surviving instance still restores context. Persisted startPromptSent
	 * is informational only and must not suppress start after process restart.
	 * Same-session duplicate suppression (auto + manual /echoes-start) still
	 * uses this set until the next logical session_start.
	 */
	const startDeliveredThisRuntime = new Set<string>();

	/**
	 * Runtime-local end request tracking.
	 * - "queued": end prompt delivered as followUp; ignore settlements until our turn starts
	 * - "running": end prompt's agent turn is active; clear flags on settle if still unsaved
	 * Cleared on successful commit. Does not auto-loop prompts.
	 */
	const endPhase = new Map<string, "queued" | "running">();

	async function runEchoesStart(
		ctx: DeliverCtx & { cwd: string },
		trigger: PromptTrigger,
	): Promise<boolean> {
		if (!(await hasExistingVault(ctx.cwd))) {
			if (trigger === "manual") {
				notify(ctx, "No EchoesVault found. Run /echoes-init first.", "warning");
			}
			return false;
		}

		const key = cwdKey(ctx.cwd);
		if (startDeliveredThisRuntime.has(key)) {
			if (trigger === "manual") {
				notify(ctx, "EchoesVault already started for this session", "info");
			}
			return false;
		}

		await startSession(ctx.cwd);

		const paths = resolveVaultPaths(ctx.cwd);
		const index = await readTextOr(paths.index, "EchoesVault/index.md not found");
		const recent = await readRecentDailyLogs(ctx.cwd, 3);
		let prompt = START_PROMPT.replace("{{TRIGGER}}", startTriggerText(trigger))
			.replace("{{INDEX}}", index)
			.replace("{{RECENT_LOGS}}", recent);
		startDeliveredThisRuntime.add(key);
		await markStartPromptSent(ctx.cwd);
		try {
			deliverPrompt(pi, ctx, prompt);
		} catch (err) {
			startDeliveredThisRuntime.delete(key);
			await clearStartPromptSent(ctx.cwd);
			throw err;
		}

		notify(
			ctx,
			trigger === "automatic"
				? "EchoesVault auto-restored session context"
				: "EchoesVault session started",
			"info",
		);
		return true;
	}

	async function runEchoesEnd(
		ctx: DeliverCtx & { cwd: string },
		trigger: PromptTrigger,
	): Promise<{ sent: boolean; inFlight: boolean }> {
		if (!(await hasExistingVault(ctx.cwd))) {
			if (trigger === "manual") {
				notify(ctx, "No EchoesVault found. Run /echoes-init first.", "warning");
			}
			return { sent: false, inFlight: false };
		}

		const key = cwdKey(ctx.cwd);
		const st = await readState(ctx.cwd);
		if (st.session.saved) {
			if (trigger === "manual") {
				notify(ctx, "EchoesVault already saved this session", "info");
			}
			return { sent: false, inFlight: false };
		}
		if (st.session.endPromptSent || endPhase.has(key)) {
			if (trigger === "manual") {
				notify(ctx, "EchoesVault end already requested", "info");
			}
			return { sent: false, inFlight: true };
		}

		await markEndPromptSent(ctx.cwd);
		const phase: "queued" | "running" = ctx.isIdle() ? "running" : "queued";
		endPhase.set(key, phase);
		try {
			deliverPrompt(pi, ctx, END_PROMPT.replace("{{TRIGGER}}", endTriggerText(trigger)));
		} catch (err) {
			endPhase.delete(key);
			await clearEndPromptSent(ctx.cwd);
			throw err;
		}

		notify(
			ctx,
			trigger === "automatic"
				? "EchoesVault is saving this session. Retry the session action after completion."
				: "EchoesVault end: requesting memory commit",
			trigger === "automatic" ? "warning" : "info",
		);
		return { sent: true, inFlight: true };
	}

	async function handlePreClose(ctx: ExtensionContext): Promise<{ cancel: true } | undefined> {
		if (!(await needsAutomaticEnd(ctx.cwd))) return undefined;

		const st = await readState(ctx.cwd);
		const key = cwdKey(ctx.cwd);
		if (!st.session.endPromptSent && !endPhase.has(key)) {
			await runEchoesEnd(ctx, "automatic");
		} else {
			notify(ctx, "EchoesVault save still in progress. Retry after completion.", "warning");
		}
		return { cancel: true };
	}

	async function defensiveCancelOnError(
		ctx: ExtensionContext,
	): Promise<{ cancel: true } | undefined> {
		try {
			if (!(await hasExistingVault(ctx.cwd))) return undefined;
			const needs = await needsAutomaticEnd(ctx.cwd).catch(() => true);
			if (!needs) return undefined;
		} catch {
			return undefined;
		}
		notify(
			ctx,
			"EchoesVault could not prepare save; session transition cancelled",
			"error",
		);
		return { cancel: true };
	}

	pi.registerTool({
		name: "commit_memory_to_echoes_vault",
		label: "Commit Memory",
		description:
			"Save session memory to EchoesVault. Writes a daily summary, creates new knowledge base pages, and updates the Vault index.",
		promptSnippet: "Commit session summary, pages, and index updates to EchoesVault",
		promptGuidelines: [
			"Use commit_memory_to_echoes_vault at session end (e.g. after /echoes-end) to persist outcomes, pages, and index updates.",
		],
		parameters: Type.Object({
			dailySummary: Type.String({
				description:
					"Detailed summary of the current session: accomplishments, bugs, stopping point, remaining work.",
			}),
			newPages: Type.Optional(
				Type.Array(
					Type.Object({
						filename: Type.String({
							description: "Filename without path (e.g. 'architecture-decisions')",
						}),
						content: Type.String({ description: "Full markdown content of the page" }),
					}),
				),
			),
			indexAppends: Type.Optional(
				Type.Array(Type.String({ description: "Line to append to EchoesVault/index.md" })),
			),
			indexUpdates: Type.Optional(
				Type.Array(
					Type.Object({
						oldLine: Type.String({ description: "Exact line to find in the index" }),
						newLine: Type.String({ description: "Replacement line" }),
					}),
				),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await commitMemory(ctx.cwd, params);
			endPhase.delete(cwdKey(ctx.cwd));
			return textResult(result);
		},
	});

	pi.registerTool({
		name: "echoes_append_to_daily_log",
		label: "Append Daily Log",
		description:
			"Append an intermediate technical note or decision to today's daily log without ending the session.",
		promptSnippet: "Append a scratchpad note to today's EchoesVault daily log",
		promptGuidelines: [
			"Use echoes_append_to_daily_log immediately after completing a sub-task, context switch, or architectural agreement.",
		],
		parameters: Type.Object({
			logEntry: Type.String({
				description: "Markdown bullet points to append. Do not include date/time.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await appendDailyLog(ctx.cwd, params.logEntry));
		},
	});

	pi.registerTool({
		name: "echoes_search_vault_pages",
		label: "Search Vault",
		description:
			"Search the EchoesVault pages/ directory for specific concepts, keywords, or implementation details.",
		promptSnippet: "Search EchoesVault/pages for keywords before inventing docs",
		promptGuidelines: [
			"Use echoes_search_vault_pages before modifying documented components or when fulfilling Read-Before-Write.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Specific keyword or short phrase to search for across pages/.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await searchVaultPages(ctx.cwd, params.query));
		},
	});

	pi.registerTool({
		name: "echoes_create_or_update_page",
		label: "Create/Update Page",
		description:
			"Create or update a markdown page in EchoesVault/pages/, updating the index when the file is new.",
		promptSnippet: "Create or update an EchoesVault encyclopedia page and sync index",
		promptGuidelines: [
			"Use echoes_create_or_update_page when a global concept or ADR is finalized mid-session; include indexDescription for new files.",
		],
		parameters: Type.Object({
			filename: Type.String({
				description: "Exact filename without paths (e.g. 'auth-architecture.md').",
			}),
			content: Type.String({
				description: "Full markdown content, starting with YAML frontmatter.",
			}),
			indexDescription: Type.Optional(
				Type.String({
					description:
						"One-sentence index line for new files. Format: '- [[filename]]: description'.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await createOrUpdatePage(ctx.cwd, params));
		},
	});

	pi.registerCommand("echoes-init", {
		description: "Initialize EchoesVault — create directory structure and activate",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await activateVault(ctx.cwd);
			const paths = resolveVaultPaths(ctx.cwd);
			const index = await readTextOr(paths.index, "(index missing)");
			notify(ctx, "EchoesVault initialized", "info");
			deliverPrompt(pi, ctx, INIT_PROMPT.replace("{{INDEX}}", index));
		},
	});

	pi.registerCommand("echoes-start", {
		description: "Start a session — restore context from daily logs and index",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await runEchoesStart(ctx, "manual");
		},
	});

	pi.registerCommand("echoes-end", {
		description: "End the session — ask the agent to commit memory to EchoesVault",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await runEchoesEnd(ctx, "manual");
		},
	});

	pi.registerCommand("echoes-status", {
		description: "Report EchoesVault health and statistics",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!(await hasExistingVault(ctx.cwd))) {
				notify(ctx, "No EchoesVault found. Run /echoes-init first.", "warning");
				return;
			}
			await bootstrapVault(ctx.cwd);
			const state = await refreshStats(ctx.cwd);
			const paths = resolveVaultPaths(ctx.cwd);
			const today = getDateStr();
			const todayPath = path.join(paths.daily, `${today}.md`);
			const todayLog = await readTextOr(todayPath, "No entries yet");
			const todayExists = todayLog !== "No entries yet";
			const stats = formatStatusReport(state, todayExists);
			const index = await readTextOr(paths.index, "EchoesVault/index.md not found");
			notify(
				ctx,
				`EchoesVault: ${state.stats.totalPages} pages, ${state.stats.totalDailyLogs} logs`,
				"info",
			);
			deliverPrompt(
				pi,
				ctx,
				STATUS_PROMPT.replace("{{INDEX}}", index)
					.replace("{{TODAY_LOG}}", todayLog)
					.replace("{{STATS}}", stats),
			);
		},
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		try {
			if (!(await hasExistingVault(ctx.cwd))) return;

			if (event.reason === "reload") {
				await refreshStatsOnReload(ctx.cwd);
				return;
			}

			if (!AUTO_START_REASONS.has(event.reason)) return;

			// Logical new/resume/fork/startup may reuse this extension instance.
			// Reset runtime-local start dedupe so restoration can run again.
			startDeliveredThisRuntime.delete(cwdKey(ctx.cwd));
			if (cwdKey(ctx.cwd) === launchCwd) {
				const recovery = await startBackgroundRecovery(ctx.cwd);
				if (recovery === "started") {
					notify(ctx, "EchoesVault recovery started in an isolated background session", "info");
				}
			}
			await runEchoesStart(ctx, "automatic");
		} catch {
			/* non-fatal */
		}
	});

	pi.on("session_before_switch", async (_event: SessionBeforeSwitchEvent, ctx) => {
		try {
			return await handlePreClose(ctx);
		} catch {
			return await defensiveCancelOnError(ctx);
		}
	});

	pi.on("session_before_fork", async (_event: SessionBeforeForkEvent, ctx) => {
		try {
			return await handlePreClose(ctx);
		} catch {
			return await defensiveCancelOnError(ctx);
		}
	});

	pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx) => {
		try {
			// Never send a model prompt here — teardown aborts any queued turn.
			if (event.reason !== "quit") return;
			await recordEndPendingOnQuit(ctx.cwd, ctx.sessionManager.getSessionFile());
		} catch {
			/* non-fatal */
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		try {
			const key = cwdKey(ctx.cwd);
			if (endPhase.get(key) === "queued") {
				endPhase.set(key, "running");
			}
		} catch {
			/* non-fatal */
		}
	});

	/**
	 * After an end-prompt agent turn settles without a successful commit, clear
	 * endPromptSent so a later transition or manual /echoes-end can retry.
	 * Does not auto-requeue the end prompt. Ignores settlements while the end
	 * prompt is only queued as followUp (still waiting for its own agent_start).
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const key = cwdKey(ctx.cwd);
			if (endPhase.get(key) !== "running") return;
			endPhase.delete(key);

			const st = await readState(ctx.cwd);
			if (st.session.saved) return;
			if (!st.session.endPromptSent) return;

			await clearEndPromptSent(ctx.cwd);
			notify(
				ctx,
				"EchoesVault end did not commit; retry /echoes-end or the session action",
				"warning",
			);
		} catch {
			/* non-fatal */
		}
	});
}
