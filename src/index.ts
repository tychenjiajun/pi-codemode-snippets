// ---------------------------------------------------------------------------
// pi-codemode-snippets
// ---------------------------------------------------------------------------
//
// Pi's `codemode` tool lets the model write throwaway JavaScript. This
// extension lets a user keep the scripts worth keeping: every `*.js` file in a
// snippet directory that starts with a `// @snippet: {…}` pragma becomes an
// ordinary pi tool, named by the snippet name.
//
// Each snippet is registered with an explicit `direct` exposure, so it is
// declared to the model and callable from scripts and `ctx.executeTool` while
// active. Running one delegates to the built-in codemode tool, so the body is
// exactly the codemode script it always was.
//
// Directories, in ascending precedence:
//   ~/.pi/agent/snippets/         (user)
//   <path> entries in the `snippets` setting   (setting)
//   <cwd>/.pi/snippets/           (project, only when the project is trusted)
//
// pi's built-in `/reload` re-runs the factory and `session_start`, so editing,
// adding, or deleting a snippet file is picked up without a restart.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionStartEvent } from "@earendil-works/pi-coding-agent";

import { formatStatusLine, registerSnippetCommands } from "./commands.ts";
import { captureCodemodeExecutor, type CodemodeExecutor } from "./codemode.ts";
import { DEFAULT_MAX_NESTING_DEPTH } from "./execute.ts";
import { loadSnippets, type SnippetFs } from "./snippet.ts";
import { createSnippetTool } from "./tool.ts";
import type { SnippetDir, SnippetIssue, SnippetLoadResult, SnippetStatus } from "./types.ts";

export interface CodemodeSnippetsOptions {
	/** Cap on snippet→snippet nesting. Defaults to {@link DEFAULT_MAX_NESTING_DEPTH}. */
	readonly maxNestingDepth?: number;
	/** Extra directories, scanned before the conventional ones. */
	readonly dirs?: readonly SnippetDir[];
	/** Filesystem seam for tests. */
	readonly fs?: SnippetFs;
}

const EMPTY_RESULT: SnippetLoadResult = { snippets: [], issues: [], shadowed: [] };
const EMPTY_STATUS: SnippetStatus = { ...EMPTY_RESULT, registered: [] };

/**
 * Combine the load result with the registration outcome: which loaded snippets
 * actually got a tool (the `registered` set) and why the others did not (the
 * registration issues). Pure, so `/snippet list`, `/snippet validate`, and the
 * session-start summary all read the same value.
 */
export function toStatus(
	result: SnippetLoadResult,
	registrationIssues: readonly SnippetIssue[],
	registered: ReadonlySet<string>,
): SnippetStatus {
	const names = new Set(result.snippets.map((snippet) => snippet.name));
	return {
		...result,
		issues: [...result.issues, ...registrationIssues],
		registered: [...registered].filter((name) => names.has(name)),
	};
}

/** Build the extension factory. */
export function createCodemodeSnippetsExtension(options: CodemodeSnippetsOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const maxNestingDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
		const registered = new Set<string>();
		let last: SnippetStatus = EMPTY_STATUS;
		let registrationIssues: readonly SnippetIssue[] = [];

		// Capture the built-in codemode executor once. Nothing is registered, so the
		// model still sees exactly one `codemode` tool and scripts cannot nest.
		const executor = captureCodemodeExecutor(pi);

		const resolveDirs = (cwd: string, trusted: boolean): SnippetDir[] => [
			...(options.dirs ?? []),
			{ dir: join(getAgentDir(), "snippets"), scope: "user" },
			...settingDirs(pi, cwd),
			...(trusted ? [{ dir: join(cwd, ".pi", "snippets"), scope: "project" as const }] : []),
		];

		pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			const result = await loadSnippets(resolveDirs(ctx.cwd, ctx.isProjectTrusted()), options.fs);
			registrationIssues = registerSnippetTools(pi, result, registered, maxNestingDepth, executor);
			last = toStatus(result, registrationIssues, registered);
			reportStatus(ctx, last);
		});

		registerSnippetCommands(pi, {
			list: () => last,
			rescan: async (ctx) => {
				const result = await loadSnippets(resolveDirs(ctx.cwd, ctx.isProjectTrusted()), options.fs);
				last = toStatus(result, registrationIssues, registered);
				updateStatusLine(ctx, last);
				return last;
			},
		});
	};
}

