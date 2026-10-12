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
import type { Snippet, SnippetIssue, SnippetStatus } from "./types.ts";

export interface SnippetCommandsHost {
	/** What loaded, what registered, and what collided — from the most recent load. */
	list(): SnippetStatus;
	/** Re-scan the snippet directories without re-registering tools. */
	rescan(ctx: ExtensionCommandContext): Promise<SnippetStatus>;
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

/**
 * The footer status line (`ctx.ui.setStatus("snippets", …)`): one glance at
 * how many snippets became tools, plus unresolved problems and overrides.
 */
export function formatStatusLine(status: SnippetStatus): string {
	const parts = [`${status.registered.length}/${status.snippets.length} registered`];
	if (status.issues.length > 0) parts.push(`${status.issues.length} problem${status.issues.length === 1 ? "" : "s"}`);
	if (status.shadowed.length > 0) parts.push(`${status.shadowed.length} shadowed`);
	return `snippets: ${parts.join(", ")}`;
}

/** Names with their registration issue, for the "why is it not registered?" line. */
function registrationReasons(issues: readonly SnippetIssue[]): Map<string, string> {
	const reasons = new Map<string, string>();
	for (const issue of issues) if (issue.name) reasons.set(issue.name, issue.message);
	return reasons;
}

/** `  ✓ name  scope  path`, name column aligned across the section. */
function snippetRow(snippet: Snippet, marker: string, width: number): string {
	return `  ${marker} ${snippet.name.padEnd(width)}  ${snippet.scope.padEnd(7)}  ${snippet.path}`;
}

function nameWidth(snippets: readonly Snippet[]): number {
	return Math.max(...snippets.map((snippet) => snippet.name.length));
}

/** Issues that belong to no loaded snippet: bad files, unreadable directories. */
function fileIssues(status: SnippetStatus): SnippetIssue[] {
	const names = new Set(status.snippets.map((snippet) => snippet.name));
	return status.issues.filter((issue) => issue.name === undefined || !names.has(issue.name));
}

/** `/snippet list` — grouped by outcome, so every file's fate is on screen. */
export function formatList(status: SnippetStatus): string {
	if (status.snippets.length === 0 && status.issues.length === 0 && status.shadowed.length === 0) {
		return ["No snippets found.", "", "Add a `.js` file to ~/.pi/agent/snippets/ or <cwd>/.pi/snippets/."].join("\n");
	}

	const reasons = registrationReasons(status.issues);
	const registered = new Set(status.registered);
	const withTool = status.snippets.filter((snippet) => registered.has(snippet.name));
	const withoutTool = status.snippets.filter((snippet) => !registered.has(snippet.name));
	const problems = fileIssues(status);

	const summary = [`${withTool.length} registered`];
	if (withoutTool.length > 0) summary.push(`${withoutTool.length} not registered`);
	if (status.shadowed.length > 0) summary.push(`${status.shadowed.length} shadowed`);
	if (problems.length > 0) summary.push(`${problems.length} problem${problems.length === 1 ? "" : "s"}`);
	const lines = [`Snippets: ${summary.join(", ")}.`];

	if (withTool.length > 0) {
		const width = nameWidth(withTool);
		lines.push("", `Registered (${withTool.length}):`, ...withTool.map((snippet) => snippetRow(snippet, "✓", width)));
	}

	if (withoutTool.length > 0) {
		const width = nameWidth(withoutTool);
		lines.push("", `Not registered (${withoutTool.length}):`);
		for (const snippet of withoutTool) {
			const reason = snippet.enabled
				? (reasons.get(snippet.name) ?? "not registered — run /reload")
				: "disabled by the pragma (`enabled: false`)";
			lines.push(snippetRow(snippet, snippet.enabled ? "✗" : "⏸", width));
			lines.push(`      ${reason}`);
		}
	}

	if (status.shadowed.length > 0) {
		lines.push("", `Shadowed by a higher-precedence file (${status.shadowed.length}):`);
		for (const conflict of status.shadowed) {
			lines.push(
				`  ↷ ${conflict.name}: ${conflict.shadowedPath} (${conflict.shadowedScope}) ` +
					`is overridden by ${conflict.path} (${conflict.scope})`,
			);
		}
	}

	if (problems.length > 0) lines.push("", `Problems (${problems.length}):`, ...problems.map(formatIssue));
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
export function formatValidation(status: SnippetStatus): string {
	const count = status.snippets.length;
	const registered = status.registered.length;
	const lines = [
		`Checked ${count} snippet${count === 1 ? "" : "s"}: ` +
			`${registered} registered, ${count - registered} not registered.`,
	];
	if (status.issues.length === 0 && status.shadowed.length === 0) {
		lines.push("No problems found.");
		if (count - registered > 0) lines.push("Run /reload to register the new files.");
		return lines.join("\n");
	}
	if (status.issues.length > 0) {
		lines.push("", `Problems (${status.issues.length}):`, ...status.issues.map(formatIssue));
	}
	if (status.shadowed.length > 0) {
		lines.push("", `Shadowed (${status.shadowed.length}):`);
		for (const conflict of status.shadowed) {
			lines.push(
				`  ${conflict.name}: ${conflict.shadowedPath} (${conflict.shadowedScope}) ` +
					`is overridden by ${conflict.path} (${conflict.scope})`,
			);
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
