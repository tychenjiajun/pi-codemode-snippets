// ---------------------------------------------------------------------------
// The `@snippet` pragma
// ---------------------------------------------------------------------------
//
// A snippet file starts with a comment that carries a JSON pragma:
//
//   // @snippet: {"description": "…", "input": { … }}
//   /* @snippet: { "description": "…" } */
//
// The pragma may span several `//` lines:
//
//   // @snippet: {
//   //   "description": "List open PRs.",
//   //   "input": { "type": "object", "properties": { "repo": { "type": "string" } } }
//   // }
//
// Everything after the comment is the codemode script body. Pi's own
// `@options:` line is allowed as the first line of the body; the extension
// extracts it, merges it with the pragma limits, and re-emits a single leading
// options line (codemode requires the options line first).

import { isRecord } from "./guards.ts";
import type { SnippetAnnotations } from "./types.ts";

/** The validated `@snippet` pragma. */
export interface SnippetPragma {
	/** Tool name. Defaults to the filename stem. */
	name?: string;
	/** Model-facing description. Required. */
	description: string;
	/** JSON Schema of the single object argument. Defaults to an empty object schema. */
	input?: Record<string, unknown>;
	/** UI label. Defaults to `name`. */
	label?: string;
	/** `false` keeps the file out of the tool registry. Defaults to `true`. */
	enabled?: boolean;
	/** Merged into the generated `@options.timeout_ms`. */
	timeoutMs?: number;
	/** Merged into the generated `@options.max_output_tokens`. */
	maxOutputTokens?: number;
	/** Copied onto the registered tool. */
	annotations?: SnippetAnnotations;
	/** Copied onto the registered tool. */
	promptGuidelines?: string[];
}

export type ParsePragmaResult =
	| { readonly ok: true; readonly pragma: SnippetPragma; readonly body: string }
	| { readonly ok: false; readonly message: string };

const PRAGMA_TAG = "@snippet:";
const ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/**
 * Extract the first balanced `{ … }` object from `text`, ignoring braces inside
 * JSON strings. Returns `undefined` when there is no object or it never closes.
 */
export function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start === -1) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

interface LeadingComment {
	readonly text: string;
	/** Index just past the comment, where the body begins. */
	readonly end: number;
}

/** The leading `//`/`/* *\/` comment block of a file, if any. */
export function extractLeadingComment(source: string): LeadingComment | undefined {
	let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;

	// Allow a shebang before the pragma.
	if (source.startsWith("#!", cursor)) {
		const newline = source.indexOf("\n", cursor);
		cursor = newline === -1 ? source.length : newline + 1;
	}

	while (cursor < source.length && /[ \t\r\n]/.test(source[cursor] ?? "")) cursor += 1;

	if (source.startsWith("/*", cursor)) {
		const end = source.indexOf("*/", cursor + 2);
		if (end === -1) return undefined;
		return { text: source.slice(cursor + 2, end), end: end + 2 };
	}

	if (source.startsWith("//", cursor)) {
		const parts: string[] = [];
		while (cursor < source.length) {
			const lineEnd = source.indexOf("\n", cursor);
			const stop = lineEnd === -1 ? source.length : lineEnd;
			const line = source.slice(cursor, stop);
			const match = /^[ \t]*\/\/(.*)$/.exec(line);
			if (!match) break;
			// A following `@options:` line belongs to the body, not the pragma.
			if (parts.length > 0 && /^[ \t]*\/\/[ \t]*@options:/.test(line)) break;
			parts.push(match[1] ?? "");
			cursor = stop + 1;
		}
		return { text: parts.join("\n"), end: cursor };
	}

	return undefined;
}

