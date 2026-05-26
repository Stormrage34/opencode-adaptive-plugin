# Deduplication in AdaptivePlugin

AdaptivePlugin stores telemetry records in a SQLite database (`.opencode_telemetry.db`).

## Why deduplication?

When the same tool is executed multiple times with identical inputs, we want to avoid storing duplicate telemetry entries. Duplicate entries would inflate statistics and waste storage.

## How it works

Deduplication is performed **in‑process** using a 5 second sliding window keyed by `(sessionID, toolName)`. The `tool.execute.after` hook checks a `recentOps` map; if the same tool is called for the same session within 5 s the call is ignored. This approach avoids SQLite constraints and works even when `prompt_hash` is `NULL`.

The `recentOps` map is cleaned every 60 s to bound memory usage.

## Observing the warning

(There is no longer a duplicate‑insert warning because the DB index was removed.)

## Testing deduplication

The test suite includes a test (`sliding window dedup skips duplicate tool calls within 5s`) that verifies duplicate tool calls within the window are ignored. Since the DB index was removed, duplicate inserts no longer emit a warning.

## Impact on analytics

Only the first unique record for a given `(sessionID, toolName)` within the 5 s window is stored. Subsequent identical executions within that window are ignored, ensuring trend analysis and confidence statistics are based on distinct observations.
