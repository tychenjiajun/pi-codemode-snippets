# Snippet reference

Complete reference for `pi-codemode-snippets` files. The core workflow is in
`../SKILL.md`; this file holds the tables.

## File format

One file per snippet, flat directory, `*.js` only. Leading comment = pragma,
everything after it = body.

Accepted pragma shapes:

```js
// @snippet: { … JSON … }          // one line
/* @snippet: { … JSON … } */       // one block
// @snippet: {                     // several // lines
//   "description": "…"
// }
```

A shebang before the pragma is allowed. The first body line may be pi's own
`// @options: {"max_output_tokens": 500}` line; it merges with the pragma
limits, and the body wins on conflict.

## Pragma fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `description` | **yes** | — | Model-facing description. Files without it are skipped. |
| `name` | no | filename stem | Tool name, must match `[A-Za-z_][A-Za-z0-9_-]{0,63}`; `codemode` and `mcp__…` are reserved. |
| `label` | no | `name` | UI label. |
| `input` | no | `{"type":"object","properties":{}}` | JSON Schema of the single object argument. |
| `enabled` | no | `true` | `false` keeps the file but registers no tool. |
| `timeoutMs` | no | unset | Merged into the generated `@options.timeout_ms`. |
| `maxOutputTokens` | no | unset | Merged into the generated `@options.max_output_tokens`. |
| `annotations` | no | unset | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (booleans). |
| `promptGuidelines` | no | unset | Extra guideline bullets shown with the tool. |

Any other pragma key is an error (the loader ignores it silently — the check
script catches the typo).

## Annotations

| Annotation | Set to `true` only when |
|---|---|
| `readOnlyHint` | The snippet never modifies its environment (reads and reports only). |
| `destructiveHint` | The snippet may delete or overwrite data. |
| `idempotentHint` | Repeating the call with the same input has no further effect. |
| `openWorldHint` | The snippet reaches external entities (GitHub, the web, other systems). |

## Input validation semantics

- The schema is enforced by pi **before** the body runs: wrong type, missing
  required field, or a failed enum rejects the call.
- **No coercion, no default-filling.** Apply defaults in the body:
  `const limit = input.limit ?? 20;`.
- Every caller passes a different object: the model
  (`list_open_prs({ repo })`), another snippet or codemode script
  (`await tools.list_open_prs({ repo, limit: 5 })`), another extension
  (`ctx.executeTool("list_open_prs", { repo })`).
- `input` is reserved; do not redeclare it.

## Sandbox globals

| Global | Purpose |
|---|---|
| `input` | The validated tool arguments (a single object). |
| `tools.<name>(args)` | Call any tool, including other snippets. |
| `text(value)`, `image(value)`, `console.log(...)`, `exit()` | Add output. |
| `return value` | Add the returned value, like `text()`. |
| `store(key, value)` / `load(key)` | Persist small JSON values across calls. Prefix keys `snippet:<name>:`. |
| `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace` | Discover other tools. |
| `models` | List and run classifier and image models. |

Not available: filesystem, network, timers, `import`. Get data through
`tools.*` (for example `tools.bash({ command: "gh pr list …" })`).

## Composition

Every snippet is a registered tool, so one snippet calls another with
`tools.<name>({…})`. Recursion is capped (default depth 10) — a snippet that
calls itself, directly or transitively, fails at depth 11.

```js
// @snippet: {"description":"Count a repository's open pull requests.","input":{"type":"object","properties":{"repo":{"type":"string"}},"required":["repo"]}}
const prs = await tools.list_open_prs({ repo: input.repo, limit: 100 });
return { repo: input.repo, openPrs: prs.length };
```

## Directories and precedence

| Scope | Directory |
|---|---|
| user | `~/.pi/agent/snippets/` |
| setting | paths in the `snippets` settings array |
| project | `<cwd>/.pi/snippets/` (trusted projects only) |

Higher scope wins on a name collision (project > setting > user). Snippets
load at session start; `/reload` re-scans.

## Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `not valid strict JSON` | Comment or trailing comma in the pragma | Strict JSON only |
| `needs a non-empty "description"` | Missing/typo'd description | Add the model-facing summary |
| `unknown @snippet field "…"` | Typo'd field name | Use the exact field names from the table |
| `must match /^[A-Za-z_]/…/` | Bad name or filename stem (dots etc.) | Rename file or set `name` |
| `is reserved` | Name is `codemode` or starts with `mcp__` | Rename file or set another `name` |
| `syntax error at line N` | Body doesn't compile | Fix the line shown — N maps to your file |
| `Identifier 'input' has already been declared` | Body redeclares `input` | Remove the declaration; `input` is injected |
| `the body reads input.x but … does not declare "x"` | Schema missing a field the body uses | Add it to `input.properties` |
| `input.type" must be "object"` | Non-object schema | A snippet always receives one object |
| `the snippet has an empty body` | Pragma only | Add the script body |
| tool never appears after writing | pi hasn't re-scanned | Tell the user to run `/reload` |
