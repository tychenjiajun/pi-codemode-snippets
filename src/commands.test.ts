import { describe, expect, it } from "vitest";

import { formatIssue, formatList, formatPreview, formatShow, formatStatusLine, formatValidation } from "./commands.ts";
import type { Snippet, SnippetStatus } from "./types.ts";

function snippet(overrides: Partial<Snippet> = {}): Snippet {
	return {
		name: "demo",
		label: "demo",
		description: "Demo.",
		input: { type: "object", properties: {} },
		body: "return 1;",
		path: "/user/snippets/demo.js",
		scope: "user",
		enabled: true,
		...overrides,
	};
}

function result(overrides: Partial<SnippetStatus> = {}): SnippetStatus {
	return { snippets: [], issues: [], shadowed: [], registered: [], ...overrides };
}

describe("formatIssue", () => {
	it("includes the name and path when known", () => {
		expect(formatIssue({ path: "/a.js", name: "a", message: "bad" })).toBe("  ⚠ a (/a.js): bad");
	});

	it("falls back to the path", () => {
		expect(formatIssue({ path: "/dir", message: "bad" })).toBe("  ⚠ /dir: bad");
	});
});

describe("formatList", () => {
	it("groups registered snippets with scope and path", () => {
		const output = formatList(result({ snippets: [snippet()], registered: ["demo"] }));
		expect(output).toContain("Snippets: 1 registered.");
		expect(output).toContain("Registered (1):");
		expect(output).toContain("✓ demo");
		expect(output).toContain("user");
		expect(output).toContain("/user/snippets/demo.js");
	});

	it("explains why an enabled snippet is not registered", () => {
		const output = formatList(
			result({
				snippets: [snippet()],
				issues: [{ path: "/user/snippets/demo.js", name: "demo", message: "tool name already taken" }],
			}),
		);
		expect(output).toContain("Snippets: 0 registered, 1 not registered.");
		expect(output).toContain("Not registered (1):");
		expect(output).toContain("✗ demo");
		expect(output).toContain("      tool name already taken");
		// The issue is a reason for the snippet, not a separate problem row.
		expect(output).not.toContain("Problems (");
	});

	it("marks a disabled snippet instead of blaming it on a failure", () => {
		const output = formatList(result({ snippets: [snippet({ enabled: false })] }));
		expect(output).toContain("⏸ demo");
		expect(output).toContain("disabled by the pragma");
	});

	it("hints at a reload for an enabled snippet with no issue", () => {
		expect(formatList(result({ snippets: [snippet()] }))).toContain("run /reload");
	});

	it("shows an empty-state hint", () => {
		expect(formatList(result())).toContain("No snippets found.");
	});

	it("shows both scopes of a project-level override", () => {
		const output = formatList(
			result({
				snippets: [snippet()],
				registered: ["demo"],
				shadowed: [
					{
						name: "demo",
						path: "/p/.pi/snippets/demo.js",
						scope: "project",
						shadowedPath: "/user/snippets/demo.js",
						shadowedScope: "user",
					},
				],
			}),
		);
		expect(output).toContain("1 registered, 1 shadowed");
		expect(output).toContain("Shadowed by a higher-precedence file (1):");
		expect(output).toContain("/user/snippets/demo.js (user) is overridden by /p/.pi/snippets/demo.js (project)");
	});

	it("keeps an issue that belongs to no loaded snippet in Problems", () => {
		const output = formatList(result({ issues: [{ path: "/bad.js", message: "boom" }] }));
		expect(output).toContain("Problems (1):");
		expect(output).toContain("⚠ /bad.js: boom");
	});
});

describe("formatStatusLine", () => {
	it("counts registered snippets and unresolved problems", () => {
		expect(formatStatusLine(result())).toBe("snippets: 0/0 registered");
		expect(
			formatStatusLine(
				result({
					snippets: [snippet()],
					registered: ["demo"],
					issues: [{ path: "/bad.js", message: "boom" }],
				}),
			),
		).toBe("snippets: 1/1 registered, 1 problem");
	});
});

describe("formatShow", () => {
	it("prints the pragma summary and body", () => {
		const output = formatShow(snippet({ timeoutMs: 1000, annotations: { readOnlyHint: true } }));
		expect(output).toContain("demo — Demo.");
		expect(output).toContain("timeoutMs: 1000");
		expect(output).toContain("readOnlyHint");
		expect(output).toContain("body:");
		expect(output).toContain("return 1;");
	});
});

describe("formatValidation", () => {
	it("reports a clean run", () => {
		expect(formatValidation(result({ snippets: [snippet()], registered: ["demo"] }))).toContain(
			"No problems found.",
		);
	});

	it("counts what registered and points at /reload for the rest", () => {
		const output = formatValidation(result({ snippets: [snippet()] }));
		expect(output).toContain("Checked 1 snippet: 0 registered, 1 not registered.");
		expect(output).toContain("No problems found.");
		expect(output).toContain("Run /reload");
	});

	it("reports problems", () => {
		const output = formatValidation(result({ issues: [{ path: "/bad.js", message: "boom" }] }));
		expect(output).toContain("Problems (1):");
	});
});

describe("formatPreview", () => {
	it("prints the generated codemode script", () => {
		const output = formatPreview(snippet({ body: "return input.x;" }), { x: 1 });
		expect(output).toContain("Preview of demo");
		expect(output).toContain('const input = {"x":1};');
		expect(output).toContain("return input.x;");
	});
});
