import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { contentText, runSnippet, snippetDepth } from "./execute.ts";
import type { Snippet } from "./types.ts";

function snippet(overrides: Partial<Snippet> = {}): Snippet {
	return {
		name: "demo",
		label: "demo",
		description: "Demo.",
		input: { type: "object", properties: {} },
		body: "return input;",
		path: "/user/snippets/demo.js",
		scope: "user",
		enabled: true,
		...overrides,
	};
}

function fakeCtx(options: {
	readonly hasCodemode?: boolean;
	readonly outcome?: { isError: boolean; content: { type: string; text?: string }[]; details?: unknown };
	readonly onCall?: (name: string, args: unknown) => void;
}): ExtensionToolContext {
	const hasCodemode = options.hasCodemode ?? true;
	const outcome = options.outcome ?? { isError: false, content: [{ type: "text", text: "done" }], details: {} };
	return {
		tools: hasCodemode ? [{ name: "codemode" }] : [{ name: "read" }],
		async executeTool(name: string, args: unknown) {
			options.onCall?.(name, args);
			return {
				toolCall: { type: "toolCall", id: "x/0", name, arguments: {} },
				result: { content: outcome.content, details: outcome.details ?? {} },
				isError: outcome.isError,
			};
		},
	} as unknown as ExtensionToolContext;
}

describe("snippetDepth", () => {
	it("counts id segments", () => {
		expect(snippetDepth("call_abc")).toBe(1);
		expect(snippetDepth("call_abc/1")).toBe(2);
		expect(snippetDepth("call_abc/1/2")).toBe(3);
	});
});

describe("contentText", () => {
	it("joins text blocks", () => {
		expect(contentText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
	});
});

describe("runSnippet", () => {
	it("delegates to codemode with the generated code", async () => {
		let seen: unknown;
		const result = await runSnippet({
			snippet: snippet({ body: "return input.x;" }),
			input: { x: 1 },
			toolCallId: "call_1",
			signal: undefined,
			ctx: fakeCtx({ onCall: (_name, args) => (seen = args) }),
		});
		expect(seen).toEqual({ code: 'const input = {"x":1};\nreturn input.x;' });
		expect(result.details).toEqual({ snippet: "demo", path: "/user/snippets/demo.js" });
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
	});

	it("forwards codemode's nested-call details", async () => {
		const result = await runSnippet({
			snippet: snippet(),
			input: {},
			toolCallId: "call_1",
			signal: undefined,
			ctx: fakeCtx({ outcome: { isError: false, content: [], details: { calls: [{ id: "a" }], fullOutputPath: "/tmp/x" } } }),
		});
		expect(result.details).toMatchObject({ calls: [{ id: "a" }], fullOutputPath: "/tmp/x" });
	});

	it("throws codemode's error text on failure", async () => {
		await expect(
			runSnippet({
				snippet: snippet(),
				input: {},
				toolCallId: "call_1",
				signal: undefined,
				ctx: fakeCtx({ outcome: { isError: true, content: [{ type: "text", text: "Script error: boom" }] } }),
			}),
		).rejects.toThrow("Script error: boom");
	});

	it("fails clearly when the codemode tool is absent", async () => {
		await expect(
			runSnippet({
				snippet: snippet(),
				input: {},
				toolCallId: "call_1",
				signal: undefined,
				ctx: fakeCtx({ hasCodemode: false }),
			}),
		).rejects.toThrow(/codemode tool is not available/);
	});

	it("caps nesting depth", async () => {
		await expect(
			runSnippet({
				snippet: snippet(),
				input: {},
				toolCallId: "a/1/2/3",
				signal: undefined,
				ctx: fakeCtx({}),
				maxNestingDepth: 3,
			}),
		).rejects.toThrow(/nesting depth/);
	});
});
