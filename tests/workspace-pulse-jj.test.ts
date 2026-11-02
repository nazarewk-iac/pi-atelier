import { describe, expect, it, vi } from "vitest";
import { inspectJjWorkspacePulse, parseDiffStat } from "../src/workspace-pulse.jj.js";
import { execResult as result } from "./helpers/extension.js";

describe("parseDiffStat", () => {
	it("reads the file, insertion and deletion counts", () => {
		expect(parseDiffStat("3 files changed, 12 insertions(+), 4 deletions(-)\n")).toEqual({
			files: 3,
			linesAdded: 12,
			linesRemoved: 4,
		});
	});

	it("handles an empty diff and singular wording", () => {
		expect(parseDiffStat("")).toEqual({ files: 0, linesAdded: 0, linesRemoved: 0 });
		expect(parseDiffStat("1 file changed, 1 insertion(+), 1 deletion(-)\n")).toEqual({
			files: 1,
			linesAdded: 1,
			linesRemoved: 1,
		});
	});
});

describe("inspectJjWorkspacePulse", () => {
	it("reports not-repo when there is no jj repo", async () => {
		const exec = vi.fn().mockResolvedValue(result("", 1, "Error: There is no jj repo in /tmp"));
		await expect(inspectJjWorkspacePulse({ exec, cwd: "/tmp" })).resolves.toEqual({ kind: "not-repo" });
	});

	it("returns the same snapshot shape as the git inspector, plus jj extras", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("/repo\n")) // jj root
			.mockResolvedValueOnce(result("kpzuvvnm\nmain feat\nfalse\n")) // log -r @ template
			.mockResolvedValueOnce(result("2 files changed, 9 insertions(+), 3 deletions(-)\n")) // diff --stat
			.mockResolvedValueOnce(result("M src/a.ts\nA src/b.ts\n")); // diff --summary
		await expect(inspectJjWorkspacePulse({ exec, cwd: "/repo/pkg" })).resolves.toMatchObject({
			kind: "available",
			root: "/repo",
			relativeCwd: "pkg",
			vcs: "jj",
			jjChangeId: "kpzuvvnm",
			jjBookmarks: ["main", "feat"],
			snapshot: {
				trackedFiles: 2,
				untrackedFiles: 0,
				linesAdded: 9,
				linesRemoved: 3,
				conflicts: 0,
			},
		});
	});

	it("flags a conflict from the log template", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("/repo\n"))
			.mockResolvedValueOnce(result("abc\n\ntrue\n"))
			.mockResolvedValueOnce(result(""))
			.mockResolvedValueOnce(result(""));
		await expect(inspectJjWorkspacePulse({ exec, cwd: "/repo" })).resolves.toMatchObject({
			kind: "available",
			snapshot: { conflicts: 1 },
		});
	});

	it("uses --ignore-working-copy so a poll never snapshots the working copy", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("/repo\n"))
			.mockResolvedValueOnce(result("abc\n\nfalse\n"))
			.mockResolvedValueOnce(result(""))
			.mockResolvedValueOnce(result(""));
		await inspectJjWorkspacePulse({ exec, cwd: "/repo" });
		const everyJjCallIgnores = exec.mock.calls
			.filter((call) => call[0] === "jj")
			.every((call) => (call[1] as string[])[0] === "--ignore-working-copy");
		expect(everyJjCallIgnores).toBe(true);
	});
});
