// @snippet: {
//   "description": "List open pull requests for a GitHub repository, newest first.",
//   "input": {
//     "type": "object",
//     "properties": {
//       "repo": { "type": "string", "description": "owner/name" },
//       "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
//     },
//     "required": ["repo"]
//   },
//   "annotations": { "readOnlyHint": true, "openWorldHint": true },
//   "timeoutMs": 30000
// }
const limit = input.limit ?? 20;
const result = await tools.bash({
	command: `gh pr list -R ${input.repo} --state open --limit ${limit} --json number,title,author,updatedAt`,
});
return JSON.parse(result.output);
