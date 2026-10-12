import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CodemodeExecutor } from "./codemode.ts";
import { createCodemodeSnippetsExtension, registerSnippetTools, reportStatus, toStatus } from "./index.ts";
import type { Snippet, SnippetIssue, SnippetLoadResult } from "./types.ts";

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

describe("toStatus", () => {
	it("pairs the loaded snippets with the registration outcome", () => {
		const issues: SnippetIssue[] = [
			{ path: "/user/snippets/b.js", name: "b", message: 'tool name "b" is already registered' },
		];
		const status = toStatus(
			result([snippet({ name: "a" }), snippet({ name: "b" }), snippet({ name: "c" })]),
			issues,
			new Set(["a", "deleted"]),
		);
		expect(status.registered).toEqual(["a"]);
		expect(status.issues).toEqual(issues);
	});

	it("keeps load issues alongside registration issues", () => {
		const loaded: SnippetLoadResult = {
			snippets: [],
			issues: [{ path: "/bad.js", message: "boom" }],
			shadowed: [],
		};
		const status = toStatus(loaded, [{ path: "<codemode>", message: "no executor" }], new Set());
		expect(status.issues.map((issue) => issue.path)).toEqual(["/bad.js", "<codemode>"]);
	});
});

describe("reportStatus", () => {
	const status = () =>
		toStatus(
			result([snippet({ name: "ok" }), snippet({ name: "bash" })]),
			[{ path: "/user/snippets/bash.js", name: "bash", message: "already registered by another tool" }],
			new Set(["ok"]),
		);

	it("writes the footer status and stays quiet when everything is fine", () => {
		const setStatus = vi.fn();
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { setStatus, notify } } as unknown as ExtensionContext;
		reportStatus(ctx, toStatus(result([snippet()]), [], new Set(["demo"])));
		expect(setStatus).toHaveBeenCalledWith("snippets", "snippets: 1/1 registered");
		expect(notify).not.toHaveBeenCalled();
	});

	it("warns with counts, the first reason, and a pointer to /snippet list", () => {
		const setStatus = vi.fn();
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { setStatus, notify } } as unknown as ExtensionContext;
		reportStatus(ctx, status());
		expect(notify).toHaveBeenCalledTimes(1);
		const [message, type] = notify.mock.calls[0] as [string, string];
		expect(type).toBe("warning");
		expect(message).toContain("1 of 2 snippets not registered");
		expect(message).toContain("already registered by another tool");
		expect(message).toContain("Run /snippet list");
	});

	it("falls back to console.warn without a UI", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		reportStatus({ hasUI: false } as unknown as ExtensionContext, status());
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("1 of 2 snippets not registered");
		warn.mockRestore();
	});
});
