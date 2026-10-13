import { describe, expect, it } from "vitest";

import {
	bodyOptionsProblem,
	extractJsonObject,
	extractLeadingComment,
	parseSnippetSource,
	splitBodyOptions,
	validatePragma,
} from "./pragma.ts";

describe("extractJsonObject", () => {
	it("returns the first balanced object", () => {
		expect(extractJsonObject(' @snippet: {"a":{"b":1}} trailing')).toBe('{"a":{"b":1}}');
	});

	it("ignores braces inside strings", () => {
		expect(extractJsonObject('{"text":"a } b","n":1}')).toBe('{"text":"a } b","n":1}');
	});

	it("returns undefined when unbalanced", () => {
		expect(extractJsonObject('{"a":1')).toBeUndefined();
		expect(extractJsonObject("no object here")).toBeUndefined();
	});
});

describe("extractLeadingComment", () => {
	it("reads a single line comment", () => {
		const comment = extractLeadingComment('// @snippet: {"description":"x"}\nconst a = 1;');
		expect(comment?.text).toContain("@snippet:");
		expect(comment?.end).toBe('// @snippet: {"description":"x"}\n'.length);
	});

	it("reads a multi-line run of // comments", () => {
		const source = '// @snippet: {\n//   "description": "x"\n// }\ncode();';
		const comment = extractLeadingComment(source);
		expect(comment?.text).toBe(' @snippet: {\n   "description": "x"\n }');
	});

	it("reads a block comment", () => {
		const comment = extractLeadingComment('/* @snippet: {"description":"x"} */\ncode();');
		expect(comment?.text).toBe(' @snippet: {"description":"x"} ');
	});

	it("returns undefined when the file does not start with a comment", () => {
		expect(extractLeadingComment("const a = 1;")).toBeUndefined();
	});
});

describe("parseSnippetSource", () => {
	it("parses a line pragma and returns the body", () => {
		const result = parseSnippetSource('// @snippet: {"description":"List PRs."}\nreturn input;\n');
		expect(result).toEqual({
			ok: true,
			pragma: { description: "List PRs." },
			body: "return input;\n",
		});
	});

	it("parses a multi-line // pragma", () => {
		const source = [
			"// @snippet: {",
			'//   "description": "List PRs.",',
			'//   "name": "list_prs"',
			"// }",
			"const x = input.repo;",
			"return x;",
		].join("\n");
		const result = parseSnippetSource(source);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pragma.name).toBe("list_prs");
		expect(result.body).toContain("const x = input.repo;");
	});

	it("parses a block pragma", () => {
		const result = parseSnippetSource('/* @snippet: {"description":"Block."} */\nreturn 1;');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pragma.description).toBe("Block.");
		expect(result.body).toBe("return 1;");
	});

	it("keeps an @options line after the pragma in the body", () => {
		const source = '// @snippet: {"description":"x"}\n// @options: {"timeout_ms": 1000}\nreturn 1;';
		const result = parseSnippetSource(source);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body).toBe('// @options: {"timeout_ms": 1000}\nreturn 1;');
	});

	it("reports a missing pragma", () => {
		const result = parseSnippetSource("return 1;");
		expect(result).toEqual({ ok: false, message: expect.stringContaining("missing") });
	});

	it("reports invalid JSON", () => {
		const result = parseSnippetSource("// @snippet: {description: 'x'}\nreturn 1;");
		expect(result.ok).toBe(false);
	});

	it("reports a missing description", () => {
		const result = parseSnippetSource('// @snippet: {"name":"x"}\nreturn 1;');
		expect(result).toEqual({ ok: false, message: expect.stringContaining("description") });
	});
});

