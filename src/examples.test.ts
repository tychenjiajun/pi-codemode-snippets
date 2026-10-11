import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadSnippets } from "./snippet.ts";

const EXAMPLES_DIR = fileURLToPath(new URL("../examples/snippets", import.meta.url));

describe("examples/snippets", () => {
	it("loads every shipped example without problems", async () => {
		const result = await loadSnippets([{ dir: EXAMPLES_DIR, scope: "user" }]);
		expect(result.issues).toEqual([]);
		expect(result.snippets.map((snippet) => snippet.name).sort()).toEqual([
			"draft_ping",
			"list_open_prs",
			"repo_stats",
			"summarize_changes",
		]);
		expect(result.snippets.find((snippet) => snippet.name === "draft_ping")?.enabled).toBe(false);
		expect(result.snippets.find((snippet) => snippet.name === "list_open_prs")?.timeoutMs).toBe(30000);
	});
});
