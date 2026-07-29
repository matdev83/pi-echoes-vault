import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { activateVault } from "../src/vault.ts";
import { buildDoctorReport, formatDoctorReport } from "../src/diagnostics.ts";

const cleanup: string[] = [];
after(async () =>
	Promise.all(cleanup.map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))),
);

describe("Doctor report", () => {
	it("builds a bounded report covering vault, config, state, lock, and git", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "echoes-doctor-"));
		cleanup.push(cwd);
		await activateVault(cwd);

		const report = await buildDoctorReport(cwd);
		assert.equal(report.cwd, path.resolve(cwd));
		const titles = report.sections.map((s) => s.title);
		for (const required of ["Vault", "Config", "Lifecycle", "Recovery", "Git"]) {
			assert.ok(titles.includes(required), `missing section: ${required}`);
		}
		const text = formatDoctorReport(report);
		assert.match(text, /Vault/);
		assert.ok(text.length < 8000, "report must stay bounded");
	});
});
