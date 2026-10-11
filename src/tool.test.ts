import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { createSnippetTool, promptSnippetFromDescription } from "./tool.ts";
import type { Snippet } from "./types.ts";

function snippet(overrides: Partial<Snippet> = {}): Snippet {
	return {
		name: "demo",
		label: "demo",
		description: "Demo snippet.",
		input: { type: "object", properties: {} },
		body: "return input;",
		path: "/user/snippets/demo.js",
		scope: "user",
		enabled: true,
		...overrides,
	};
}

function fakeCtx(): ExtensionToolContext {
	return {
		tools: [{ name: "codemode" }],
		async executeTool(_name: string, args: unknown) {
			return {
				toolCall: { type: "toolCall", id: "x/0", name: "codemode", arguments: args },
				result: { content: [{ type: "text", text: "ok" }], details: {} },
				isError: false,
			};
		},
	} as unknown as ExtensionToolContext;
}

describe("promptSnippetFromDescription", () => {
	it("takes the first sentence", () => {
		expect(promptSnippetFromDescription("List PRs. Then more text.")).toBe("List PRs.");
	});

	it("falls back to the first line", () => {
		expect(promptSnippetFromDescription("List PRs\nmore")).toBe("List PRs");
	});

	it("truncates long text", () => {
		const long = "x".repeat(200);
		const snippet = promptSnippetFromDescription(long);
		expect(snippet.length).toBe(120);
		expect(snippet.endsWith("...")).toBe(true);
	});
});

describe("createSnippetTool", () => {
	it("maps snippet fields onto the tool definition", () => {
		const tool = createSnippetTool(
			snippet({
				label: "Demo Label",
				description: "Demo snippet. More.",
				input: { type: "object", properties: { a: { type: "string" } } },
				annotations: { readOnlyHint: true },
				promptGuidelines: ["Rule one."],
			}),
		);
		expect(tool.name).toBe("demo");
		expect(tool.label).toBe("Demo Label");
		expect(tool.description).toBe("Demo snippet. More.");
		expect(tool.promptSnippet).toBe("Demo snippet.");
		expect(tool.parameters).toEqual({ type: "object", properties: { a: { type: "string" } } });
		expect(tool.annotations).toEqual({ readOnlyHint: true });
		expect(tool.promptGuidelines).toEqual(["Rule one."]);
	});

	it("runs the snippet through codemode when executed", async () => {
		const tool = createSnippetTool(snippet({ body: "return input.a;" }));
		const result = await tool.execute("call_1", { a: 1 }, undefined, undefined, fakeCtx());
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.details).toEqual({ snippet: "demo", path: "/user/snippets/demo.js" });
	});
});
