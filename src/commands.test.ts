import { describe, expect, it } from "vitest";

import { formatIssue, formatList, formatPreview, formatShow, formatValidation } from "./commands.ts";
import type { Snippet, SnippetLoadResult } from "./types.ts";

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

function result(overrides: Partial<SnippetLoadResult> = {}): SnippetLoadResult {
	return { snippets: [], issues: [], shadowed: [], ...overrides };
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
	it("lists snippets with scope and path", () => {
		const output = formatList(result({ snippets: [snippet()] }));
		expect(output).toContain("Snippets (1):");
		expect(output).toContain("demo");
		expect(output).toContain("user");
		expect(output).toContain("/user/snippets/demo.js");
	});

	it("marks disabled snippets", () => {
		expect(formatList(result({ snippets: [snippet({ enabled: false })] }))).toContain("[disabled]");
	});

	it("shows an empty-state hint", () => {
		expect(formatList(result())).toContain("No snippets found.");
	});

	it("reports shadowed and problem entries", () => {
		const output = formatList(
			result({
				snippets: [snippet()],
				issues: [{ path: "/bad.js", message: "boom" }],
				shadowed: [{ name: "demo", path: "/p/demo.js", shadowedPath: "/u/demo.js" }],
			}),
		);
		expect(output).toContain("Shadowed");
		expect(output).toContain("Problems (1):");
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
		expect(formatValidation(result({ snippets: [snippet()] }))).toContain("No problems found.");
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
