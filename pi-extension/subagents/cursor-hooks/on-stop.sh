#!/usr/bin/env bash
# Stop hook for pi-spawned Cursor Agent sessions.
# pi-interactive-subagents cursor stop hook

set -euo pipefail

# Read JSON input from stdin.
input=$(cat)

# Guard: only act for pi-spawned Cursor Agent sessions.
if [ -z "${PI_CURSOR_SENTINEL:-}" ]; then
  exit 0
fi

# Guard: if stop_hook_active is ever provided, do not recurse.
stop_hook_active=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null || echo "False")
if [ "$stop_hook_active" = "True" ]; then
  exit 0
fi

status=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status') or 'completed')" 2>/dev/null || echo "completed")
transcript_path=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path') or '')" 2>/dev/null || echo "")

# Always write transcript path so the watcher can copy the session file.
if [ -n "$transcript_path" ]; then
  echo "$transcript_path" > "${PI_CURSOR_SENTINEL}.transcript" 2>/dev/null || true
fi

# The stop hook does not expose the final assistant message. For successful runs,
# create an empty sentinel so pi falls back to the pane screen scrape. For failed
# or aborted runs, write a concise status summary.
if [ "$status" = "completed" ]; then
  : > "$PI_CURSOR_SENTINEL" 2>/dev/null || touch "$PI_CURSOR_SENTINEL"
else
  echo "Cursor Agent stopped with status: $status" > "$PI_CURSOR_SENTINEL" 2>/dev/null || touch "$PI_CURSOR_SENTINEL"
fi

exit 0
