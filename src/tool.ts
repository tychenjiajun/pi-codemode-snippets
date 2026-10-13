// ---------------------------------------------------------------------------
// Turning a snippet into a pi tool
// ---------------------------------------------------------------------------
//
// Each enabled snippet becomes one ordinary `pi.registerTool()` tool with an
// explicit `exposure: "direct"` (pi 1.2.0's default for extension tools): the
// tool is declared to the model and callable from scripts (and from
// `ctx.executeTool`) while active. It is set rather than relied on so the
// contract survives a change of default.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { buildSnippetCode } from "./codegen.ts";
import type { CodemodeExecutor } from "./codemode.ts";
import { runSnippet } from "./execute.ts";
import type { Snippet } from "./types.ts";

type SnippetToolParameters = ToolDefinition["parameters"];

/**
 * Script globals that list or look up tools, which the script may then call by
 * any name — same rule as the built-in codemode tool's `reachesTools`.
 */
const DISCOVERY_GLOBALS = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;

/**
 * The tools a snippet call may reach (`ToolDefinition.reachesTools`, pi 1.2.0):
 * every tool when the generated script uses a discovery global, else the words
 * of the generated script, so `tools.mcp__docs__search` and
 * `tools["mcp__docs__" + name]` both name the `mcp__docs` namespace. The MCP
 * extension uses it to wait for the servers a call needs before it runs.
 */
export function snippetReach(snippet: Snippet, input: Record<string, unknown>): "all" | readonly string[] {
	const code = buildSnippetCode(snippet, input);
	return DISCOVERY_GLOBALS.test(code) ? "all" : (code.match(/\w+/g) ?? []);
}

export interface CreateSnippetToolOptions {
	/** The captured built-in codemode executor. */
	readonly executor: CodemodeExecutor;
	/** Defaults to `DEFAULT_MAX_NESTING_DEPTH`. */
	readonly maxNestingDepth?: number;
}

/** The one-line prompt snippet derived from a description's first sentence. */
export function promptSnippetFromDescription(description: string): string {
	const firstLine = description.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
	const sentence = /^(.*?[.!?])(?:\s|$)/.exec(firstLine)?.[1];
	const snippet = sentence ?? firstLine;
	return snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet;
}

/** Build the pi tool definition for one snippet. */
export function createSnippetTool(snippet: Snippet, options: CreateSnippetToolOptions): ToolDefinition {
	return {
		name: snippet.name,
		label: snippet.label,
		description: snippet.description,
		promptSnippet: promptSnippetFromDescription(snippet.description),
		...(snippet.promptGuidelines ? { promptGuidelines: [...snippet.promptGuidelines] } : {}),
		parameters: snippet.input as unknown as SnippetToolParameters,
		exposure: "direct",
		...(snippet.annotations ? { annotations: { ...snippet.annotations } } : {}),
		reachesTools: (input) => snippetReach(snippet, input),
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			runSnippet({
				snippet,
				input: params,
				toolCallId,
				signal,
				onUpdate,
				ctx,
				executor: options.executor,
				...(options.maxNestingDepth !== undefined ? { maxNestingDepth: options.maxNestingDepth } : {}),
			}),
	};
}
