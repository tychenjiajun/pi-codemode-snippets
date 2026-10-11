// ---------------------------------------------------------------------------
// Snippet discovery
// ---------------------------------------------------------------------------
//
// Snippets live as flat `*.js` files in a handful of directories. The loader
// reads them, parses the pragma, and deduplicates them by name with a fixed
// precedence: project overrides setting overrides user; among setting dirs,
// later entries override earlier ones. A file that fails to parse becomes an
// issue, never an exception.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseSnippetSource } from "./pragma.ts";
import type { Snippet, SnippetConflict, SnippetDir, SnippetIssue, SnippetLoadResult, SnippetScope } from "./types.ts";

/** Filesystem seam, so the loader can be tested without touching disk. */
export interface SnippetFs {
	/** Regular files and symlinks in `dir`. Directories are excluded. */
	list(dir: string): Promise<readonly string[]>;
	/** Read a file as UTF-8. */
	read(path: string): Promise<string>;
}

export const defaultSnippetFs: SnippetFs = {
	async list(dir) {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name);
	},
	read: (path) => readFile(path, "utf8"),
};

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SCOPE_RANK: Record<SnippetScope, number> = { user: 0, setting: 1, project: 2 };

/** The snippet name a file provides: the pragma `name`, else the filename stem. */
export function snippetNameFromPath(path: string): string {
	return basename(path).replace(/\.js$/i, "");
}

export type BuildSnippetResult =
	| { readonly ok: true; readonly snippet: Snippet }
	| { readonly ok: false; readonly message: string };

/** Parse one snippet file into a `Snippet`, or explain why it cannot be used. */
export function buildSnippet(options: {
	readonly source: string;
	readonly path: string;
	readonly scope: SnippetScope;
}): BuildSnippetResult {
	const parsed = parseSnippetSource(options.source);
	if (!parsed.ok) return { ok: false, message: parsed.message };

	const name = parsed.pragma.name ?? snippetNameFromPath(options.path);
	if (!NAME_PATTERN.test(name)) {
		return {
			ok: false,
			message: `snippet name "${name}" must match ${NAME_PATTERN} (letters, digits, "_" and "-", starting with a letter or "_")`,
		};
	}

	const body = parsed.body.trim();
	if (body === "") return { ok: false, message: "the snippet has an empty body" };

	return {
		ok: true,
		snippet: {
			name,
			label: parsed.pragma.label ?? name,
			description: parsed.pragma.description,
			input: parsed.pragma.input ?? { type: "object", properties: {} },
			body,
			path: options.path,
			scope: options.scope,
			enabled: parsed.pragma.enabled ?? true,
			...(parsed.pragma.timeoutMs !== undefined ? { timeoutMs: parsed.pragma.timeoutMs } : {}),
			...(parsed.pragma.maxOutputTokens !== undefined ? { maxOutputTokens: parsed.pragma.maxOutputTokens } : {}),
			...(parsed.pragma.annotations ? { annotations: parsed.pragma.annotations } : {}),
			...(parsed.pragma.promptGuidelines ? { promptGuidelines: parsed.pragma.promptGuidelines } : {}),
		},
	};
}

/** Scan the given directories and return the deduplicated snippet set. */
export async function loadSnippets(
	dirs: readonly SnippetDir[],
	fs: SnippetFs = defaultSnippetFs,
): Promise<SnippetLoadResult> {
	// Stable sort by scope, so within a scope the caller's order is preserved.
	const ordered = dirs
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => SCOPE_RANK[a.entry.scope] - SCOPE_RANK[b.entry.scope] || a.index - b.index)
		.map(({ entry }) => entry);

	const byName = new Map<string, Snippet>();
	const issues: SnippetIssue[] = [];
	const shadowed: SnippetConflict[] = [];
	const seenDirs = new Set<string>();

	for (const { dir, scope } of ordered) {
		if (seenDirs.has(dir)) continue;
		seenDirs.add(dir);

		let files: readonly string[];
		try {
			files = await fs.list(dir);
		} catch (error) {
			if (isMissingDirectory(error)) continue;
			const detail = error instanceof Error ? error.message : String(error);
			issues.push({ path: dir, message: `cannot read the snippet directory: ${detail}` });
			continue;
		}

		for (const file of files) {
			if (!file.toLowerCase().endsWith(".js")) continue;
			const path = join(dir, file);
			try {
				const source = await fs.read(path);
				const built = buildSnippet({ source, path, scope });
				if (!built.ok) {
					issues.push({ path, message: built.message });
					continue;
				}
				const previous = byName.get(built.snippet.name);
				if (previous) {
					shadowed.push({ name: built.snippet.name, path: built.snippet.path, shadowedPath: previous.path });
				}
				byName.set(built.snippet.name, built.snippet);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				issues.push({ path, message: `cannot read the snippet file: ${detail}` });
			}
		}
	}

	return { snippets: [...byName.values()], issues, shadowed };
}

/** Whether an error is an ENOENT-style missing directory. */
function isMissingDirectory(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
