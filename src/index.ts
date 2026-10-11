// ---------------------------------------------------------------------------
// pi-codemode-snippets
// ---------------------------------------------------------------------------
//
// Pi's `codemode` tool lets the model write throwaway JavaScript. This
// extension lets a user keep the scripts worth keeping: every `*.js` file in a
// snippet directory that starts with a `// @snippet: {…}` pragma becomes an
// ordinary pi tool, named by the snippet name.
//
// Each snippet is registered with the default `direct` exposure, so it is
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

import { registerSnippetCommands } from "./commands.ts";
import { DEFAULT_MAX_NESTING_DEPTH } from "./execute.ts";
import { loadSnippets, type SnippetFs } from "./snippet.ts";
import { createSnippetTool } from "./tool.ts";
import type { SnippetDir, SnippetIssue, SnippetLoadResult } from "./types.ts";

export interface CodemodeSnippetsOptions {
	/** Cap on snippet→snippet nesting. Defaults to {@link DEFAULT_MAX_NESTING_DEPTH}. */
	readonly maxNestingDepth?: number;
	/** Extra directories, scanned before the conventional ones. */
	readonly dirs?: readonly SnippetDir[];
	/** Filesystem seam for tests. */
	readonly fs?: SnippetFs;
}

const EMPTY_RESULT: SnippetLoadResult = { snippets: [], issues: [], shadowed: [] };

/** Build the extension factory. */
export function createCodemodeSnippetsExtension(options: CodemodeSnippetsOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const maxNestingDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
		const registered = new Set<string>();
		let last: SnippetLoadResult = EMPTY_RESULT;

		const resolveDirs = (cwd: string, trusted: boolean): SnippetDir[] => [
			...(options.dirs ?? []),
			{ dir: join(getAgentDir(), "snippets"), scope: "user" },
			...settingDirs(pi, cwd),
			...(trusted ? [{ dir: join(cwd, ".pi", "snippets"), scope: "project" as const }] : []),
		];

		pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			const result = await loadSnippets(resolveDirs(ctx.cwd, ctx.isProjectTrusted()), options.fs);
			const conflicts = registerSnippetTools(pi, result, registered, maxNestingDepth);
			last = { ...result, issues: [...result.issues, ...conflicts] };
			reportProblems(ctx, last);
		});

		registerSnippetCommands(pi, {
			list: () => last,
			rescan: async (ctx) => {
				const result = await loadSnippets(resolveDirs(ctx.cwd, ctx.isProjectTrusted()), options.fs);
				last = result;
				return result;
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
): SnippetIssue[] {
	const issues: SnippetIssue[] = [];
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
			pi.registerTool(createSnippetTool(snippet, { maxNestingDepth }));
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

/** One warning at session start when snippets could not all load. */
function reportProblems(ctx: ExtensionContext, result: SnippetLoadResult): void {
	const count = result.issues.length + result.shadowed.length;
	if (count === 0) return;

	const first =
		result.issues[0]?.message ?? (result.shadowed[0] ? `"${result.shadowed[0].name}" is shadowed` : "unknown problem");
	const message = `pi-codemode-snippets: ${count} problem${count === 1 ? "" : "s"} (${first}). Run /snippet validate.`;

	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.warn(message);
}

export default createCodemodeSnippetsExtension();
