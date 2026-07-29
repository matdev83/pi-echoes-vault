// ---------------------------------------------------------------------------
// Canonical reader for `.pi/echoes-config.json` and its precedence rules.
// Every consumer (extension, PR context, doctor) must go through here so the
// documented precedence can never drift between code paths.
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Project-local extension config file, relative to the project cwd. */
export const CONFIG_RELATIVE = path.join(".pi", "echoes-config.json");

/** Raw config file shape; every key is optional. */
export type EchoesConfig = {
	automaticActions?: boolean;
	gitContext?: boolean;
	prContext?: boolean;
};

/** Result of reading the config file from disk. */
export type EchoesConfigFile = {
	/** False when the file does not exist. */
	present: boolean;
	/** Parsed object; empty when absent or unreadable. */
	parsed: EchoesConfig;
	/** JSON parse error text when the file exists but is malformed. */
	error: string | null;
};

/** Effective behavior flags after applying documented precedence. */
export type ResolvedEchoesConfig = {
	automaticActions: boolean;
	gitContext: boolean;
	prContext: boolean;
};

/** Resolve raw config keys into effective flags. `automaticActions: false` overrides all. */
export function resolveEchoesConfig(parsed: EchoesConfig): ResolvedEchoesConfig {
	const automaticActions = parsed.automaticActions !== false;
	return {
		automaticActions,
		gitContext: automaticActions && parsed.gitContext !== false,
		prContext: automaticActions && parsed.prContext === true,
	};
}

/** Read the project config; malformed JSON is reported, never thrown. */
export async function readEchoesConfig(cwd: string): Promise<EchoesConfigFile> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(cwd, CONFIG_RELATIVE), "utf-8");
	} catch {
		return { present: false, parsed: {}, error: null };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return {
			present: true,
			parsed: parsed && typeof parsed === "object" ? (parsed as EchoesConfig) : {},
			error: null,
		};
	} catch (err) {
		return { present: true, parsed: {}, error: String(err) };
	}
}

/** Read and resolve the effective flags in one call. */
export async function readResolvedEchoesConfig(cwd: string): Promise<ResolvedEchoesConfig> {
	return resolveEchoesConfig((await readEchoesConfig(cwd)).parsed);
}
