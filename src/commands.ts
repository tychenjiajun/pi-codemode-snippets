// ---------------------------------------------------------------------------
// `/snippet` command
// ---------------------------------------------------------------------------
//
//   /snippet list
//   /snippet show <name>
//   /snippet validate
//   /snippet preview <name> [json]
//
// Commands run in the command context, which has no `executeTool()`, so there is
// no `/snippet run`: executing a snippet is a normal tool call. `preview` is the
// deterministic alternative — it validates the input and prints the exact
// codemode script the tool would run.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { buildSnippetCode } from "./codegen.ts";
import type { Snippet, SnippetIssue, SnippetLoadResult } from "./types.ts";

export interface SnippetCommandsHost {
	/** The snippets and issues from the most recent load. */
	list(): SnippetLoadResult;
	/** Re-scan the snippet directories without re-registering tools. */
	rescan(ctx: ExtensionCommandContext): Promise<SnippetLoadResult>;
}

const USAGE = [
	"Usage:",
	"  /snippet list                 List loaded snippets",
	"  /snippet show <name>          Show a snippet's pragma and body",
	"  /snippet validate             Re-scan and report problems",
	"  /snippet preview <name> [json]  Print the codemode script for an input",
].join("\n");

/** Render one issue as a single line. */
export function formatIssue(issue: SnippetIssue): string {
	const name = issue.name ? `${issue.name} (${issue.path})` : issue.path;
	return `  ⚠ ${name}: ${issue.message}`;
}

/** `/snippet list`. */
export function formatList(result: SnippetLoadResult): string {
	if (result.snippets.length === 0) {
		const lines = ["No snippets found.", "", "Add a `.js` file to ~/.pi/agent/snippets/ or <cwd>/.pi/snippets/."];
		if (result.issues.length > 0) lines.push("", ...result.issues.map(formatIssue));
		return lines.join("\n");
	}

	const width = Math.max(...result.snippets.map((snippet) => snippet.name.length));
	const lines = [`Snippets (${result.snippets.length}):`];
	for (const snippet of result.snippets) {
		const flags = snippet.enabled ? "" : "  [disabled]";
		lines.push(`  ${snippet.name.padEnd(width)}  ${snippet.scope.padEnd(7)}  ${snippet.path}${flags}`);
	}
	if (result.shadowed.length > 0) {
		lines.push("", "Shadowed by a higher-precedence file:");
		for (const conflict of result.shadowed) {
			lines.push(`  ${conflict.name}: ${conflict.shadowedPath} ← ${conflict.path}`);
		}
	}
	if (result.issues.length > 0) {
		lines.push("", `Problems (${result.issues.length}):`, ...result.issues.map(formatIssue));
	}
	return lines.join("\n");
}

/** `/snippet show <name>`. */
export function formatShow(snippet: Snippet): string {
	const lines = [
		`${snippet.name} — ${snippet.description}`,
		`path: ${snippet.path}`,
		`scope: ${snippet.scope}    enabled: ${snippet.enabled}`,
	];
	if (snippet.timeoutMs !== undefined) lines.push(`timeoutMs: ${snippet.timeoutMs}`);
	if (snippet.maxOutputTokens !== undefined) lines.push(`maxOutputTokens: ${snippet.maxOutputTokens}`);
	lines.push(`input: ${JSON.stringify(snippet.input)}`);
	if (snippet.annotations) lines.push(`annotations: ${JSON.stringify(snippet.annotations)}`);
	lines.push("", "body:", snippet.body);
	return lines.join("\n");
}

/** `/snippet validate`. */
export function formatValidation(result: SnippetLoadResult): string {
	const lines = [`Checked ${result.snippets.length} snippet${result.snippets.length === 1 ? "" : "s"}.`];
	if (result.issues.length === 0 && result.shadowed.length === 0) {
		lines.push("No problems found.");
		return lines.join("\n");
	}
	if (result.issues.length > 0) {
		lines.push("", `Problems (${result.issues.length}):`, ...result.issues.map(formatIssue));
	}
	if (result.shadowed.length > 0) {
		lines.push("", `Shadowed (${result.shadowed.length}):`);
		for (const conflict of result.shadowed) {
			lines.push(`  ${conflict.name}: ${conflict.shadowedPath} ← ${conflict.path}`);
		}
	}
	return lines.join("\n");
}

/** `/snippet preview <name> [json]`. */
export function formatPreview(snippet: Snippet, input: unknown): string {
	return [`Preview of ${snippet.name} (${snippet.path}):`, "", buildSnippetCode(snippet, input)].join("\n");
}

/** Register the `/snippet` command. */
export function registerSnippetCommands(pi: ExtensionAPI, host: SnippetCommandsHost): void {
	pi.registerCommand("snippet", {
		description: "Inspect codemode snippets (list, show, validate, preview)",
		handler: async (args, ctx) => {
			const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
				else console.log(message);
			};

			if (subcommand === "list") {
				notify(formatList(host.list()));
				return;
			}

			if (subcommand === "validate") {
				const result = await host.rescan(ctx);
				notify(formatValidation(result), result.issues.length > 0 ? "warning" : "info");
				return;
			}

			if (subcommand === "show") {
				const name = rest[0];
				const snippet = name ? host.list().snippets.find((entry) => entry.name === name) : undefined;
				notify(snippet ? formatShow(snippet) : `Unknown snippet "${name ?? ""}".\n\n${USAGE}`, snippet ? "info" : "warning");
				return;
			}

			if (subcommand === "preview") {
				const name = rest[0];
				const snippet = name ? host.list().snippets.find((entry) => entry.name === name) : undefined;
				if (!snippet) {
					notify(`Unknown snippet "${name ?? ""}".\n\n${USAGE}`, "warning");
					return;
				}
				const json = rest.slice(1).join(" ");
				let input: unknown = {};
				if (json) {
					try {
						input = JSON.parse(json);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						notify(`Invalid JSON input: ${detail}`, "error");
						return;
					}
				}
				notify(formatPreview(snippet, input));
				return;
			}

			notify(USAGE, "warning");
		},
	});
}
