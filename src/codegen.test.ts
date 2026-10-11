import { describe, expect, it } from "vitest";

import { buildSnippetCode, jsonLiteral, snippetOptions } from "./codegen.ts";
import type { Snippet } from "./types.ts";

function snippet(overrides: Partial<Snippet> = {}): Snippet {
	return {
		name: "demo",
		label: "demo",
		description: "Demo.",
		input: { type: "object", properties: {} },
		body: "return input;",
		path: "/tmp/demo.js",
		scope: "user",
		enabled: true,
		...overrides,
	};
}

describe("snippetOptions", () => {
	it("maps pragma limits to codemode option keys", () => {
		expect(snippetOptions({ timeoutMs: 1000, maxOutputTokens: 2000 })).toEqual({
			timeout_ms: 1000,
			max_output_tokens: 2000,
		});
	});

	it("is empty without limits", () => {
		expect(snippetOptions({})).toEqual({});
	});
});

describe("jsonLiteral", () => {
	it("serializes undefined as an empty object", () => {
		expect(jsonLiteral(undefined)).toBe("{}");
	});

	it("escapes line separators and closing script tags", () => {
		expect(jsonLiteral("a\u2028b\u2029c</script>")).toBe('"a\\u2028b\\u2029c<\\/script>"');
	});
});

describe("buildSnippetCode", () => {
	it("binds input and keeps the body", () => {
		expect(buildSnippetCode(snippet({ body: "return input.x;" }), { x: 1 })).toBe(
			'const input = {"x":1};\nreturn input.x;',
		);
	});

	it("emits pragma options", () => {
		expect(buildSnippetCode(snippet({ body: "return 1;", timeoutMs: 500 }), {})).toBe(
			'// @options: {"timeout_ms":500}\nconst input = {};\nreturn 1;',
		);
	});

	it("lets the body's @options win over the pragma", () => {
		const code = buildSnippetCode(
			snippet({ body: '// @options: {"timeout_ms": 2000}\nreturn 1;', timeoutMs: 1000 }),
			{},
		);
		expect(code).toBe('// @options: {"timeout_ms":2000}\nconst input = {};\nreturn 1;');
	});

	it("merges distinct options", () => {
		const code = buildSnippetCode(
			snippet({ body: '// @options: {"max_output_tokens": 10}\nreturn 1;', timeoutMs: 1000 }),
			{},
		);
		expect(code.startsWith('// @options: {"timeout_ms":1000,"max_output_tokens":10}')).toBe(true);
	});

	it("treats missing input as an empty object", () => {
		expect(buildSnippetCode(snippet({ body: "return 1;" }), undefined)).toBe(
			"const input = {};\nreturn 1;",
		);
	});
});
