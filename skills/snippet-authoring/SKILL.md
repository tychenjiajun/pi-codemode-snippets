---
name: snippet-authoring
description: Author runnable pi-codemode-snippets files — a `.js` file with a `// @snippet:` pragma that the pi-codemode-snippets extension registers as a first-class pi tool. Use when the user asks to create, write, save, or promote a codemode script as a reusable snippet ("write me a snippet", "save this script", "make this a tool"), or to create, fix, or update a file under `~/.pi/agent/snippets/` or a project's `.pi/snippets/`.
---

# Authoring runnable snippets

A snippet is one `.js` file: a `// @snippet: {…}` pragma comment followed by a
codemode script body. pi loads it as a tool the model can call, other tools can
call, and other snippets can compose. Your job when authoring one: write the
file, then **prove it is correct by compilation** with the bundled check script
— never by running pi commands.

```js
// ~/.pi/agent/snippets/list_open_prs.js
// @snippet: {
//   "description": "List open pull requests for a repository, newest first.",
//   "input": {
//     "type": "object",
//     "properties": { "repo": { "type": "string" }, "limit": { "type": "integer" } },
//     "required": ["repo"]
//   },
//   "annotations": { "readOnlyHint": true, "openWorldHint": true }
// }
const limit = input.limit ?? 20;
const result = await tools.bash({
  command: `gh pr list -R ${input.repo} --state open --limit ${limit} --json number,title`,
});
return JSON.parse(result.output);
```

## Workflow

1. **Place the file.** Default to the user directory `~/.pi/agent/snippets/`.
   Use the project directory `<cwd>/.pi/snippets/` only when the user asks for
   project scope (the project must be trusted). Flat directory, `*.js` only —
   the loader ignores any other extension.
2. **Write the pragma.** Strict JSON — no comments, no trailing commas. A
   missing or invalid `description` means the file is silently skipped, so
   write it first: one line, what the tool returns, model-facing.
3. **Write the input schema** (see below) for exactly the fields the body
   reads — pi performs **no coercion and no default-filling**.
4. **Write the body** as a codemode script: top-level `await` and `return`
   work; the globals are the codemode sandbox globals.
5. **Verify by compilation** — required, every time, including for edits:

   ```bash
   node <this skill's directory>/scripts/check.mjs <file.js>
   ```

   It must print `OK` and exit 0. Fix every reported problem and re-run until
   it does. The script checks the pragma JSON, every pragma field, the name
   pattern, the `input` schema (including that the body only reads declared
   fields), the `@options:` line, and compiles the body with `node:vm` using
   codemode's own wrapper — so a syntax error or a redeclaration of the
   reserved `input` binding fails with the offending line.
6. **Hand off.** Tell the user to run `/reload` in pi so the new file is
   scanned (snippets load at session start; there is no file watcher). Do not
   use `/snippet validate`, `/snippet preview`, or other pi commands as your
   verification — the check script is the gate.

## Pragma rules

- `description` (required): non-empty, model-facing — the model decides when
  to call the tool from this text alone.
- `name`: defaults to the filename stem; must match
  `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Filename `list-open-prs.js` is fine;
  `list.open.js` is not (stem contains a dot) unless the pragma sets `name`.
- Unknown pragma fields are **errors** — a typo like `"desciption"` would
  otherwise be silently ignored.
- `annotations` are honesty metadata, not decoration:
  `readOnlyHint: true` only if the snippet never mutates anything;
  `openWorldHint: true` if it reaches external entities (GitHub, the web);
  `destructiveHint` if it deletes or overwrites.
- `timeoutMs` / `maxOutputTokens`: positive numbers, merged into the
  generated `@options:` line; a body's own `@options:` line wins.
- Full field table in `references/fields.md`.

## Input schema rules

- `input` is a plain JSON Schema and must be an object schema
  (`"type": "object"`); a snippet always receives a single object.
- Declare **every field the body reads**, in `input.properties`. Use
  `required` only for fields every caller must pass; optional fields stay out
  of `required` and get their default applied **in the body**
  (`input.limit ?? 20`). Undeclared fields are the classic broken snippet:
  the model cannot know to pass them and nothing fills them in.
- `input` is a reserved binding — the extension injects
  `const input = {…}` before the body; never redeclare it.

## Body rules

- Sandbox: no filesystem, no network, no timers. Reach the world through
  `tools.*` — `tools.bash`, `tools.read`, MCP tools, other snippets.
- Composition: call another snippet like any tool —
  `await tools.list_open_prs({ repo })`. Recursion is capped at depth 10.
- Output: `return value` or `text(…)` add output; `console.log` for
  debugging; `image(…)` for images.
- `store(key, value)` / `load(key)` persist across calls — prefix keys with
  `snippet:<name>:` to avoid collisions.
- Discovery helpers: `ALL_TOOLS`, `searchTools`, `describeTool`,
  `describeNamespace`; `models` runs classifier and image models.
- Full globals table and composition notes in `references/fields.md`.

## Promoting a pasted codemode script

When the user pastes a script and wants it kept as a snippet:

1. Derive the tool name from the script's purpose or the user's words; keep
   it regex-safe (or plan to name the file accordingly).
2. Write a one-line model-facing `description` — this is the tool's pitch to
   the model.
3. Derive `input` from the identifiers the body reads: every `input.x` (in
   the original, likely an undeclared variable like `repo` or `limit`) becomes
   a declared property with a type. Mark required fields thoughtfully.
4. Move parameterization into `input`, keep defaults in the body.
5. Run the check script and fix what it reports.

## What the check script does not cover

Runtime behavior: tool outputs, permissions, API availability, network
credentials. Compilation proves the file loads, validates, and runs; the user
confirms behavior after `/reload` by asking the model to call the tool.
