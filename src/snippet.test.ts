import { describe, expect, it } from "vitest";

import { buildSnippet, loadSnippets, snippetNameFromPath, type SnippetFs } from "./snippet.ts";
import type { SnippetDir } from "./types.ts";

function fakeFs(files: Record<string, Record<string, string>>): SnippetFs {
	return {
		async list(dir) {
			const entries = files[dir];
			if (!entries) {
				const error = new Error(`ENOENT: no such file or directory, scandir '${dir}'`) as Error & { code: string };
				error.code = "ENOENT";
				throw error;
			}
			return Object.keys(entries);
		},
		async read(path) {
			const dir = path.slice(0, path.lastIndexOf("/"));
			const name = path.slice(path.lastIndexOf("/") + 1);
			const content = files[dir]?.[name];
			if (content === undefined) throw new Error(`ENOENT: ${path}`);
			return content;
		},
	};
}

const USER: SnippetDir = { dir: "/user/snippets", scope: "user" };
const PROJECT: SnippetDir = { dir: "/proj/.pi/snippets", scope: "project" };
const SETTING_A: SnippetDir = { dir: "/setting/a", scope: "setting" };
const SETTING_B: SnippetDir = { dir: "/setting/b", scope: "setting" };

describe("snippetNameFromPath", () => {
	it("uses the filename stem", () => {
		expect(snippetNameFromPath("/x/list_open_prs.js")).toBe("list_open_prs");
	});
});

describe("buildSnippet", () => {
	it("defaults the name to the filename and the input to an object schema", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo."}\nreturn 1;',
			path: "/user/snippets/demo.js",
			scope: "user",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.snippet.name).toBe("demo");
		expect(result.snippet.input).toEqual({ type: "object", properties: {} });
		expect(result.snippet.enabled).toBe(true);
	});

	it("honors a pragma name override", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo.","name":"renamed"}\nreturn 1;',
			path: "/user/snippets/demo.js",
			scope: "user",
		});
		expect(result.ok && result.snippet.name).toBe("renamed");
	});

	it("rejects an invalid name", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo.","name":"has space"}\nreturn 1;',
			path: "/user/snippets/demo.js",
			scope: "user",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("snippet name");
	});

	it.each([
		"codemode",
		"CoDeMoDe",
		"tool_search",
		"Tool_Search",
		"mcp__github__search",
		"MCP__x__y",
		"list_mcp_resources",
		"read_mcp_resource",
	])(
		"rejects the reserved name %s",
		(name) => {
			const result = buildSnippet({
				source: `// @snippet: {"description":"Demo.","name":"${name}"}\nreturn 1;`,
				path: "/user/snippets/demo.js",
				scope: "user",
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.message).toContain("is reserved");
		},
	);

	it("rejects a reserved filename stem even without a pragma name", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo."}\nreturn 1;',
			path: "/user/snippets/codemode.js",
			scope: "user",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("is reserved");
	});

	it("rejects an empty body", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo."}\n',
			path: "/user/snippets/demo.js",
			scope: "user",
		});
		expect(result.ok).toBe(false);
	});

	it("accepts a leading body @options line", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo."}\n// @options: {"timeout_ms": 1000}\nreturn 1;',
			path: "/user/snippets/demo.js",
			scope: "user",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a stray body @options line (pi fails such a script before running)", () => {
		const result = buildSnippet({
			source: '// @snippet: {"description":"Demo."}\nconst a = 1;\n// @options: {"timeout_ms": 1000}\nreturn a;',
			path: "/user/snippets/demo.js",
			scope: "user",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("first line of the body");
	});
});

describe("loadSnippets", () => {
	it("loads .js snippets and ignores other files", async () => {
		const result = await loadSnippets(
			[USER],
			fakeFs({
				"/user/snippets": {
					"a.js": '// @snippet: {"description":"A."}\nreturn 1;',
					"notes.md": "# nope",
				},
			}),
		);
		expect(result.snippets.map((snippet) => snippet.name)).toEqual(["a"]);
		expect(result.issues).toEqual([]);
	});

	it("lets the project scope override the user scope", async () => {
		const result = await loadSnippets(
			[USER, PROJECT],
			fakeFs({
				"/user/snippets": { "a.js": '// @snippet: {"description":"user"}\nreturn 1;' },
				"/proj/.pi/snippets": { "a.js": '// @snippet: {"description":"project"}\nreturn 2;' },
			}),
		);
		expect(result.snippets).toHaveLength(1);
		expect(result.snippets[0]?.description).toBe("project");
		expect(result.shadowed).toEqual([
			{
				name: "a",
				path: "/proj/.pi/snippets/a.js",
				scope: "project",
				shadowedPath: "/user/snippets/a.js",
				shadowedScope: "user",
			},
		]);
	});

	it("lets a later setting directory override an earlier one", async () => {
		const result = await loadSnippets(
			[SETTING_A, SETTING_B],
			fakeFs({
				"/setting/a": { "a.js": '// @snippet: {"description":"a"}\nreturn 1;' },
				"/setting/b": { "a.js": '// @snippet: {"description":"b"}\nreturn 2;' },
			}),
		);
		expect(result.snippets[0]?.description).toBe("b");
	});

	it("records a bad file as an issue and keeps the good ones", async () => {
		const result = await loadSnippets(
			[USER],
			fakeFs({
				"/user/snippets": {
					"good.js": '// @snippet: {"description":"Good."}\nreturn 1;',
					"bad.js": "no pragma here",
				},
			}),
		);
		expect(result.snippets.map((snippet) => snippet.name)).toEqual(["good"]);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.path).toBe("/user/snippets/bad.js");
	});

	it("skips a missing directory", async () => {
		const result = await loadSnippets([USER], fakeFs({}));
		expect(result.snippets).toEqual([]);
		expect(result.issues).toEqual([]);
	});

	it("keeps disabled snippets in the result", async () => {
		const result = await loadSnippets(
			[USER],
			fakeFs({ "/user/snippets": { "a.js": '// @snippet: {"description":"A.","enabled":false}\nreturn 1;' } }),
		);
		expect(result.snippets[0]?.enabled).toBe(false);
	});
});
