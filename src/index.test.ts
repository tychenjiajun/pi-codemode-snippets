import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CodemodeExecutor } from "./codemode.ts";
import { createCodemodeSnippetsExtension, registerSnippetTools } from "./index.ts";
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

function result(snippets: Snippet[]): SnippetLoadResult {
	return { snippets, issues: [], shadowed: [] };
}

function fakePi(existing: string[]): { pi: ExtensionAPI; registered: ToolDefinition[] } {
	const registered: ToolDefinition[] = [];
	const pi = {
		getAllTools: () => existing.map((name) => ({ name })),
		registerTool: (tool: ToolDefinition) => registered.push(tool),
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

const EXECUTOR: CodemodeExecutor = {
	async execute() {
		return { content: [], details: {} };
	},
};

describe("createCodemodeSnippetsExtension", () => {
	it("returns a factory", () => {
		expect(typeof createCodemodeSnippetsExtension()).toBe("function");
	});
});

describe("registerSnippetTools", () => {
	it("registers enabled snippets and skips disabled ones", () => {
		const { pi, registered } = fakePi([]);
		const issues = registerSnippetTools(
			pi,
			result([snippet({ name: "a" }), snippet({ name: "b", enabled: false })]),
			new Set(),
			10,
			EXECUTOR,
		);
		expect(issues).toEqual([]);
		expect(registered.map((tool) => tool.name)).toEqual(["a"]);
	});

	it("skips a name already registered by another tool", () => {
		const { pi, registered } = fakePi(["bash"]);
		const issues = registerSnippetTools(pi, result([snippet({ name: "bash" })]), new Set(), 10, EXECUTOR);
		expect(registered).toEqual([]);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toContain("already registered");
	});

	it("re-registers its own names on a later session start", () => {
		const { pi, registered } = fakePi(["demo"]);
		const registeredNames = new Set(["demo"]);
		const issues = registerSnippetTools(pi, result([snippet()]), registeredNames, 10, EXECUTOR);
		expect(issues).toEqual([]);
		expect(registered.map((tool) => tool.name)).toEqual(["demo"]);
	});

	it("reports a missing executor instead of registering", () => {
		const { pi, registered } = fakePi([]);
		const issues = registerSnippetTools(pi, result([snippet()]), new Set(), 10, undefined);
		expect(registered).toEqual([]);
		expect(issues[0]?.message).toContain("codemode executor");
	});
});
