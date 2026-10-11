// ---------------------------------------------------------------------------
// Running a snippet
// ---------------------------------------------------------------------------
//
// Execution is delegation. The snippet is turned back into a codemode script
// and handed to pi's own `codemode` tool through `ctx.executeTool`, so every
// aspect of a normal script applies: the QuickJS sandbox, `tools.*` (including
// other snippets), `store`/`load`, `models`, nested-call permissions, usage
// accounting, and any installed codemode compiler.

import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { buildSnippetCode } from "./codegen.ts";
import type { Snippet } from "./types.ts";

/** Default cap on snippet→snippet recursion. */
export const DEFAULT_MAX_NESTING_DEPTH = 10;

/** Structured details attached to a snippet tool result. */
export interface SnippetToolDetails {
	/** Snippet name. */
	readonly snippet: string;
	/** Source file path. */
	readonly path: string;
	/** Codemode's nested-call record, forwarded for renderers and audits. */
	readonly calls?: unknown;
	/** Temp file with the full output, when codemode truncated it. */
	readonly fullOutputPath?: string;
}

export interface RunSnippetOptions {
	readonly snippet: Snippet;
	readonly input: unknown;
	/** Tool call id, used to derive nesting depth. */
	readonly toolCallId: string;
	readonly signal: AbortSignal | undefined;
	readonly ctx: ExtensionToolContext;
	readonly maxNestingDepth?: number;
}

/**
 * Nesting depth of a tool call. Nested calls get ids of the form
 * `<calling id>/<n>`, so a top-level call has depth 1 and each snippet layer
 * adds one segment.
 */
export function snippetDepth(toolCallId: string): number {
	return toolCallId.split("/").length;
}

/** Concatenate the text blocks of a tool result. */
export function contentText(content: readonly { type?: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/**
 * Run one snippet and map the codemode outcome onto a tool result. A failed
 * script throws, carrying codemode's error text (which includes partial output)
 * so pi records a failed tool result.
 */
export async function runSnippet(options: RunSnippetOptions): Promise<AgentToolResult<SnippetToolDetails>> {
	const { snippet, ctx } = options;
	const maxDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;

	if (!ctx.tools.some((tool) => tool.name === "codemode")) {
		throw new Error(
			`Snippet "${snippet.name}" cannot run: the codemode tool is not available. Enable the built-in codemode extension.`,
		);
	}

	const depth = snippetDepth(options.toolCallId);
	if (depth > maxDepth) {
		throw new Error(
			`Snippet "${snippet.name}" exceeded the maximum snippet nesting depth of ${maxDepth}. ` +
				`A snippet probably calls itself, directly or through another snippet.`,
		);
	}

	const code = buildSnippetCode(snippet, options.input);
	const outcome = await ctx.executeTool("codemode", { code }, { signal: options.signal });

	if (outcome.isError) {
		const text = contentText(outcome.result.content);
		throw new Error(text === "" ? `Snippet "${snippet.name}" failed.` : text);
	}

	const details = outcome.result.details as { calls?: unknown; fullOutputPath?: string } | undefined;
	return {
		content: outcome.result.content,
		details: {
			snippet: snippet.name,
			path: snippet.path,
			...(details?.calls !== undefined ? { calls: details.calls } : {}),
			...(details?.fullOutputPath !== undefined ? { fullOutputPath: details.fullOutputPath } : {}),
		},
	};
}
