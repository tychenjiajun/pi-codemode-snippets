// ---------------------------------------------------------------------------
// Capturing the built-in codemode executor
// ---------------------------------------------------------------------------
//
// A snippet runs a codemode script. The obvious way to do that is
// `ctx.executeTool("codemode", { code })`, but the built-in `codemode` tool has
// `exposure: "model-only"` on purpose ("scripts must not start other scripts"),
// so it is never callable through `executeTool`.
//
// Instead, we capture the tool definition that `createCodemodeExtension()`
// registers — through a small `pi` facade, the same pattern pi-codemode-guard
// uses — and call its `execute()` directly. Nothing is registered, so the model
// still sees exactly one `codemode` tool and scripts still cannot start
// scripts; snippet bodies run through the identical sandbox implementation.

import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** The codemode executor, narrowed to what a snippet needs. */
export interface CodemodeExecutor {
	execute(
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<unknown>>;
}

export const CODEMODE_TOOL_NAME = "codemode";

/**
 * Capture the executor of the tool `createCodemodeExtension()` registers,
 * without registering it. Returns `undefined` only if the built-in extension
 * stops registering a tool named `codemode`.
 */
export function captureCodemodeExecutor(pi: ExtensionAPI): CodemodeExecutor | undefined {
	let captured: ToolDefinition | undefined;

	const facade = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolDefinition) => {
					if (tool.name === CODEMODE_TOOL_NAME) captured = tool;
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	}) as ExtensionAPI;

	createCodemodeExtension()(facade);
	if (!captured) return undefined;

	const definition = captured as ToolDefinition;
	const execute = definition.execute.bind(definition) as CodemodeExecutor["execute"];
	return { execute };
}
