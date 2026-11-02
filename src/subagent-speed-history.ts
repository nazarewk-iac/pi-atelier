// Sub-agent PERFORMANCE history: per-reply output speed (tok/s) and, where the stream records it,
// time to first token (TTFT).
//
// The accounting reader (`subagent-cost-history.ts`) already walks each child run's
// `events.jsonl` and projects cost. This reader reuses the same source and the same
// "project numbers only" rule, but keeps the per-reply timing:
//
//   * tokensPerSecond = usage.output / (durationMs / 1000) — a WHOLE-REPLY average that includes
//     prefill and queue time. On a loaded CPU model it under-reports decode speed, so the panel
//     labels it "avg tok/s".
//   * TTFT is not recorded per reply by the child stream today (no request-sent marker), so it is
//     only available LIVE for the parent (run-activity.ts). This module therefore produces tok/s
//     history and leaves TTFT to the live tracker; if a future Pi build adds a start marker, the
//     `at`/`startedAt` fields here are enough to compute it.
//
// As with cost, no prompt, output, or tool argument leaves this reader.
import { join } from "node:path";
import { readBoundedFile } from "./bounded-file.js";
import type { SubagentCostSource } from "./subagent-cost-history.js";
import { isRecord } from "./text.js";

const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_POINTS = 2048;

export interface SubagentSpeedPoint {
	at: number;
	/** Average output tokens per second over the reply that ended at `at`. */
	tokensPerSecond: number;
	/** Output tokens in that reply (for weighting / a sparkline height). */
	tokens: number;
	durationMs: number;
}

export interface SubagentSpeedSeries {
	id: string;
	runId: string;
	stepIndex: number;
	agent: string;
	startedAt: number;
	points: SubagentSpeedPoint[];
	partial: boolean;
}

const object = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const numeric = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Average output tok/s for one reply, or undefined if the reply had no timing or no tokens. */
export function replyTokensPerSecond(
	usage: Record<string, unknown> | undefined,
	durationMs: unknown,
): number | undefined {
	const output = numeric(usage?.output) ? (usage?.output as number) : undefined;
	if (!output || output <= 0) return undefined;
	if (!numeric(durationMs) || durationMs <= 0) return undefined;
	const tps = output / (durationMs / 1000);
	return Number.isFinite(tps) && tps > 0 ? tps : undefined;
}

/** Read per-reply output-speed history from the same sources the cost reader uses. */
export async function readSubagentSpeedHistory(
	sources: readonly SubagentCostSource[],
	signal?: AbortSignal,
): Promise<{ series: SubagentSpeedSeries[]; unavailable: number }> {
	const series: SubagentSpeedSeries[] = [];
	let unavailable = 0;
	let remainingBytes = MAX_TOTAL_BYTES;

	for (const source of sources) {
		if (signal?.aborted) break;
		const runs = new Map<number, SubagentSpeedSeries>();
		try {
			const buffer = await readBoundedFile(
				join(source.directory, "events.jsonl"),
				Math.min(MAX_EVENTS_BYTES, remainingBytes),
				signal,
			);
			remainingBytes -= buffer.length;
			if (signal?.aborted) break;
			const text = buffer.toString("utf8");
			// Ignore a trailing partial line: it is an append in progress.
			const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");

			for (const [index, step] of source.steps.entries()) {
				const startedAt = step.startedAt ?? source.startedAt;
				if (numeric(startedAt)) {
					runs.set(index, {
						id: `${source.runId}:${index}`,
						runId: source.runId,
						stepIndex: index,
						agent: step.agent,
						startedAt,
						points: [],
						partial: false,
					});
				}
			}

			for (const line of lines) {
				if (!line) continue;
				let event: Record<string, unknown> | undefined;
				try {
					event = object(JSON.parse(line));
				} catch {
					for (const run of runs.values()) run.partial = true;
					continue;
				}
				const index = event?.subagentStepIndex;
				if (
					event?.type !== "message_end" ||
					event.subagentSource !== "child" ||
					event.subagentRunId !== source.runId ||
					typeof index !== "number"
				)
					continue;
				const run = runs.get(index);
				const step = source.steps[index];
				const message = object(event.message);
				if (!run || !step || event.subagentAgent !== step.agent || message?.role !== "assistant") continue;

				const at = numeric(event.observedAt) ? (event.observedAt as number) : undefined;
				const durationMs = message.durationMs;
				const tps = replyTokensPerSecond(object(message.usage), durationMs);
				if (at === undefined || tps === undefined) {
					run.partial = true;
					continue;
				}
				if (at < run.startedAt || run.points.length >= MAX_POINTS) {
					run.partial = true;
					continue;
				}
				run.points.push({
					at,
					tokensPerSecond: tps,
					tokens: numeric(object(message.usage)?.output) ? (object(message.usage)?.output as number) : 0,
					durationMs: numeric(durationMs) ? (durationMs as number) : 0,
				});
			}

			for (const run of runs.values()) if (run.points.length > 0) series.push(run);
		} catch {
			unavailable++;
		}
	}

	const unique = new Map<string, SubagentSpeedSeries>();
	for (const run of series) {
		const previous = unique.get(run.id);
		if (!previous || (run.points.at(-1)?.at ?? 0) > (previous.points.at(-1)?.at ?? 0))
			unique.set(run.id, run);
	}
	return {
		series: [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
		unavailable,
	};
}

/** Aggregate per series: count of replies and their mean tok/s (the "closed" per-agent average). */
export function seriesAverage(series: SubagentSpeedSeries): { replies: number; avgTokensPerSecond: number } {
	const speeds = series.points
		.map((point) => point.tokensPerSecond)
		.filter((v) => Number.isFinite(v) && v > 0);
	if (speeds.length === 0) return { replies: 0, avgTokensPerSecond: 0 };
	const sum = speeds.reduce((acc, v) => acc + v, 0);
	return { replies: speeds.length, avgTokensPerSecond: sum / speeds.length };
}
