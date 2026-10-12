#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check.mjs — offline verification for pi-codemode-snippets files.
//
// Usage:  node check.mjs <file.js | directory> [...]
//
// Checks, in order, everything the extension checks at load time plus a
// compilation of the body:
//
//   1. file name ends in `.js` (the extension only scans `*.js`);
//   2. the leading `// @snippet: {…}` pragma parses as strict JSON;
//   3. every pragma field has the right shape (see src/pragma.ts);
//   4. the resolved tool name matches `[A-Za-z_][A-Za-z0-9_-]{0,63}` and is
//      not reserved (`codemode`, `mcp__…` — see reservedNameProblem below);
//   5. the body is non-empty and its leading `@options:` line (if any) is valid;
//   6. the `input` JSON Schema is an object schema that declares every field
//      the body actually reads (there is no coercion or default-filling);
//   7. the body compiles exactly as codemode compiles it — wrapped in
//      `(async (tools, console) => { … })`, sloppy mode, see pi-codemode's
//      worker (`vm.evalCode('(async (tools, console) => {' + code + '})')`);
//   8. the body compiles together with the injected `const input = …` line, so
//      redeclaring the reserved `input` binding is caught.
//
// Dependency-free on purpose: pi installs packages under
// `~/.pi/agent/npm/node_modules/`, where Node refuses TypeScript type
// stripping, so this script cannot import the extension's TS sources when
// installed. src/skill.test.ts keeps it in lockstep with the real loader.
//
// Exit codes: 0 = every file OK, 1 = at least one problem, 2 = usage error.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const PRAGMA_TAG = "@snippet:";
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

// Mirrors reservedNameProblem() in src/snippet.ts; src/skill.test.ts keeps the two in lockstep.
function reservedNameProblem(name) {
	const lower = name.toLowerCase();
	if (lower === "codemode") {
		return (
			`snippet name "${name}" is reserved: it would shadow the built-in codemode tool ` +
			"that runs snippet bodies — rename the file or set another `name`"
		);
	}
	if (lower.startsWith("mcp__")) {
		return (
			`snippet name "${name}" is reserved: names starting with "mcp__" belong to MCP tools, ` +
			"which register after snippets load — the collision would be silent"
		);
	}
	return undefined;
}
const PRAGMA_KEYS = [
	"name",
	"description",
	"input",
	"label",
	"enabled",
	"timeoutMs",
	"maxOutputTokens",
	"annotations",
	"promptGuidelines",
];
const ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

// --- pragma extraction (mirrors src/pragma.ts) ------------------------------

