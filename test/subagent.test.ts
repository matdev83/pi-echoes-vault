import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectSubagentSession, isNonInteractiveContext } from "../src/subagent.ts";

const CLEAN_ENV: NodeJS.ProcessEnv = {};
const MAIN_ARGV = ["node", "pi"];

describe("detectSubagentSession", () => {
	it("treats a plain interactive launch as a main session", () => {
		const detection = detectSubagentSession(CLEAN_ENV, MAIN_ARGV);
		assert.equal(detection.isSubagent, false);
		assert.deepEqual(detection.signals, []);
	});

	it("detects nested-session env markers inherited from a parent Pi bash tool", () => {
		for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE"] as const) {
			const detection = detectSubagentSession({ [name]: "x" }, MAIN_ARGV);
			assert.equal(detection.isSubagent, true, `${name} must mark a subagent session`);
			assert.deepEqual(detection.signals, ["nested-session-env"]);
		}
	});

	it("detects headless --mode values used by subagent orchestrators", () => {
		for (const mode of ["json", "rpc", "text"]) {
			const detection = detectSubagentSession(CLEAN_ENV, ["node", "pi", "--mode", mode, "task"]);
			assert.equal(detection.isSubagent, true, `--mode ${mode} must mark a subagent session`);
			assert.deepEqual(detection.signals, ["headless-mode-flag"]);
		}
	});

	it("detects print-mode flags", () => {
		for (const argv of [
			["node", "pi", "-p", "task"],
			["node", "pi", "--print", "task"],
			["node", "pi", "--mode=json", "-p", "task"],
		]) {
			const detection = detectSubagentSession(CLEAN_ENV, argv);
			assert.equal(detection.isSubagent, true, `${argv.slice(2).join(" ")} must mark a subagent session`);
		}
	});

	it("ignores missing/invalid --mode values and flags after --", () => {
		for (const argv of [
			["node", "pi", "--mode"],
			["node", "pi", "--mode", "--verbose"],
			["node", "pi", "--", "--mode", "json"],
			["node", "pi", "--continue"],
			["node", "pi", "--no-session"],
		]) {
			const detection = detectSubagentSession(CLEAN_ENV, argv);
			assert.equal(detection.isSubagent, false, `${argv.slice(2).join(" ")} must stay a main session`);
		}
	});

	it("reports both signals when env and argv both indicate a subagent", () => {
		const detection = detectSubagentSession(
			{ PI_SESSION_ID: "x" },
			["node", "pi", "--mode", "json", "-p", "task"],
		);
		assert.equal(detection.isSubagent, true);
		assert.deepEqual(detection.signals, ["nested-session-env", "headless-mode-flag"]);
	});
});

describe("isNonInteractiveContext", () => {
	it("keeps interactive TUI sessions enabled", () => {
		assert.equal(isNonInteractiveContext({ mode: "tui", hasUI: true }), false);
	});

	it("disables all headless run modes", () => {
		for (const mode of ["json", "rpc", "print"]) {
			assert.equal(isNonInteractiveContext({ mode }), true, `mode ${mode} must be non-interactive`);
		}
	});

	it("falls back to UI availability when the host does not expose a mode", () => {
		assert.equal(isNonInteractiveContext({ hasUI: true }), false);
		assert.equal(isNonInteractiveContext({ hasUI: false }), true);
		assert.equal(isNonInteractiveContext({}), false, "unknown hosts stay enabled");
	});
});
