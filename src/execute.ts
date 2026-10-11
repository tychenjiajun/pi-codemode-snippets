// ---------------------------------------------------------------------------
// Running a snippet
// ---------------------------------------------------------------------------
//
// Execution is delegation to the captured built-in codemode executor. The
// snippet is turned back into a codemode script and run through the identical
// sandbox a model-written script uses: QuickJS, `tools.*` (including other
// snippets), `store`/`load`, `models`, nested-call permissions, and usage
// accounting.

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { buildSnippetCode } from "./codegen.ts";
import type { CodemodeExecutor } from "./codemode.ts";
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
	/** Streaming callback, forwarded to the codemode executor. */
	readonly onUpdate?: AgentToolUpdateCallback<unknown>;
	readonly ctx: ExtensionToolContext;
	readonly executor: CodemodeExecutor;
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
 * Run one snippet and map the codemode result onto a tool result. A failed
 * script throws, carrying codemode's error text (which includes partial output)
 * so pi records a failed tool result.
 */
export async function runSnippet(options: RunSnippetOptions): Promise<AgentToolResult<SnippetToolDetails>> {
	const { snippet, ctx, executor } = options;
	const maxDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;

	const depth = snippetDepth(options.toolCallId);
	if (depth > maxDepth) {
		throw new Error(
			`Snippet "${snippet.name}" exceeded the maximum snippet nesting depth of ${maxDepth}. ` +
				`A snippet probably calls itself, directly or through another snippet.`,
		);
	}

	const code = buildSnippetCode(snippet, options.input);
	const result = await executor.execute(options.toolCallId, { code }, options.signal, options.onUpdate, ctx);

	if (result.isError) {
		const text = contentText(result.content as readonly { type?: string; text?: string }[]);
		throw new Error(text === "" ? `Snippet "${snippet.name}" failed.` : text);
	}

	const details = result.details as { calls?: unknown; fullOutputPath?: string } | undefined;
	return {
		content: result.content,
		details: {
			snippet: snippet.name,
			path: snippet.path,
			...(details?.calls !== undefined ? { calls: details.calls } : {}),
			...(details?.fullOutputPath !== undefined ? { fullOutputPath: details.fullOutputPath } : {}),
		},
		...(result.usage !== undefined ? { usage: result.usage } : {}),
	};
}
