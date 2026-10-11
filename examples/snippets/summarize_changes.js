// @snippet: {
//   "description": "Summarize the repository's uncommitted changes as a short report.",
//   "input": { "type": "object", "properties": {} },
//   "annotations": { "readOnlyHint": true },
//   "promptGuidelines": ["Use summarize_changes before writing a commit message."]
// }
const status = await tools.bash({ command: "git status --short" });
const diff = await tools.bash({ command: "git diff --stat" });
text(status.output.trim() || "(working tree clean)");
return diff.output.trim();
