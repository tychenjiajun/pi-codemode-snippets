// @snippet: {
//   "description": "Count a repository's open pull requests by reusing the list_open_prs snippet.",
//   "input": {
//     "type": "object",
//     "properties": { "repo": { "type": "string" } },
//     "required": ["repo"]
//   },
//   "annotations": { "readOnlyHint": true, "openWorldHint": true }
// }
// Snippets compose: another snippet is just another callable tool.
const prs = await tools.list_open_prs({ repo: input.repo, limit: 100 });
return { repo: input.repo, openPrs: prs.length };
