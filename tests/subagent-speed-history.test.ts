import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentCostSource } from "../src/subagent-cost-history.js";
import {
	readSubagentSpeedHistory,
	replyTokensPerSecond,
	seriesAverage,
} from "../src/subagent-speed-history.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSource(lines: unknown[]): SubagentCostSource {
	const directory = mkdtempSync(join(tmpdir(), "atelier-speed-"));
	dirs.push(directory);
	writeFileSync(
		join(directory, "events.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		"utf8",
	);
	return { runId: "run1", directory, startedAt: 1_000, steps: [{ agent: "scout", startedAt: 1_000 }] };
}

const replyEnd = (observedAt: number, output: number, durationMs: number) => ({
	type: "message_end",
	subagentSource: "child",
	subagentRunId: "run1",
	subagentStepIndex: 0,
	subagentAgent: "scout",
	observedAt,
	message: { role: "assistant", durationMs, usage: { output } },
});

describe("replyTokensPerSecond", () => {
	it("is output over duration in seconds", () => {
		expect(replyTokensPerSecond({ output: 50 }, 2000)).toBeCloseTo(25, 5);
	});
	it("is undefined without tokens or timing", () => {
		expect(replyTokensPerSecond({ output: 0 }, 2000)).toBeUndefined();
		expect(replyTokensPerSecond({ output: 5 }, 0)).toBeUndefined();
		expect(replyTokensPerSecond(undefined, 1000)).toBeUndefined();
	});
});

describe("readSubagentSpeedHistory", () => {
	it("projects one point per reply with its average tok/s", async () => {
		const source = makeSource([replyEnd(2_000, 40, 2_000), replyEnd(5_000, 30, 1_500)]);
		const { series } = await readSubagentSpeedHistory([source]);
		expect(series).toHaveLength(1);
		const run = series[0]!;
		expect(run.agent).toBe("scout");
		expect(run.points.map((p) => Number(p.tokensPerSecond.toFixed(1)))).toEqual([20, 20]);
		expect(seriesAverage(run).replies).toBe(2);
		expect(seriesAverage(run).avgTokensPerSecond).toBeCloseTo(20, 5);
	});

	it("ignores events that are not a child assistant reply", async () => {
		const source = makeSource([
			{ type: "message_end", subagentSource: "parent", subagentRunId: "run1", subagentStepIndex: 0 },
			replyEnd(2_000, 10, 1_000),
		]);
		const { series } = await readSubagentSpeedHistory([source]);
		expect(series[0]?.points).toHaveLength(1);
	});

	it("keeps the series partial when a reply has no timing", async () => {
		const source = makeSource([replyEnd(2_000, 10, 0), replyEnd(4_000, 10, 1_000)]);
		const { series } = await readSubagentSpeedHistory([source]);
		expect(series[0]?.partial).toBe(true);
		expect(series[0]?.points).toHaveLength(1);
	});
});
