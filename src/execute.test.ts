import { describe, expect, it } from "vitest";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import type { CodemodeExecutor } from "./codemode.ts";
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

interface ExecutorCall {
	name: string;
	code: string;
	toolCallId: string;
}

function fakeExecutor(options: {
	readonly outcome?: { isError?: boolean; content: { type: string; text?: string }[]; details?: unknown; usage?: unknown };
	readonly onCall?: (call: ExecutorCall) => void;
}): CodemodeExecutor {
	const outcome = options.outcome ?? { content: [{ type: "text", text: "done" }], details: {} };
	return {
		async execute(toolCallId, params) {
			options.onCall?.({ name: "codemode", code: params.code, toolCallId });
			return {
				content: outcome.content,
				details: outcome.details ?? {},
				...(outcome.isError ? { isError: true } : {}),
				...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
			} as AgentToolResult<unknown>;
		},
	};
}

function fakeCtx(): ExtensionToolContext {
	return {} as unknown as ExtensionToolContext;
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
	it("runs the generated code through the codemode executor", async () => {
		let seen: ExecutorCall | undefined;
		const result = await runSnippet({
			snippet: snippet({ body: "return input.x;" }),
			input: { x: 1 },
			toolCallId: "call_1",
			signal: undefined,
			ctx: fakeCtx(),
			executor: fakeExecutor({ onCall: (call) => (seen = call) }),
		});
		expect(seen).toEqual({ name: "codemode", code: 'const input = {"x":1};\nreturn input.x;', toolCallId: "call_1" });
		expect(result.details).toEqual({ snippet: "demo", path: "/user/snippets/demo.js" });
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
	});

	it("forwards codemode's nested-call details and usage", async () => {
		const result = await runSnippet({
			snippet: snippet(),
			input: {},
			toolCallId: "call_1",
			signal: undefined,
			ctx: fakeCtx(),
			executor: fakeExecutor({
				outcome: { content: [], details: { calls: [{ id: "a" }], fullOutputPath: "/tmp/x" }, usage: { input: 1 } },
			}),
		});
		expect(result.details).toMatchObject({ calls: [{ id: "a" }], fullOutputPath: "/tmp/x" });
		expect(result.usage).toEqual({ input: 1 });
	});

	it("throws codemode's error text on failure", async () => {
		await expect(
			runSnippet({
				snippet: snippet(),
				input: {},
				toolCallId: "call_1",
				signal: undefined,
				ctx: fakeCtx(),
				executor: fakeExecutor({ outcome: { isError: true, content: [{ type: "text", text: "Script error: boom" }] } }),
			}),
		).rejects.toThrow("Script error: boom");
	});

	it("caps nesting depth", async () => {
		await expect(
			runSnippet({
				snippet: snippet(),
				input: {},
				toolCallId: "a/1/2/3",
				signal: undefined,
				ctx: fakeCtx(),
				executor: fakeExecutor({}),
				maxNestingDepth: 3,
			}),
		).rejects.toThrow(/nesting depth/);
	});
});
