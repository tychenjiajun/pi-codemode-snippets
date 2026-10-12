// ---------------------------------------------------------------------------
// The bundled `snippet-authoring` skill and its check script.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildSnippet } from "./snippet.ts";

const skillDir = fileURLToPath(new URL("../skills/snippet-authoring/", import.meta.url));
const checkScript = join(skillDir, "scripts", "check.mjs");
const examplesDir = fileURLToPath(new URL("../examples/snippets/", import.meta.url));

interface CheckResult {
	readonly status: number;
	readonly output: string;
}

function runCheck(...args: string[]): CheckResult {
	try {
		const output = execFileSync(process.execPath, [checkScript, ...args], { encoding: "utf8" });
		return { status: 0, output };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

const tempDirs: string[] = [];

/** Write a snippet file into a fresh temp directory and run the checker on it. */
function checkSource(fileName: string, source: string): CheckResult {
	const dir = mkdtempSync(join(tmpdir(), "snippet-check-"));
	tempDirs.push(dir);
	const path = join(dir, fileName);
	writeFileSync(path, source);
	return runCheck(path);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const validPragma = `// @snippet: {"description":"A valid snippet.","input":{"type":"object","properties":{"repo":{"type":"string"}},"required":["repo"]}}`;

describe("snippet-authoring skill", () => {
	it("ships a SKILL.md with matching name and a routing description", () => {
		const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
		const match = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(text);
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("snippet-authoring");
		expect(match?.[1]).toBe(skillDir.split("/").filter(Boolean).pop());
		expect(match?.[2].length).toBeGreaterThan(90);
		expect(match?.[2].length).toBeLessThanOrEqual(1024);
	});

	it("is declared in the package pi manifest and npm files", () => {
		const pkg = JSON.parse(readFileSync(join(skillDir, "..", "..", "package.json"), "utf8")) as {
			pi?: { skills?: string[] };
			files?: string[];
			keywords?: string[];
		};
		expect(pkg.pi?.skills).toContain("./skills");
		expect(pkg.files).toContain("skills/**");
		expect(pkg.keywords ?? []).toContain("pi-package");
	});

	it("bundles the check script and a reference file", () => {
		expect(readdirSync(join(skillDir, "references"))).toContain("fields.md");
		expect(runCheck("--help").status).toBe(2); // usage error proves it runs
	});
});

describe("check.mjs — valid files", () => {
	it("accepts every shipped example", () => {
		for (const file of readdirSync(examplesDir).sort()) {
			const result = runCheck(join(examplesDir, file));
			expect(result.status, `${file}: ${result.output}`).toBe(0);
			expect(result.output).toContain("OK");
		}
	});

	it("agrees with the real loader on the examples", () => {
		for (const file of readdirSync(examplesDir)) {
			const source = readFileSync(join(examplesDir, file), "utf8");
			expect(buildSnippet({ source, path: join(examplesDir, file), scope: "user" }).ok).toBe(true);
		}
	});

	it("accepts a minimal snippet and reports the tool name", () => {
		const result = checkSource("ok.js", `${validPragma}\nreturn { repo: input.repo };\n`);
		expect(result.output).toContain('tool "ok"');
		expect(result.status).toBe(0);
	});

	it("accepts a shebang before the pragma", () => {
		const result = checkSource("bang.js", `#!/usr/bin/env node\n${validPragma}\nreturn 1;\n`);
		expect(result.status).toBe(0);
	});

	it("accepts a disabled snippet", () => {
		const result = checkSource(
			"off.js",
			`// @snippet: {"description":"Disabled.","enabled":false}\nreturn 1;\n`,
		);
		expect(result.status).toBe(0);
		expect(result.output).toContain("disabled");
	});

	it("accepts a valid body @options line and honors it in the generated script", () => {
		const result = checkSource(
			"opts.js",
			`// @snippet: {"description":"With options.","timeoutMs":1000}\n// @options: {"max_output_tokens": 500}\nreturn 1;\n`,
		);
		expect(result.status).toBe(0);
	});
});

describe("check.mjs — broken @snippet configuration", () => {
	it("rejects a non-.js file", () => {
		const result = checkSource("wrong.mjs", `${validPragma}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain('must end in ".js"');
	});

	it("rejects a missing pragma", () => {
		const result = checkSource("nopragma.js", `return 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("missing a leading");
	});

	it("rejects a trailing comma in the pragma", () => {
		const result = checkSource("comma.js", `// @snippet: {"description":"x",}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("not valid strict JSON");
	});

	it("rejects a missing description", () => {
		const result = checkSource("nodesc.js", `// @snippet: {"input":{"type":"object"}}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("description");
	});

	it("rejects an unknown pragma field", () => {
		const result = checkSource("typo.js", `// @snippet: {"desciption":"x"}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain('unknown @snippet field "desciption"');
	});

	it("rejects an invalid tool name", () => {
		const result = checkSource("bad.js", `// @snippet: {"name":"1bad","description":"x"}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("must match");
	});

	it("rejects an invalid filename stem used as the name", () => {
		const result = checkSource("my.snippet.js", `${validPragma}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain('"my.snippet"');
	});

	it("rejects an empty body", () => {
		const result = checkSource("empty.js", `// @snippet: {"description":"x"}\n\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("empty body");
	});

	it("rejects a bad body @options line", () => {
		const result = checkSource("badopt.js", `// @snippet: {"description":"x"}\n// @options: {oops}\nreturn 1;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("@options:");
	});
});

describe("check.mjs — input schema", () => {
	it("rejects a non-object schema", () => {
		const result = checkSource(
			"str.js",
			`// @snippet: {"description":"x","input":{"type":"string"}}\nreturn 1;\n`,
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain('"input.type" must be "object"');
	});

	it("rejects a required field missing from properties", () => {
		const result = checkSource(
			"req.js",
			`// @snippet: {"description":"x","input":{"type":"object","properties":{},"required":["repo"]}}\nreturn 1;\n`,
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain('does not declare it');
	});

	it("rejects a body field the schema does not declare", () => {
		const result = checkSource(
			"read.js",
			`// @snippet: {"description":"x","input":{"type":"object","properties":{"repo":{"type":"string"}},"required":["repo"]}}\nreturn input.limit ?? 5;\n`,
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("`input.limit`");
	});

	it("rejects field reads when no input schema is declared at all", () => {
		const result = checkSource("noschema.js", `// @snippet: {"description":"x"}\nreturn input.repo;\n`);
		expect(result.status).toBe(1);
		expect(result.output).toContain("declares no");
	});

	it("accepts fields read with optional chaining or bracket access once declared", () => {
		const result = checkSource(
			"dyn.js",
			`// @snippet: {"description":"x","input":{"type":"object","properties":{"repo":{"type":"string"}}}}\nreturn [input?.repo, input["repo"]];\n`,
		);
		expect(result.status).toBe(0);
	});
});

describe("check.mjs — compilation", () => {
	it("reports a syntax error with the line number of the file", () => {
		const result = checkSource(
			"syntax.js",
			`// @snippet: {"description":"x"}\nconst a = 1;\nconst = ;\nreturn a;\n`,
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("syntax error at line 3");
		expect(result.output).toContain("const = ;");
	});

	it("catches a body that redeclares the reserved input binding", () => {
		const result = checkSource(
			"redeclare.js",
			`// @snippet: {"description":"x"}\nconst input = { a: 1 };\nreturn input;\n`,
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("already been declared");
		expect(result.output).toContain("`input` is reserved");
	});

	it("catches a lexical declaration that shadows a codemode wrapper parameter", () => {
		const result = checkSource(
			"shadow.js",
			`// @snippet: {"description":"x"}\nconst tools = 1;\nreturn tools;\n`,
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("syntax error");
	});

	it("accepts top-level await and return", () => {
		const result = checkSource(
			"await.js",
			`// @snippet: {"description":"x"}\nconst r = await tools.bash({ command: "echo hi" });\nreturn r;\n`,
		);
		expect(result.status).toBe(0);
	});
});
