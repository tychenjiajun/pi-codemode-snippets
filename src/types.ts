// ---------------------------------------------------------------------------
// pi-codemode-snippets — shared types
// ---------------------------------------------------------------------------
//
// A snippet is a user-authored `.js` file whose body is a codemode script and
// whose leading comment carries a `// @snippet:` pragma. The loader turns each
// file into the `Snippet` value below, and the extension registers one pi tool
// per enabled snippet, named by the snippet name.

/** Where a snippet file was found. Precedence: project overrides setting overrides user. */
export type SnippetScope = "user" | "setting" | "project";

/** Hints about what a snippet does, copied onto the registered tool. */
export interface SnippetAnnotations {
	/** The snippet does not modify its environment. */
	readOnlyHint?: boolean;
	/** The snippet may delete or overwrite data. */
	destructiveHint?: boolean;
	/** Repeating the snippet with the same input has no further effect. */
	idempotentHint?: boolean;
	/** The snippet reaches an open world of external entities. */
	openWorldHint?: boolean;
}

/** A loaded, validated snippet. */
export interface Snippet {
	/** Tool name. Defaults to the filename stem, overridable with the pragma `name`. */
	readonly name: string;
	/** Human-readable label for the UI. Defaults to `name`. */
	readonly label: string;
	/** Model-facing description. Required in the pragma. */
	readonly description: string;
	/** JSON Schema of the single object argument the tool accepts. */
	readonly input: Readonly<Record<string, unknown>>;
	/** The codemode script body, with the pragma comment removed. */
	readonly body: string;
	/** Absolute path of the source file. */
	readonly path: string;
	/** Where the file was found. */
	readonly scope: SnippetScope;
	/** `false` keeps the snippet out of the tool registry while `list`/`show` still see it. */
	readonly enabled: boolean;
	/** Merged into the generated `@options.timeout_ms`. */
	readonly timeoutMs?: number;
	/** Merged into the generated `@options.max_output_tokens`. */
	readonly maxOutputTokens?: number;
	/** Copied onto the registered tool. */
	readonly annotations?: SnippetAnnotations;
	/** Copied onto the registered tool as `promptGuidelines`. */
	readonly promptGuidelines?: readonly string[];
}

/** A snippet file that could not be loaded, or a registration conflict. */
export interface SnippetIssue {
	/** Path of the offending file, or a synthetic marker such as `<tool-name>`. */
	readonly path: string;
	/** Snippet name, when it could be determined. */
	readonly name?: string;
	/** One-line, user-facing reason. */
	readonly message: string;
}

/** A snippet shadowed by a higher-precedence file with the same name. */
export interface SnippetConflict {
	readonly name: string;
	/** The winning file. */
	readonly path: string;
	/** The losing file. */
	readonly shadowedPath: string;
}

/** The outcome of scanning the snippet directories. */
export interface SnippetLoadResult {
	/** Enabled and disabled snippets, deduplicated by name (highest precedence wins). */
	readonly snippets: readonly Snippet[];
	/** Files that could not be parsed or validated. */
	readonly issues: readonly SnippetIssue[];
	/** Files dropped because a same-named snippet had higher precedence. */
	readonly shadowed: readonly SnippetConflict[];
}

/** A directory to scan, plus the scope its snippets belong to. */
export interface SnippetDir {
	readonly dir: string;
	readonly scope: SnippetScope;
}
