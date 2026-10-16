# Design decisions

These are the decisions agreed during the design interview, with the rationale
that constrained them. They are the reference when changing behavior.

> **Core invariant:** a snippet *is* a codemode script. Running it is running a
> codemode script; nothing about its semantics is special except where it lives
> and how it is named.

## 1. Authorship: user-authored files only

Snippets are written by a human as files. There is **no** promote-a-run flow and
no auto-curation, so the LLM only discovers and invokes snippets. This keeps the
source reviewable, diffable, and shareable, and removes any ambiguity about the
source of truth.

## 2. Artifact: one `.js` file with a `// @snippet:` pragma

The body is raw codemode JavaScript; metadata lives in a leading comment, in the
same family as pi's `@options:` line. Name defaults to the filename stem.
Rejected: sidecar JSON (two files to sync), a TS module export (breaks the "is a
script" invariant), and Markdown frontmatter (body embedded in prose).

## 3. Input: inline JSON Schema

`input` is a JSON Schema object in the pragma. Pi accepts plain JSON Schema as
tool `parameters` (the MCP bridge casts `inputSchema` straight to `TSchema`), so
no conversion is needed, and codemode renders declarations from the same schema.
The schema is enforced by pi before `execute()`: **no coercion, no
default-filling**. Rejected: a TS-type string (needs a TS→schema parser), and
inference from the script (unreliable).

## 4. Execution: run pi's built-in codemode executor

`execute()` builds `// @options:` + `const input = …;` + body and runs it
through the executor of pi's built-in `codemode` tool. The executor is captured
once in the factory with `captureCodemodeExecutor(pi)` — a `pi` facade that
intercepts the `registerTool` call from `createCodemodeExtension()`, the same
pattern `pi-codemode-guard` uses — and is invoked directly as
`executor.execute(toolCallId, { code }, signal, onUpdate, ctx)`.

This reuses the sandbox, globals, `store`, `models`, nested-call permissions,
and usage accounting. **Corrected after a live smoke test:** an earlier version
called `ctx.executeTool("codemode", { code })`, but pi's `codemode` tool has
`exposure: "model-only"` with the comment *"scripts must not start other
scripts"*, so it is not callable through `executeTool` (`_getCallableTools()`
in `core/agent-session.ts` admits only `codemode`/`deferred`/active-`direct`
tools). Capturing the definition keeps the model's tool set unchanged and keeps
script nesting impossible, while running the identical implementation. Rejected:
a private sandbox via `@earendil-works/pi-codemode` (duplicates the globals and
output handling), and running snippets as Node modules (abandons the sandbox).

## 5. Registration: plain tools, named by the snippet name

Each snippet is registered with `pi.registerTool()` and an explicit `direct`
exposure (pi 1.2.0's default), so it is declared to the model and callable from
scripts and `executeTool` while active. No exposure knobs, no gateway tool, no
namespace.
Input binding is `input`; nesting is capped at 10 via the `<id>/<n>` tool-call
id segments. Each tool declares `reachesTools` (since pi 1.2.0) from its generated
script — "all" when the body uses a discovery global, else the script's
words — so the MCP extension waits for the servers a call may name.

## 6. Storage: conventional directories with project precedence

User `~/.pi/agent/snippets/`, setting paths from the `snippets` settings array,
and project `<cwd>/.pi/snippets/` when the project is trusted. Precedence:
project overrides setting overrides user; later setting entries override earlier
ones. Flat scan, symlinks followed. Never under `extensions/`, whose files are
jiti-loaded modules.

## 7. Lifecycle: session-start scan, `/reload` to refresh

Snippets are loaded in `session_start`, where `ctx.cwd` and
`ctx.isProjectTrusted()` are available and `pi.getAllTools()` is bound (needed
for collision detection). pi's built-in `/reload` re-runs the factory and
`session_start`, which is the correct way to drop a deleted snippet, since there
is no `unregisterTool`. A bad file becomes an issue, never an exception.

## 8. Safety: no second permission system

The extension adds a recursion cap, pragma timeouts, annotation passthrough, and
a project-trust gate — nothing else. Nested tool calls already carry
`parentToolCallId` and traverse the normal permission pipeline. A parallel
approval gate would invite users to trust it over the real one.

## 9. Guard integration: none, by construction

Because the built-in codemode tool is not invoked, a snippet body does not flow
through the `codemode` `tool_call` event, so `pi-codemode-guard` does not compile
it. Snippet bodies are user-authored and already canonical, so this is fine;
the nested tool calls inside a script still flow through the normal event
pipeline. No hard dependency.

## 10. Tool contract

Success returns codemode's content with `details: { snippet, path, calls,
fullOutputPath }`. Failure **throws** with codemode's error text (partial output
included), per pi's tool convention. No `outputSchema`/`structuredContent`:
codemode exposes only text/images and call details, so declaring a structured
result would promise data that never arrives. Default rendering.

## 11. Packaging

A standalone npm/pi package `pi-codemode-snippets` with a default factory and
`createCodemodeSnippetsExtension(options)`, README, examples, tests, and a
`snippets` settings key. Independent of `pi-codemode-guard`.

## Deviations from the interview

- **`/snippet run` is `/snippet preview`.** The command context created by
  `ExtensionRunner.createCommandContext()` has no `executeTool()` (see
  `runner.js:686`), so a command cannot run a snippet. `preview` prints the
  generated codemode script instead; running a snippet is a normal tool call.
- **`output` was dropped.** It was tentatively accepted in Q3, but codemode's
  tool result carries only text/images and `details.calls`/`fullOutputPath`, so
  a snippet tool cannot honestly populate `structuredContent`.
- **Execution captures the codemode executor instead of calling the tool.** A
  live smoke test against the real `pi` binary showed that
  `ctx.executeTool("codemode", …)` fails: the tool is `model-only`. See §4.

## Verification

A live smoke test against `pi` 1.1.0 (isolated with `--no-extensions` plus
`-e <extension> -e builtin:codemode`, `--approve`, `--no-session`, `--no-mcp`)
registered a project snippet, had the model call it, ran the generated script
through the codemode executor, executed a nested `bash` call (carrying
`parentToolCallId`), read its `structuredContent`, and returned `live:ok` with
`details.snippet`/`details.path`/`details.calls` intact.

## Open items

- Builtin-name collision policy: currently skip-and-warn; never shadow.
- `/snippet preview` on a disabled snippet: currently allowed.
- A filesystem watcher (`snippets.watch`) if the reload loop proves annoying.