/** Register one tool per enabled snippet, never shadowing an existing tool. */
export function registerSnippetTools(
	pi: ExtensionAPI,
	result: SnippetLoadResult,
	registered: Set<string>,
	maxNestingDepth: number,
	executor: CodemodeExecutor | undefined,
): SnippetIssue[] {
	const issues: SnippetIssue[] = [];

	if (!executor) {
		issues.push({
			path: "<codemode>",
			message: "the built-in codemode executor is unavailable; snippets cannot be registered",
		});
		return issues;
	}

	const taken = new Set(pi.getAllTools().map((tool) => tool.name));

	for (const snippet of result.snippets) {
		if (!snippet.enabled) continue;

		if (!registered.has(snippet.name) && taken.has(snippet.name)) {
			issues.push({
				path: snippet.path,
				name: snippet.name,
				message: `tool name "${snippet.name}" is already registered by another tool; snippet skipped`,
			});
			continue;
		}

			try {
			pi.registerTool(createSnippetTool(snippet, { maxNestingDepth, executor }));
			registered.add(snippet.name);
			taken.add(snippet.name);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			issues.push({ path: snippet.path, name: snippet.name, message: `registration failed: ${detail}` });
		}
	}

	return issues;
}

/** The `snippets` setting directories, expanded and resolved against `cwd`. */
function settingDirs(pi: ExtensionAPI, cwd: string): SnippetDir[] {
	const settings = pi.getSettings() as { snippets?: unknown };
	if (!Array.isArray(settings.snippets)) return [];

	const dirs: SnippetDir[] = [];
	for (const entry of settings.snippets) {
		if (typeof entry !== "string" || entry.trim() === "") continue;
		dirs.push({ dir: expandPath(entry.trim(), cwd), scope: "setting" });
	}
	return dirs;
}

/** Expand a leading `~` and resolve a relative path against `cwd`. */
function expandPath(entry: string, cwd: string): string {
	let value = entry;
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Refresh the footer status line after any load or rescan. */
export function updateStatusLine(ctx: ExtensionContext, status: SnippetStatus): void {
	if (ctx.hasUI) ctx.ui.setStatus("snippets", formatStatusLine(status));
}

/**
 * The footer status line plus, at session start, one warning when anything is
 * wrong: the footer keeps the live count visible, the warning carries the first
 * reason and points at `/snippet list`, which has the per-file detail.
 */
export function reportStatus(ctx: ExtensionContext, status: SnippetStatus): void {
	updateStatusLine(ctx, status);

	const count = status.issues.length + status.shadowed.length;
	if (count === 0) return;

	const notRegistered = status.snippets.length - status.registered.length;
	const parts: string[] = [];
	if (notRegistered > 0) parts.push(`${notRegistered} of ${status.snippets.length} snippets not registered`);
	if (status.shadowed.length > 0) {
		const names = [...new Set(status.shadowed.map((conflict) => conflict.name))].join(", ");
		parts.push(`${status.shadowed.length} shadowed (${names})`);
	}
	const first =
		status.issues[0]?.message ??
		(status.shadowed[0] ? `"${status.shadowed[0].name}" is shadowed` : "unknown problem");
	const detail = parts.length > 0 ? `${parts.join("; ")} — first: ${first}` : first;
	const message = `pi-codemode-snippets: ${count} problem${count === 1 ? "" : "s"} (${detail}). Run /snippet list.`;

	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.warn(message);
}

export default createCodemodeSnippetsExtension();