describe("validatePragma", () => {
	it("accepts the full field set", () => {
		const result = validatePragma({
			name: "x",
			label: "X",
			description: "x",
			enabled: false,
			input: { type: "object" },
			timeoutMs: 1000,
			maxOutputTokens: 2000,
			annotations: { readOnlyHint: true },
			promptGuidelines: ["a", "b"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pragma).toMatchObject({ name: "x", enabled: false, timeoutMs: 1000, maxOutputTokens: 2000 });
	});

	it("rejects a non-object input", () => {
		expect(validatePragma({ description: "x", input: [] })).toEqual({
			ok: false,
			message: expect.stringContaining("input"),
		});
	});

	it("rejects a non-positive timeout", () => {
		expect(validatePragma({ description: "x", timeoutMs: 0 }).ok).toBe(false);
	});

	it("rejects a non-integer limit", () => {
		expect(validatePragma({ description: "x", timeoutMs: 1000.5 }).ok).toBe(false);
		expect(validatePragma({ description: "x", maxOutputTokens: 1.5 }).ok).toBe(false);
	});

	it("rejects a timeout beyond pi's 2147483647 ms limit", () => {
		expect(validatePragma({ description: "x", timeoutMs: 2147483648 }).ok).toBe(false);
	});

	it("rejects non-boolean annotations", () => {
		expect(validatePragma({ description: "x", annotations: { readOnlyHint: "yes" } }).ok).toBe(false);
	});

	it("rejects an invalid promptGuidelines value", () => {
		expect(validatePragma({ description: "x", promptGuidelines: ["ok", 2] }).ok).toBe(false);
	});
});

describe("splitBodyOptions", () => {
	it("extracts a line options comment", () => {
		expect(splitBodyOptions('// @options: {"timeout_ms": 1000}\nreturn 1;')).toEqual({
			options: { timeout_ms: 1000 },
			body: "return 1;",
		});
	});

	it("extracts a block options comment", () => {
		expect(splitBodyOptions('/* @options: {"max_output_tokens": 50} */\nreturn 1;')).toEqual({
			options: { max_output_tokens: 50 },
			body: "return 1;",
		});
	});

	it("handles nested objects", () => {
		const result = splitBodyOptions('// @options: {"a": {"b": 1}}\ncode();');
		expect(result.options).toEqual({ a: { b: 1 } });
		expect(result.body).toBe("code();");
	});

	it("leaves a malformed options comment in place", () => {
		const body = "// @options: not json\ncode();";
		expect(splitBodyOptions(body)).toEqual({ body });
	});

	it("returns the body unchanged without options", () => {
		expect(splitBodyOptions("return 1;")).toEqual({ body: "return 1;" });
	});
});

describe("bodyOptionsProblem", () => {
	it("accepts a body without options", () => {
		expect(bodyOptionsProblem("return 1;")).toBeUndefined();
	});

	it("accepts a valid leading line options comment (it is extracted)", () => {
		expect(bodyOptionsProblem('// @options: {"timeout_ms": 1000}\nreturn 1;')).toBeUndefined();
	});

	it("accepts a valid leading block options comment", () => {
		expect(bodyOptionsProblem('/* @options: {"timeout_ms": 1000} */\nreturn 1;')).toBeUndefined();
	});

	it("rejects a malformed leading options comment", () => {
		const problem = bodyOptionsProblem("// @options: not json\ncode();");
		expect(problem).toContain("not a valid JSON object");
	});

	it("rejects a stray options line after the first line", () => {
		const problem = bodyOptionsProblem('code();\n// @options: {"timeout_ms": 1000}\nmore();');
		expect(problem).toContain("body line 2");
		expect(problem).toContain("first line of the body");
	});

	it("rejects a duplicate options line after an extracted leading one", () => {
		const problem = bodyOptionsProblem('// @options: {"timeout_ms": 1000}\ncode();\n// @options: {"max_output_tokens": 5}');
		expect(problem).toContain("body line 3");
	});

	it("ignores an options-looking line inside a later comment that does not match the prefix", () => {
		expect(bodyOptionsProblem("code();\n// see @options docs\nmore();")).toBeUndefined();
	});

	it("rejects an unknown @options field", () => {
		const problem = bodyOptionsProblem('// @options: {"max_lines": 100}\ncode();');
		expect(problem).toContain("only supports");
		expect(problem).toContain("max_lines");
	});

	it("rejects a non-integer @options value", () => {
		const problem = bodyOptionsProblem('// @options: {"timeout_ms": 1.5}\ncode();');
		expect(problem).toContain("integer");
	});

	it("rejects a timeout_ms beyond pi's 2147483647 limit", () => {
		const problem = bodyOptionsProblem('// @options: {"timeout_ms": 2147483648}\ncode();');
		expect(problem).toContain("2147483647");
	});

	it("checks the fields of a leading block options comment", () => {
		const problem = bodyOptionsProblem('/* @options: {"nope": 1} */\ncode();');
		expect(problem).toContain("only supports");
	});
});
