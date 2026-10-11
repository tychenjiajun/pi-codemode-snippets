// ---------------------------------------------------------------------------
// Turning a snippet into a pi tool
// ---------------------------------------------------------------------------
//
// Each enabled snippet becomes one ordinary `pi.registerTool()` tool. The
// default `direct` exposure is exactly what the design wants: the tool is
// declared to the model and callable from scripts (and from `ctx.executeTool`)
// while active.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CodemodeExecutor } from "./codemode.ts";
import { runSnippet } from "./execute.ts";
import type { Snippet } from "./types.ts";

type SnippetToolParameters = ToolDefinition["parameters"];

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
		...(snippet.annotations ? { annotations: { ...snippet.annotations } } : {}),
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