/** Parse the leading comment of `source` and return the validated pragma plus the body. */
export function parseSnippetSource(source: string): ParsePragmaResult {
	const comment = extractLeadingComment(source);
	if (!comment) return { ok: false, message: "missing a leading `// @snippet: {…}` pragma comment" };

	const tagIndex = comment.text.indexOf(PRAGMA_TAG);
	if (tagIndex === -1) return { ok: false, message: "the leading comment has no `@snippet:` tag" };

	const json = extractJsonObject(comment.text.slice(tagIndex + PRAGMA_TAG.length));
	if (json === undefined) return { ok: false, message: "the `@snippet:` pragma is not a JSON object" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `the \`@snippet:\` pragma is not valid JSON: ${detail}` };
	}

	const validated = validatePragma(parsed);
	if (!validated.ok) return validated;

	const body = source.slice(comment.end).replace(/^[ \t]*\r?\n/, "");
	return { ok: true, pragma: validated.pragma, body };
}

/** Validate a parsed pragma value. */
export function validatePragma(
	value: unknown,
): { readonly ok: true; readonly pragma: SnippetPragma } | { readonly ok: false; readonly message: string } {
	if (!isRecord(value)) return { ok: false, message: "the pragma must be a JSON object" };

	const description = value.description;
	if (typeof description !== "string" || description.trim() === "") {
		return { ok: false, message: "the pragma needs a non-empty `description`" };
	}

	const pragma: SnippetPragma = { description: description.trim() };

	if (value.name !== undefined) {
		if (typeof value.name !== "string" || value.name.trim() === "") {
			return { ok: false, message: "`name` must be a non-empty string" };
		}
		pragma.name = value.name.trim();
	}

	if (value.label !== undefined) {
		if (typeof value.label !== "string" || value.label.trim() === "") {
			return { ok: false, message: "`label` must be a non-empty string" };
		}
		pragma.label = value.label.trim();
	}

	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") return { ok: false, message: "`enabled` must be a boolean" };
		pragma.enabled = value.enabled;
	}

	if (value.input !== undefined) {
		if (!isRecord(value.input)) return { ok: false, message: "`input` must be a JSON Schema object" };
		pragma.input = value.input;
	}

	for (const [field, key] of [
		["timeoutMs", "timeoutMs"],
		["maxOutputTokens", "maxOutputTokens"],
	] as const) {
		const candidate = value[field];
		if (candidate === undefined) continue;
		if (typeof candidate !== "number") {
			return { ok: false, message: `\`${field}\` must be a positive integer` };
		}
		const problem = limitValueProblem(field, candidate);
		if (problem !== undefined) return { ok: false, message: problem };
		pragma[key] = candidate;
	}

	if (value.annotations !== undefined) {
		if (!isRecord(value.annotations)) return { ok: false, message: "`annotations` must be a JSON object" };
		const annotations: SnippetAnnotations = {};
		for (const key of ANNOTATION_KEYS) {
			const candidate = value.annotations[key];
			if (candidate === undefined) continue;
			if (typeof candidate !== "boolean") {
				return { ok: false, message: `\`annotations.${key}\` must be a boolean` };
			}
			annotations[key] = candidate;
		}
		if (Object.keys(annotations).length > 0) pragma.annotations = annotations;
	}

	if (value.promptGuidelines !== undefined) {
		const guidelines = value.promptGuidelines;
		if (!Array.isArray(guidelines) || guidelines.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
			return { ok: false, message: "`promptGuidelines` must be an array of non-empty strings" };
		}
		if (guidelines.length > 0) pragma.promptGuidelines = guidelines.map((entry) => entry.trim());
	}

	return { ok: true, pragma };
}

/** The `@options` fields pi's codemode accepts (pi 1.2.0). */
const OPTIONS_FIELDS = ["max_output_tokens", "timeout_ms"] as const;

/**
 * Why a pragma limit cannot run, mirroring pi's own `@options` parsing: the
 * merged value must be an integer (`timeout_ms` up to 2147483647) or pi
 * rejects the generated script before it runs. The pragma keeps both limits
 * positive — a zero cap is useless and pi rejects `timeout_ms: 0` anyway.
 */
export function limitValueProblem(field: "timeoutMs" | "maxOutputTokens", value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		return `\`${field}\` must be a positive integer`;
	}
	if (field === "timeoutMs" && value > 2147483647) {
		return `\`${field}\` must be at most 2147483647 milliseconds (pi's \`timeout_ms\` limit)`;
	}
	return undefined;
}