/** Extract the first balanced `{ … }` object, ignoring braces inside strings. */
function extractJsonObject(text) {
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

/** The leading `//`/`/* *\/` comment block, skipping BOM and shebang. */
function extractLeadingComment(source) {
	let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
	if (source.startsWith("#!", cursor)) {
		const newline = source.indexOf("\n", cursor);
		cursor = newline === -1 ? source.length : newline + 1;
	}
	while (cursor < source.length && /[ \t\r\n]/.test(source[cursor] ?? "")) cursor += 1;

	if (source.startsWith("/*", cursor)) {
		const end = source.indexOf("*/", cursor + 2);
		if (end === -1) return undefined;
		return { text: source.slice(cursor + 2, end), end: end + 2 };
	}
	if (source.startsWith("//", cursor)) {
		const parts = [];
		while (cursor < source.length) {
			const lineEnd = source.indexOf("\n", cursor);
			const stop = lineEnd === -1 ? source.length : lineEnd;
			const line = source.slice(cursor, stop);
			const match = /^[ \t]*\/\/(.*)$/.exec(line);
			if (!match) break;
			// A following `@options:` line belongs to the body, not the pragma.
			if (parts.length > 0 && /^[ \t]*\/\/[ \t]*@options:/.test(line)) break;
			parts.push(match[1] ?? "");
			cursor = stop + 1;
		}
		return { text: parts.join("\n"), end: cursor };
	}
	return undefined;
}

/** Pull a leading `// @options: {…}` or `/* @options: … *\/` comment out of `body`. */
function splitBodyOptions(body) {
	const lead = /^[ \t\r\n]*/.exec(body)?.[0] ?? "";
	const rest = body.slice(lead.length);
	let comment;
	let consumed = 0;
	if (rest.startsWith("//")) {
		const newline = rest.indexOf("\n");
		const line = newline === -1 ? rest : rest.slice(0, newline);
		const match = /^\/\/[ \t]*@options:[ \t]*(.*)$/.exec(line);
		if (match) {
			comment = match[1] ?? "";
			consumed = newline === -1 ? rest.length : newline + 1;
		}
	} else if (rest.startsWith("/*")) {
		const end = rest.indexOf("*/");
		if (end !== -1) {
			const match = /^[ \t]*@options:[ \t]*([\s\S]*)$/.exec(rest.slice(2, end));
			if (match) {
				comment = match[1] ?? "";
				consumed = end + 2;
				if (rest[consumed] === "\n") consumed += 1;
			}
		}
	}
	if (comment === undefined) return { body };
	return { optionsText: comment, body: (lead + rest.slice(consumed)).replace(/^[ \t]*\r?\n/, "") };
}

// --- pragma validation (mirrors src/pragma.ts, collecting every problem) ----

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePragma(raw, problems) {
	if (!isPlainObject(raw)) {
		problems.push("the @snippet pragma must be a JSON object");
		return false;
	}

	for (const key of Object.keys(raw)) {
		if (!PRAGMA_KEYS.includes(key)) {
			problems.push(
				`unknown @snippet field "${key}" — allowed fields: ${PRAGMA_KEYS.join(", ")}`,
			);
		}
	}

	const description = raw.description;
	if (typeof description !== "string" || description.trim() === "") {
		problems.push('the pragma needs a non-empty "description" (the model-facing summary of the tool)');
	}

	for (const key of ["name", "label"]) {
		const value = raw[key];
		if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
			problems.push(`"${key}" must be a non-empty string`);
		}
	}

	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		problems.push('"enabled" must be a boolean');
	}

	for (const key of ["timeoutMs", "maxOutputTokens"]) {
		const value = raw[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
			problems.push(`"${key}" must be a positive number`);
		}
	}

	if (raw.input !== undefined && !isPlainObject(raw.input)) {
		problems.push('"input" must be a JSON Schema object');
	}

	if (raw.annotations !== undefined) {
		if (!isPlainObject(raw.annotations)) {
			problems.push('"annotations" must be a JSON object');
		} else {
			for (const [key, value] of Object.entries(raw.annotations)) {
				if (!ANNOTATION_KEYS.includes(key)) {
					problems.push(`unknown annotation "${key}" — allowed: ${ANNOTATION_KEYS.join(", ")}`);
				} else if (typeof value !== "boolean") {
					problems.push(`"annotations.${key}" must be a boolean`);
				}
			}
		}
	}

	if (raw.promptGuidelines !== undefined) {
		const ok =
			Array.isArray(raw.promptGuidelines) &&
			raw.promptGuidelines.every((entry) => typeof entry === "string" && entry.trim() !== "");
		if (!ok) problems.push('"promptGuidelines" must be an array of non-empty strings');
	}

	return true;
}

// --- input schema (the deeper check the loader does not do) -----------------

