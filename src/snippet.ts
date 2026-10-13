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

import { parseSnippetSource, bodyOptionsProblem } from "./pragma.ts";
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

/**
 * Why a name no snippet may take, or `undefined` when the name is free.
 *
 * The registration path also skips any name another tool already holds (see
 * `registerSnippetTools`), but that check reads a snapshot of the tool
 * registry taken at session start. These rules cover what the snapshot
 * cannot see: a disabled `codemode` or `tool_search` tool is absent from it,
 * and `mcp__…` tools and the MCP resource tools register after snippets load
 * — those collisions would be silent. Both built-in names matter because pi
 * 1.2.0 treats a tool of that name that declares `reachesTools` as the real
 * codemode/tool_search loader, which snippet tools now declare.
 */
export function reservedNameProblem(name: string): string | undefined {
	const lower = name.toLowerCase();
	if (lower === "codemode" || lower === "tool_search") {
		const role =
			lower === "codemode"
				? "codemode tool that runs snippet bodies"
				: "tool_search tool that loads deferred MCP tools";
		return `snippet name "${name}" is reserved: it would shadow the built-in ${role} — rename the file or set another \`name\``;
	}
	if (lower.startsWith("mcp__")) {
		return (
			`snippet name "${name}" is reserved: names starting with "mcp__" belong to MCP tools, ` +
			"which register after snippets load — the collision would be silent"
		);
	}
	if (lower === "list_mcp_resources" || lower === "list_mcp_resource_templates" || lower === "read_mcp_resource") {
		return (
			`snippet name "${name}" is reserved: it is an MCP resource tool name, ` +
			"which registers after snippets load — the collision would be silent"
		);
	}
	return undefined;
}

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
	const reserved = reservedNameProblem(name);
	if (reserved !== undefined) return { ok: false, message: reserved };

	const body = parsed.body.trim();
	if (body === "") return { ok: false, message: "the snippet has an empty body" };

	// pi 1.2.0+ fails a script whose `// @options:` line is not its first line;
	// the generated script always prepends `const input = …`, so a body-level
	// options line can never end up first. Report it at load time instead of
	// failing every call at runtime.
	const optionsProblem = bodyOptionsProblem(body);
	if (optionsProblem !== undefined) return { ok: false, message: optionsProblem };

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
					shadowed.push({
						name: built.snippet.name,
						path: built.snippet.path,
						scope: built.snippet.scope,
						shadowedPath: previous.path,
						shadowedScope: previous.scope,
					});
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
