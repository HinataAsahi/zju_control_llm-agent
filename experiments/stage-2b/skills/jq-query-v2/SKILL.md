---
name: jq-query
description: Decide whether jq_query applies, then use it only for deterministic operations on available JSON data.
---

# jq Query

Apply these gates in order before calling `jq_query`:

1. **Source gate:** The original source itself is valid JSON. Plain-text logs, text tables, CSV, and natural language are not JSON.
2. **Task gate:** The answer depends on selecting, transforming, counting, grouping, aggregating, or validating JSON values.
3. **Availability gate:** The JSON is provided inline or in an allowed JSON file.

Call `jq_query` only when all three gates pass. If any gate fails, complete the task without this tool or explain why the task cannot be completed.

Do not convert or re-encode non-JSON input into JSON merely to justify calling `jq_query`.

## Query Strategy

- When the JSON structure is known, prefer one target query.
- When the JSON structure is unknown, inspect it before constructing the target query.
- Use structured errors to correct the source or filter. Do not repeat an unchanged failed call.

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

When required data is missing or inaccessible, return a cannot-complete result with an explanation instead of guessing.