/**
 * Why a parsed body `@options:` object cannot run, mirroring pi's own parser:
 * pi 1.2.0 accepts only `max_output_tokens` (a non-negative integer) and
 * `timeout_ms` (a positive integer up to 2147483647) and fails the call on
 * anything else, so report it at load time instead of on every call.
 */
export function optionsValueProblem(options: Record<string, unknown>): string | undefined {
	for (const [key, option] of Object.entries(options)) {
		if (!(OPTIONS_FIELDS as readonly string[]).includes(key)) {
			return `the body's \`@options:\` only supports \`max_output_tokens\` and \`timeout_ms\`; got \`${key}\``;
		}
		if (typeof option !== "number" || !Number.isSafeInteger(option)) {
			return `the body's \`@options.${key}\` must be an integer`;
		}
		if (key === "timeout_ms" && (option <= 0 || option > 2147483647)) {
			return "the body's `@options.timeout_ms` must be a positive integer up to 2147483647";
		}
		if (key === "max_output_tokens" && option < 0) {
			return "the body's `@options.max_output_tokens` must be a non-negative integer";
		}
	}
	return undefined;
}

export interface SplitBodyOptionsResult {
	/** The `@options:` values found at the start of the body, if any. */
	readonly options?: Record<string, unknown>;
	/** The body with the options comment removed. */
	readonly body: string;
}

/**
 * Pull a leading `@options:` comment out of a script body. A malformed options
 * comment is left in place for `bodyOptionsProblem` to report, rather than the
 * extension silently changing the script.
 */
export function splitBodyOptions(body: string): SplitBodyOptionsResult {
	const lead = /^[ \t\r\n]*/.exec(body)?.[0] ?? "";
	const rest = body.slice(lead.length);

	let comment: string | undefined;
	let consumed = 0;

	if (rest.startsWith("//")) {
		const newline = rest.indexOf("\n");
		const line = newline === -1 ? rest : rest.slice(0, newline);
		const match = /^\/\/[ \t]*@options:[ \t]*(.*)$/.exec(line);
		if (match) {
			comment = match[1] ?? "";
			consumed = newline === -1 ? rest.length : newline + 1;
		}
	} else if (rest.startsWith("/*")) {
		const end = rest.indexOf("*/");
		if (end !== -1) {
			const match = /^[ \t]*@options:[ \t]*([\s\S]*)$/.exec(rest.slice(2, end));
			if (match) {
				comment = match[1] ?? "";
				consumed = end + 2;
				if (rest[consumed] === "\n") consumed += 1;
			}
		}
	}

	if (comment === undefined) return { body };

	const json = extractJsonObject(comment);
	if (json === undefined) return { body };

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { body };
	}
	if (!isRecord(parsed)) return { body };

	const remaining = (lead + rest.slice(consumed)).replace(/^[ \t]*\r?\n/, "");
	return { options: parsed, body: remaining };
}

/**
 * Why the body's `@options:` comments cannot run, or `undefined` when they are
 * fine. The extension injects `const input = …` before the body, so any
 * `// @options:` line left in the body — a malformed leading one, or a valid
 * one that is not the body's first line — lands after the first line of the
 * generated script, and pi 1.2.0+ fails the call with an error before the
 * script runs instead of silently dropping the options.
 */
export function bodyOptionsProblem(body: string): string | undefined {
	// A valid leading comment is extracted; a malformed one stays in the body.
	const split = splitBodyOptions(body);
	const extracted = split.options !== undefined;
	const lines = body.split("\n");
	const firstContent = lines.findIndex((line) => line.trim() !== "");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trimStart().startsWith("// @options:")) continue;
		if (index === firstContent) {
			// Extracted means this line was valid and removed; a duplicate below is a stray line.
			if (extracted) continue;
			return "the body's leading `// @options:` line is not a valid JSON object — fix it or remove it";
		}
		return `the body has a \`// @options:\` line on body line ${index + 1}: pi requires it to be the first line of the body — move it to the top or remove it`;
	}
	// A leading `/* @options: … */` block never appears as a `// @options:`
	// line above, so its fields are checked here.
	return split.options !== undefined ? optionsValueProblem(split.options) : undefined;
}
