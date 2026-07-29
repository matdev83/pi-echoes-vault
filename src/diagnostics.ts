// ---------------------------------------------------------------------------
// /echoes-doctor report model and builder.
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readEchoesConfig, resolveEchoesConfig } from "./config.ts";
import { captureGitSnapshot, computeGitDelta } from "./git-context.ts";
import { readRecoveryLock, RECOVERY_LOCK_LEASE_MS } from "./recovery-lock.ts";
import { hasExistingVault, pathExists, readState, resolveVaultPaths } from "./vault.ts";

/** Hard output bound so a doctor report can never flood the context. */
const MAX_REPORT_CHARS = 7900;

/** One labeled block of the doctor report. */
export type DoctorSection = {
	title: string;
	lines: string[];
	/** Non-fatal problems discovered in this section. */
	warnings?: string[];
};

/** Full diagnostic snapshot for a project cwd. */
export type DoctorReport = {
	cwd: string;
	generatedAt: string;
	sections: DoctorSection[];
	/** False when any section reports a blocking problem. */
	healthy: boolean;
};

async function countMarkdown(dir: string): Promise<number> {
	try {
		return (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).length;
	} catch {
		return 0;
	}
}

/**
 * Build a bounded, redacted diagnostic report covering vault presence, config,
 * lifecycle state, recovery lock/transcript, and Git status vs saved baseline.
 */
export async function buildDoctorReport(cwd: string): Promise<DoctorReport> {
	const resolved = path.resolve(cwd);
	const sections: DoctorSection[] = [];
	let healthy = true;

	// Vault
	const paths = resolveVaultPaths(resolved);
	const vaultPresent = await hasExistingVault(resolved);
	const indexExists = await pathExists(paths.index);
	sections.push({
		title: "Vault",
		lines: [
			`Present: ${vaultPresent}`,
			`Path: ${paths.vault}`,
			`Index: ${indexExists ? "found" : "missing"}`,
			`Pages: ${await countMarkdown(paths.pages)}; daily logs: ${await countMarkdown(paths.daily)}`,
		],
		warnings: vaultPresent ? undefined : ["EchoesVault directory not found; extension is inactive here."],
	});
	if (!vaultPresent) healthy = false;

	// Config — report the same resolved flags the extension acts on.
	const cfg = await readEchoesConfig(resolved);
	const flags = resolveEchoesConfig(cfg.parsed);
	const configWarnings: string[] = [];
	if (cfg.error) {
		configWarnings.push(`Config JSON invalid: ${cfg.error}`);
		healthy = false;
	}
	sections.push({
		title: "Config",
		lines: [
			`File: ${cfg.present ? ".pi/echoes-config.json" : "absent (defaults)"}`,
			`automaticActions: ${flags.automaticActions}`,
			`gitContext: ${flags.gitContext}`,
			`prContext: ${flags.prContext}`,
		],
		warnings: configWarnings.length ? configWarnings : undefined,
	});

	// Lifecycle
	const state = await readState(resolved);
	sections.push({
		title: "Lifecycle",
		lines: [
			`State version: ${state.version}; plugin: ${state.pluginVersion}`,
			`Initialized: ${state.initialized}`,
			`Session started: ${state.session.started}; saved: ${state.session.saved}`,
			`startPromptSent: ${state.session.startPromptSent}; endPromptSent: ${state.session.endPromptSent}`,
			`Last start: ${state.session.lastStart ?? "never"}; last save: ${state.session.lastSave ?? "never"}`,
		],
	});

	// Recovery
	const lock = await readRecoveryLock(resolved);
	let lockLine = "Lock: none";
	if (lock) {
		const ageMs = Date.now() - Date.parse(lock.at);
		const stale = Number.isFinite(ageMs) && ageMs > RECOVERY_LOCK_LEASE_MS;
		lockLine = `Lock: held by pid ${lock.pid} (${lock.hostname}) since ${lock.at}; ${stale ? "STALE" : "active"}`;
	}
	const transcript = state.session.pendingSessionFile;
	const transcriptLine = transcript
		? `Interrupted transcript: ${transcript} (${(await pathExists(transcript)) ? "available" : "missing"})`
		: "Interrupted transcript: none";
	sections.push({
		title: "Recovery",
		lines: [
			`endPending: ${state.session.endPending}`,
			`recoveryClaimedAt: ${state.session.recoveryClaimedAt ?? "none"}`,
			transcriptLine,
			lockLine,
		],
	});

	// Git
	const snapshot = await captureGitSnapshot(resolved);
	const gitLines: string[] = [];
	if (!snapshot) {
		gitLines.push("Repository: not a Git repository (or git unavailable)");
	} else {
		gitLines.push(`Repository: ${snapshot.repoRoot}`);
		gitLines.push(`Branch: ${snapshot.branch}; HEAD: ${snapshot.head.slice(0, 8)}`);
		gitLines.push(
			`Worktree: ${snapshot.staged} staged, ${snapshot.unstaged} unstaged, ${snapshot.untracked} untracked, ${snapshot.conflicted} conflicted`,
		);
		const saved = state.gitSnapshot;
		if (saved) {
			const delta = await computeGitDelta(resolved, snapshot, saved).catch(() => null);
			gitLines.push(
				`Baseline: ${saved.head.slice(0, 8)}${delta ? `; ${delta.commitCount} commit(s) since; projectDirty=${delta.projectDirty}; vaultDirty=${delta.vaultDirty}` : ""}`,
			);
		} else {
			gitLines.push("Baseline: none saved");
		}
	}
	sections.push({ title: "Git", lines: gitLines });

	return { cwd: resolved, generatedAt: new Date().toISOString(), sections, healthy };
}

/** Render a doctor report as concise, user-facing text. */
export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [
		`EchoesVault doctor - ${report.cwd}`,
		`Generated: ${report.generatedAt}`,
		`Healthy: ${report.healthy}`,
		"",
	];
	for (const section of report.sections) {
		lines.push(`## ${section.title}`);
		for (const line of section.lines) lines.push(`- ${line}`);
		for (const warning of section.warnings ?? []) lines.push(`- WARNING: ${warning}`);
		lines.push("");
	}
	let text = lines.join("\n");
	if (text.length > MAX_REPORT_CHARS) text = `${text.slice(0, MAX_REPORT_CHARS)}\n…(truncated)`;
	return text;
}
