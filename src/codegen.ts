// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------
//
// A snippet runs by turning it back into the codemode script it always was:
//
//   // @options: {…}          ← pragma limits merged with the body's own line
//   const input = {…};        ← the validated tool arguments
//   <body>                    ← top-level await and return still work
//
// The generated source is handed to `ctx.executeTool("codemode", { code })`, so
// it flows through the same sandbox, globals, permissions, and guard
// compilation as a model-written script.

import { splitBodyOptions } from "./pragma.ts";
import type { Snippet } from "./types.ts";

/** The `@options` values the pragma contributes. */
export function snippetOptions(snippet: Pick<Snippet, "timeoutMs" | "maxOutputTokens">): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	if (snippet.timeoutMs !== undefined) options.timeout_ms = snippet.timeoutMs;
	if (snippet.maxOutputTokens !== undefined) options.max_output_tokens = snippet.maxOutputTokens;
	return options;
}

/** A JavaScript literal for `value`, safe inside a QuickJS script. */
export function jsonLiteral(value: unknown): string {
	const json = JSON.stringify(value === undefined ? {} : value) ?? "{}";
	return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/<\//g, "<\\/");
}

/**
 * Build the codemode source for one snippet invocation. The body's own
 * `@options:` line wins over the pragma's limits.
 */
export function buildSnippetCode(snippet: Snippet, input: unknown): string {
	const split = splitBodyOptions(snippet.body);
	const merged = { ...snippetOptions(snippet), ...(split.options ?? {}) };

	const lines: string[] = [];
	if (Object.keys(merged).length > 0) lines.push(`// @options: ${JSON.stringify(merged)}`);
	lines.push(`const input = ${jsonLiteral(input)};`);
	lines.push(split.body.trim());

	return lines.join("\n");
}
