/**
 * Subagent / headless session detection.
 *
 * EchoesVault is an interactive-session memory keeper: it injects prompts and
 * hidden context, expecting a human-driven main session. Pi subagents run as
 * separate headless Pi processes (`pi --mode json -p`, `pi --mode rpc`, or
 * children spawned through the parent session's bash tool). Injecting steering
 * messages there breaks subagent loops, so the extension must disable itself
 * completely when it detects such a session.
 *
 * Detection is two-layered:
 * - Load-time ({@link detectSubagentSession}): non-interactive CLI flags in argv.
 *   Session environment variables are deliberately ignored because current Pi
 *   versions also expose them to interactive extension hosts.
 * - Runtime ({@link isNonInteractiveContext}): the bound extension mode, which
 *   also covers SDK embeddings and piped-stdin fallbacks where argv is clean.
 */

/** Why a session was classified as a subagent/headless session. */
export type SubagentSignal =
	/** Non-interactive CLI flags: `--mode text|json|rpc`, `-p`, `--print`. */
	"headless-mode-flag";

export interface SubagentDetection {
	isSubagent: boolean;
	signals: SubagentSignal[];
}

/** `--mode` values that never host an interactive main session. */
const HEADLESS_MODE_VALUES = new Set(["text", "json", "rpc"]);

function hasHeadlessModeFlag(argv: readonly string[]): boolean {
	// Skip the runtime executable and script path entries.
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return false;
		if (arg === "-p" || arg === "--print") return true;
		if (arg === "--mode") {
			const value = args[i + 1];
			if (value !== undefined && HEADLESS_MODE_VALUES.has(value)) return true;
			i++;
			continue;
		}
		if (arg.startsWith("--mode=") && HEADLESS_MODE_VALUES.has(arg.slice("--mode=".length))) {
			return true;
		}
	}
	return false;
}

/** Static, process-level detection. Evaluated once when the extension loads. */
export function detectSubagentSession(
	_env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
): SubagentDetection {
	const signals: SubagentSignal[] = [];
	if (hasHeadlessModeFlag(argv)) signals.push("headless-mode-flag");
	return { isSubagent: signals.length > 0, signals };
}

/**
 * Runtime guard for event/command contexts. Only "tui" mode hosts an
 * interactive main session; "rpc", "json", and "print" are headless. When the
 * mode is unavailable (older hosts), fall back to UI availability.
 */
export function isNonInteractiveContext(ctx: { mode?: string; hasUI?: boolean }): boolean {
	if (typeof ctx.mode === "string") return ctx.mode !== "tui";
	return ctx.hasUI === false;
}