/** Every input field the body reads literally: `input.x`, `input?.x`, `input["x"]`. */
function readInputFields(body) {
	const fields = new Set();
	for (const match of body.matchAll(/\binput\s*(?:\??\.)\s*([A-Za-z_$][\w$]*)/g)) {
		fields.add(match[1]);
	}
	for (const match of body.matchAll(/\binput\s*\??\[\s*(['"])([^'"\]]+)\1\s*\]/g)) {
		fields.add(match[2]);
	}
	return [...fields];
}

function checkInput(raw, body, problems) {
	const reads = readInputFields(body);
	if (raw === undefined) {
		if (reads.length > 0) {
			problems.push(
				`the body reads ${reads.map((field) => `\`input.${field}\``).join(", ")} ` +
					'but the pragma declares no "input" schema — add them to `input.properties`',
			);
		}
		return;
	}
	if (!isPlainObject(raw)) return; // shape problem already reported

	const type = raw.type;
	if (
		type !== undefined &&
		!(type === "object" || (Array.isArray(type) && type.length === 1 && type[0] === "object"))
	) {
		problems.push(
			`"input.type" must be "object" — a snippet always receives a single object; got ${JSON.stringify(type)}`,
		);
	}

	let properties = raw.properties;
	if (properties !== undefined) {
		if (!isPlainObject(properties)) {
			problems.push('"input.properties" must be an object mapping field names to JSON Schemas');
			properties = undefined;
		} else {
			for (const [key, value] of Object.entries(properties)) {
				if (!isPlainObject(value)) {
					problems.push(`"input.properties.${key}" must be a JSON Schema object`);
				}
			}
		}
	}

	if (raw.required !== undefined) {
		if (!Array.isArray(raw.required) || raw.required.some((entry) => typeof entry !== "string" || entry === "")) {
			problems.push('"input.required" must be an array of non-empty strings');
		} else {
			for (const entry of raw.required) {
				if (properties === undefined) {
					problems.push(`"input.required" lists "${entry}" but the schema declares no "input.properties"`);
				} else if (!(entry in properties)) {
					problems.push(`"input.required" lists "${entry}" but "input.properties" does not declare it`);
				}
			}
		}
	}

	const declared = new Set(properties === undefined ? [] : Object.keys(properties));
	for (const field of reads) {
		if (declared.has(field)) continue;
		problems.push(
			properties === undefined
				? `the body reads \`input.${field}\` but the schema declares no "input.properties"`
				: `the body reads \`input.${field}\` but "input.properties" does not declare "${field}" — ` +
					"declare it (leave it out of `required` if callers may omit it, and apply its default in the body)",
		);
	}
}

// --- compilation ------------------------------------------------------------

const WRAPPER_PREFIX = "(async (tools, console) => {\n";

/** Compile `source` the way codemode does. Returns the SyntaxError, or null. */
function compile(source, filename) {
	try {
		// pi-codemode's worker: vm.evalCode(`(async (tools, console) => {${code}\n})`, "codemode.js")
		new vm.Script(WRAPPER_PREFIX + source + "\n})", { filename });
		return null;
	} catch (error) {
		return error;
	}
}

/**
 * Turn a V8 SyntaxError (which carries `file:line`, excerpt, and caret in its
 * stack) into a problem, remapping the wrapper line and pointing at the file.
 */
function syntaxProblem(error, lineOffset) {
	const stackLines = (error.stack ?? "").split("\n");
	let fileLine;
	let excerpt;
	let caret;
	for (let index = 0; index < stackLines.length; index += 1) {
		const match = /^([^\s].*):(\d+)$/.exec(stackLines[index] ?? "");
		if (match) {
			fileLine = Number(match[2]) - lineOffset;
			excerpt = stackLines[index + 1];
			caret = stackLines[index + 2];
			break;
		}
	}
	const where = fileLine !== undefined && fileLine > 0 ? ` at line ${fileLine}` : "";
	const lines = [`syntax error${where}: ${error.message}`];
	if (fileLine !== undefined && fileLine > 0 && typeof excerpt === "string" && excerpt !== "") {
		const number = String(fileLine);
		lines.push(`      ${number} | ${excerpt}`);
		if (typeof caret === "string" && /^\s*\^/.test(caret)) {
			lines.push(`      ${" ".repeat(number.length)} | ${caret}`);
		}
	}
	return lines;
}

// --- one file ---------------------------------------------------------------

/** Validate one snippet file. Returns `{ problems, tool, disabled }`. */
export function checkSnippetFile(path) {
	const problems = [];
	let tool;
	let disabled = false;

	if (!/\.js$/i.test(path)) {
		problems.push('the file name must end in ".js" — the extension only scans `*.js` files');
	}

	let source;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		return { problems: [`cannot read the file: ${error.message}`] };
	}
	source = source.replace(/^\uFEFF/, "");

	// The loader allows a shebang before the pragma; comment it out in place so
	// compile diagnostics keep the original line numbers.
	const newlineIndex = source.indexOf("\n");
	const compileSource = source.startsWith("#!")
		? "//" + source.slice(2, newlineIndex === -1 ? source.length : newlineIndex) +
			(newlineIndex === -1 ? "" : source.slice(newlineIndex))
		: source;

	const stem = basename(path).replace(/\.js$/i, "");

	const comment = extractLeadingComment(compileSource);
	let body = "";
	let pragma = null;

	if (!comment) {
		problems.push('missing a leading `// @snippet: {…}` pragma comment');
	} else {
		const tagIndex = comment.text.indexOf(PRAGMA_TAG);
		if (tagIndex === -1) {
			problems.push("the leading comment has no `@snippet:` tag");
		} else {
			const json = extractJsonObject(comment.text.slice(tagIndex + PRAGMA_TAG.length));
			if (json === undefined) {
				problems.push("the `@snippet:` pragma is not a JSON object (unbalanced braces?)");
			} else {
				try {
					pragma = JSON.parse(json);
				} catch (error) {
					problems.push(
						`the \`@snippet:\` pragma is not valid strict JSON: ${error.message} ` +
							"(JSON forbids comments and trailing commas)",
					);
				}
			}
		}
		body = compileSource.slice(comment.end).replace(/^[ \t]*\r?\n/, "");
		if (pragma !== null) {
			validatePragma(pragma, problems);
			tool = typeof pragma.name === "string" && pragma.name.trim() !== "" ? pragma.name.trim() : stem;
			if (!NAME_PATTERN.test(tool)) {
				problems.push(
					`snippet name "${tool}" must match ${NAME_PATTERN} ` +
						'(letters, digits, "_" and "-", starting with a letter or "_") — ' +
						"rename the file or set a valid `name` in the pragma",
				);
			} else {
				const reserved = reservedNameProblem(tool);
				if (reserved !== undefined) problems.push(reserved);
			}
		}
	}

	if (body.trim() === "") {
		problems.push("the snippet has an empty body");
	} else {
		// Body `@options:` line: the extension leaves a malformed one for the
		// sandbox to reject at runtime, so flag it here instead.
		const split = splitBodyOptions(body);
		if (split.optionsText !== undefined) {
			try {
				const options = JSON.parse(extractJsonObject(split.optionsText) ?? "");
				if (!isPlainObject(options)) {
					problems.push('the body\'s `@options:` line must be a JSON object');
				} else {
					for (const key of ["timeout_ms", "max_output_tokens"]) {
						const value = options[key];
						if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
							problems.push(`the body's \`@options:\` \`${key}\` must be a positive number`);
						}
					}
				}
			} catch (error) {
				problems.push(`the body's \`@options:\` line is not valid JSON: ${error.message}`);
			}
		}
	}

	if (pragma !== null) checkInput(pragma.input, body, problems);

	// 1. Compile the file as codemode would compile the script: the pragma is
	//    just a comment, so diagnostics map onto the user's own lines
	//    (the wrapper adds exactly one line at the top).
	const fileError = compile(compileSource, "snippet.js");
	if (fileError) {
		problems.push(syntaxProblem(fileError, 1).join("\n"));
	} else if (pragma !== null && body.trim() !== "") {
		// 2. Compile the generated script — pragma limits + injected
		//    `const input = …` + body — to catch a body that redeclares `input`.
		const merged = {};
		if (typeof pragma.timeoutMs === "number") merged.timeout_ms = pragma.timeoutMs;
		if (typeof pragma.maxOutputTokens === "number") merged.max_output_tokens = pragma.maxOutputTokens;
		const split = splitBodyOptions(body);
		if (split.optionsText !== undefined) {
			try {
				Object.assign(merged, JSON.parse(extractJsonObject(split.optionsText) ?? ""));
			} catch {
				/* already reported above */
			}
		}
		const lines = [];
		if (Object.keys(merged).length > 0) lines.push(`// @options: ${JSON.stringify(merged)}`);
		lines.push("const input = {};");
		lines.push(body.trim());
		const generatedError = compile(lines.join("\n"), "generated.js");
		if (generatedError) {
			problems.push(
				/generated/.test(generatedError.message) || /input/.test(generatedError.message)
					? `the body conflicts with the script the extension generates: ${generatedError.message} ` +
						"(`input` is reserved — the extension injects `const input = …` before the body)"
					: `the generated script fails to compile: ${generatedError.message} ` +
						"(the extension injects the `@options:` line and `const input = …` before the body)",
			);
		}
	}

	if (typeof pragma?.enabled === "boolean") disabled = !pragma.enabled;
	return { problems, tool, disabled };
}

// --- CLI --------------------------------------------------------------------

function collectFiles(args) {
	const files = [];
	for (const arg of args) {
		let stats;
		try {
			stats = statSync(arg);
		} catch {
			throw new Error(`no such file or directory: ${arg}`);
		}
		if (stats.isDirectory()) {
			const inner = readdirSync(arg)
				.filter((entry) => /\.js$/i.test(entry))
				.sort()
				.map((entry) => join(arg, entry));
			if (inner.length === 0) throw new Error(`no .js files in directory: ${arg}`);
			files.push(...inner);
		} else {
			files.push(arg);
		}
	}
	return files;
}

function main(argv) {
	if (argv.length === 0) {
		console.error("usage: node check.mjs <file.js | directory> [...]");
		return 2;
	}

	let files;
	try {
		files = collectFiles(argv);
	} catch (error) {
		console.error(`check.mjs: ${error.message}`);
		return 2;
	}

	let failed = false;
	for (const file of files) {
		const { problems, tool, disabled } = checkSnippetFile(file);
		if (problems.length === 0) {
			const notes = [tool !== undefined ? `tool "${tool}"` : "", disabled ? "disabled" : ""]
				.filter(Boolean)
				.join(", ");
			console.log(`OK    ${file}${notes === "" ? "" : `  (${notes})`}`);
		} else {
			failed = true;
			console.log(`FAIL  ${file}`);
			for (const problem of problems) {
				const [firstLine, ...continuation] = problem.split("\n");
				console.log(`  - ${firstLine}`);
				for (const line of continuation) console.log(`    ${line}`);
			}
		}
	}
	return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
