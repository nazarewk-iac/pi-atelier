// Jujutsu (jj) backing for the Workspace Pulse.
//
// This is the jj counterpart of `workspace-pulse.ts`: it produces the SAME
// `WorkspacePulseInspection` shape, so the sidebar, footer, and refresh machinery are shared
// unchanged. Differences are called out where they matter:
//
//   * jj has no "untracked" state — a new file is auto-tracked into the working-copy commit `@`.
//     A new file therefore shows up in `jj diff -r @` and counts as changed, not untracked.
//   * `jj diff -r @` is the working-copy commit vs its parent `@-`, i.e. exactly "the edits you
//     have not committed with `jj new` yet". That is the useful number for a status rail; it is
//     NOT "uncommitted changes vs HEAD", which Git means by the same words.
//   * The current change id (`change_id.short()`) has no Git analogue and is the headline jj
//     stat; it is carried in `jjChangeId` and rendered by the workspace panel.
//
// Every read uses `--ignore-working-copy` so a status poll never snapshots the working copy (a
// write operation in jj). Without it a 2 s poll would trigger a `jj st` write on every tick.
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { toDisplayPath } from "./display-path.js";
import type {
	WorkspacePulseData,
	WorkspacePulseInspection,
	WorkspacePulseSnapshot,
} from "./workspace-pulse.js";

const JJ_TIMEOUT_MS = 2_000;

type WorkspacePulseExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

interface InspectJjWorkspacePulseOptions {
	exec: WorkspacePulseExec;
	cwd: string;
	signal?: AbortSignal;
}

const jj = (...args: string[]): string[] => ["--ignore-working-copy", ...args];

function hasPathPrefix(file: string, prefix: string): boolean {
	return file === prefix || file.startsWith(`${prefix}/`);
}

/** Parse `jj diff --stat -r @` for the "N file(s) changed, A insertions(+), D deletions(-)" line. */
export function parseDiffStat(output: string): {
	files: number;
	linesAdded: number;
	linesRemoved: number;
} {
	let files = 0;
	let linesAdded = 0;
	let linesRemoved = 0;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const filesMatch = /(\d+)\s+files?\s+changed/.exec(line);
		if (filesMatch) files = Number.parseInt(filesMatch[1] ?? "0", 10) || 0;
		const addMatch = /(\d+)\s+insertions?\(\+\)/.exec(line);
		if (addMatch) linesAdded = Number.parseInt(addMatch[1] ?? "0", 10) || 0;
		const delMatch = /(\d+)\s+deletions?\(-\)/.exec(line);
		if (delMatch) linesRemoved = Number.parseInt(delMatch[1] ?? "0", 10) || 0;
	}
	return { files, linesAdded, linesRemoved };
}

/**
 * Inspect a jj workspace. Returns the same union as the Git inspector, so callers do not branch
 * on the VCS. An empty `jj diff -r @` with no conflicts is a clean tree.
 */
export async function inspectJjWorkspacePulse(
	options: InspectJjWorkspacePulseOptions,
): Promise<WorkspacePulseInspection> {
	const exec: WorkspacePulseExec = (command, args, opts) =>
		options.signal?.aborted
			? Promise.resolve({ stdout: "", stderr: "", code: 1, killed: true })
			: options.exec(command, args, { ...opts, ...(options.signal ? { signal: options.signal } : {}) });

	const root = await exec("jj", jj("root"), { cwd: options.cwd, timeout: JJ_TIMEOUT_MS });
	if (root.code !== 0 || root.killed) {
		const text = `${root.stderr}\n${root.stdout}`;
		// "There is no jj repo in ..." from jj, or jj not installed at all.
		if (/no jj repo|not a jj repo|There is no jj repo/i.test(text)) return { kind: "not-repo" };
		return { kind: "not-repo" };
	}
	const repoRoot = root.stdout.trim();
	if (!repoRoot) return { kind: "not-repo" };

	// One template call for the identity of @ and its bookmarks. `change_id.short()` is stable and
	// readable; `bookmarks` is space-separated (empty when none).
	const log = await exec(
		"jj",
		jj(
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id.short() ++ "\\n" ++ bookmarks ++ "\\n" ++ conflict ++ "\\n"',
		),
		{ cwd: repoRoot, timeout: JJ_TIMEOUT_MS },
	);
	if (log.code !== 0 || log.killed) return { kind: "unavailable" };
	const [rawChangeId = "", rawBookmarks = "", rawConflict = ""] = log.stdout.split("\n");
	const changeId = rawChangeId.trim() || undefined;
	const bookmarks = rawBookmarks
		.trim()
		.split(/\s+/)
		.filter((b) => b.length > 0);
	const conflict = rawConflict.trim() === "true";

	const stat = await exec("jj", jj("diff", "--stat", "-r", "@"), { cwd: repoRoot, timeout: JJ_TIMEOUT_MS });
	if (stat.code !== 0 || stat.killed) return { kind: "unavailable" };
	const { files, linesAdded, linesRemoved } = parseDiffStat(stat.stdout);

	// A changed path in @ shows in `--summary`; count it for the "modified files" row too, in case a
	// rename or binary change is not represented in the --stat total.
	const summary = await exec("jj", jj("diff", "--summary", "-r", "@"), {
		cwd: repoRoot,
		timeout: JJ_TIMEOUT_MS,
	});
	let changedPaths = 0;
	if (summary.code === 0 && !summary.killed) {
		changedPaths = summary.stdout
			.split("\n")
			.filter((l) => /^[AMDCR]\s/.test(l) || /^\S/.test(l.trim())).length;
	}

	const snapshot: WorkspacePulseSnapshot = {
		trackedFiles: files || changedPaths,
		// jj tracks everything; there is no untracked bucket. New files count in tracked/added.
		untrackedFiles: 0,
		linesAdded,
		linesRemoved,
		binaryFiles: 0,
		submodules: 0,
		conflicts: conflict ? 1 : 0,
	};

	const data: WorkspacePulseData = {
		root: repoRoot,
		relativeCwd: toDisplayPath(relativeRepoPath(repoRoot, options.cwd)),
		vcs: "jj",
		// No "branch": a jj working copy is a change. The bookmarks and change id are jj extras.
		snapshot,
		...(changeId ? { jjChangeId: changeId } : {}),
		jjBookmarks: bookmarks,
	};
	return { kind: "available", ...data };
}

function relativeRepoPath(root: string, cwd: string): string {
	if (hasPathPrefix(cwd, root)) return cwd.slice(root.length).replace(/^\//, "");
	return cwd;
}
