---
name: jq-query
description: Use when a task requires querying, filtering, transforming, aggregating, or validating JSON data with the jq_query MCP tool.
---

# jq Query

Use `jq_query` for deterministic operations on JSON from inline data or an allowed file.

## When to Use

- The source is valid JSON.
- The work requires selecting, transforming, counting, grouping, aggregating, or validating JSON values.
- A failed jq call can be corrected from its structured error.

## When Not to Use

- The source is plain text or another non-JSON format.
- The requested result does not depend on querying JSON.
- Required source data is unavailable; do not invent replacement data.

## Sources and Results

Pass inline JSON with an inline source. Pass an available file using its allowed relative path. Successful calls return `ok: true`, a `values` array, and `exitCode: 0`.

Failed calls return `ok: false`, a structured error, and a nullable exit code:

| Code | Meaning |
|---|---|
| `PATH_NOT_ALLOWED` | The requested path is outside the allowed source root or otherwise disallowed. |
| `FILE_NOT_FOUND` | The requested file does not exist. |
| `INPUT_TOO_LARGE` | The input exceeds the configured size limit. |
| `JQ_SYNTAX_ERROR` | The jq filter is not syntactically valid. |
| `JQ_RUNTIME_ERROR` | jq could not evaluate the filter against the input. |
| `TIMEOUT` | jq exceeded the execution deadline. |
| `OUTPUT_LIMIT` | jq output exceeded the configured size limit. |
| `INTERNAL_ERROR` | The tool encountered an internal failure. |

Correct recoverable source or filter errors and retry. When required data is missing or inaccessible, return a cannot-complete result with an explanation instead of guessing.
