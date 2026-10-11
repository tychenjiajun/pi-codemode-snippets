import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { captureCodemodeExecutor } from "./codemode.ts";

function fakePi(registered: ToolDefinition[]): ExtensionAPI {
	return {
		registerTool: (tool: ToolDefinition) => registered.push(tool),
		appendEntry: () => {},
		getAllTools: () => [],
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;
}

describe("captureCodemodeExecutor", () => {
	it("captures the built-in codemode executor without registering a tool", () => {
		const registered: ToolDefinition[] = [];
		const executor = captureCodemodeExecutor(fakePi(registered));
		expect(executor).toBeDefined();
		expect(typeof executor?.execute).toBe("function");
		// The facade swallows the registration, so the model's tool set is unchanged.
		expect(registered).toEqual([]);
	});
});
