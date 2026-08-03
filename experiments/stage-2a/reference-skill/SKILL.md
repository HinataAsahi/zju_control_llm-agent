# jq Query Reference

Use `jq_query` to evaluate a jq filter against either inline JSON data or a file source. File paths are relative to the configured source root.

Build filters incrementally. Use field access, array iteration, selection, mapping, reduction, grouping, and object construction as needed. A successful tool response contains JSON values. If a call fails, inspect its error code, correct the source or filter when possible, and retry with a valid request.

Do not infer facts from a missing or inaccessible source. In that case, report that the task cannot be completed and explain the unavailable data.
