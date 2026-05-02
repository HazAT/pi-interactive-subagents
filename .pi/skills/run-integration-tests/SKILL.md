---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to "run integration tests", "run e2e tests", "test before release", "verify integration", "run the full test suite", "check everything works".
---

# Run Integration Tests

Execute the integration test suite inside cmux, then introspect every spawned session to verify the full subagent lifecycle worked end-to-end.

## Step 1: Preflight Checks

Verify the environment is ready:

```bash
echo "CMUX_SOCKET_PATH=$CMUX_SOCKET_PATH"
echo "TMUX=$TMUX"
node --version
```

- At least one of `CMUX_SOCKET_PATH` or `TMUX` must be set
- Node 22+ required

If neither mux is available, stop and tell the user to run inside cmux or tmux.

## Step 2: Run Unit Tests

Run the fast unit tests first — if these fail, skip integration tests:

```bash
cd /Users/haza/Projects/pi-interactive-subagents && node --test test/test.ts
```

All 114 unit tests must pass. If any fail, stop and fix them before proceeding.

## Step 3: Run Integration Tests

Use cmux to run the integration tests in a dedicated surface so the main session stays responsive.

```bash
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5
cmux send --surface $SURFACE 'cd /Users/haza/Projects/pi-interactive-subagents && node --test --test-concurrency=1 test/integration/mux-surface.test.ts test/integration/subagent-lifecycle.test.ts 2>&1; echo __TESTS_DONE_$?__\n'
```

`--test-concurrency=1` is required: the focus-preservation test asserts global mux state and would race against parallel suites.

Poll until the sentinel appears:

```bash
cmux read-screen --surface $SURFACE --lines 200
```

Look for `__TESTS_DONE_0__` (success) or `__TESTS_DONE_1__` (failure). Poll every 15 seconds. Timeout after 10 minutes.

Once done, capture the full output and close the surface:

```bash
cmux read-screen --surface $SURFACE --scrollback --lines 500
cmux close-surface --surface $SURFACE
```

### Expected results

| Suite | Tests | Approx Duration |
|-------|-------|-----------------|
| `mux-surface` | 8 | ~45s |
| `subagent-lifecycle` | 7 | ~170s |

All 15 tests must pass. If any fail, report the failure output and stop.

The long-running `keeps a long active tool call from surfacing false stalled status` test in `subagent-lifecycle` runs ~100s on its own — total wall time is ~3:30.

### Configuration

Override defaults with environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_TEST_MODEL` | `anthropic/claude-haiku-4-5` | Model for LLM-backed tests |
| `PI_TEST_TIMEOUT` | `120000` | Per-test timeout in ms |

## Step 4: Introspect Sessions

After tests pass, verify the sessions created during the test run are well-formed. Find them by looking for session directories matching the temp dir pattern:

```bash
# Find session dirs created in the last 15 minutes
find ~/.pi/agent/sessions -type d -name '--private-var-*pi-integ*' -mmin -15 2>/dev/null
```

If no directory is found, widen the search:

```bash
find ~/.pi/agent/sessions -type d -name '*pi-integ*' 2>/dev/null | tail -5
```

Once found, analyze every session file in that directory:

```bash
SESSION_DIR="<the directory found above>"
for f in "$SESSION_DIR"/*.jsonl; do
  echo "=== $(basename $f) ==="
  head -1 "$f" | python3 -c "
import sys, json
d = json.loads(sys.stdin.readline())
print(f\"  type: {d.get('type')}  id: {d.get('id','?')[:12]}  parent: {'YES' if d.get('parentSession') else 'no'}\")
"
  python3 -c "
import sys, json
roles = {}
for line in open('$f'):
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        t = d.get('type','?')
        if t == 'message':
            r = d.get('message',{}).get('role','?')
            roles[r] = roles.get(r,0)+1
        else:
            roles[t] = roles.get(t,0)+1
    except: pass
print('  entries:', ' '.join(f'{k}:{v}' for k,v in sorted(roles.items())))
"
done
```

### What to verify

Check each session against these criteria:

| Check | How | Pass condition |
|-------|-----|----------------|
| **Session header** | First line has `"type": "session"` | Every `.jsonl` file |
| **Has messages** | At least 1 `user` + 1 `assistant` message | Every session |
| **Tool usage** | At least 1 `toolResult` entry | Subagent sessions (they run bash/write) |
| **Fork linkage** | `parentSession` field in header | Exactly 1 session (from fork test) |
| **No errors** | No `"type": "error"` entries | All sessions |
| **Clean exit** | No `stopReason: "aborted"` on final assistant message | All sessions |
| **Parent count** | Multiple parent sessions (one per lifecycle test) | At least 5 parent sessions |
| **Subagent count** | Multiple subagent sessions spawned | At least 7 subagent sessions (1 echo + 1 long-tool + 2 parallel + 1 fork + 1 ping + 1 discovery + 1 sysprompt) |

Run a comprehensive validation:

```bash
python3 -c "
import json, os, sys, glob

session_dir = '$SESSION_DIR'
files = sorted(glob.glob(os.path.join(session_dir, '*.jsonl')))
print(f'Found {len(files)} session files\n')

parents = []
children = []
errors = []

for f in files:
    name = os.path.basename(f)
    lines = [json.loads(l) for l in open(f) if l.strip()]
    if not lines:
        errors.append(f'{name}: empty file')
        continue

    header = lines[0]
    if header.get('type') != 'session':
        errors.append(f'{name}: first entry is {header.get(\"type\")}, not session')
        continue

    is_child = bool(header.get('parentSession'))
    msgs = [l for l in lines if l.get('type') == 'message']
    user_msgs = [m for m in msgs if m.get('message',{}).get('role') == 'user']
    asst_msgs = [m for m in msgs if m.get('message',{}).get('role') == 'assistant']
    tool_results = [m for m in msgs if m.get('message',{}).get('role') == 'toolResult']
    error_entries = [l for l in lines if l.get('type') == 'error']

    info = {
        'name': name,
        'entries': len(lines),
        'users': len(user_msgs),
        'assistants': len(asst_msgs),
        'tools': len(tool_results),
        'errors': len(error_entries),
        'is_child': is_child,
    }

    if is_child:
        children.append(info)
    else:
        parents.append(info)

    # Validate
    if not user_msgs:
        errors.append(f'{name}: no user messages')
    if not asst_msgs:
        errors.append(f'{name}: no assistant messages')
    if error_entries:
        errors.append(f'{name}: has {len(error_entries)} error entries')

    # Check for aborted final assistant
    for m in reversed(msgs):
        if m.get('message',{}).get('role') == 'assistant':
            if m.get('message',{}).get('stopReason') == 'aborted':
                errors.append(f'{name}: final assistant message was aborted')
            break

print(f'Parent sessions: {len(parents)}')
for p in parents:
    print(f'  {p[\"name\"][:40]}  entries:{p[\"entries\"]}  user:{p[\"users\"]}  asst:{p[\"assistants\"]}  tools:{p[\"tools\"]}')

print(f'\nChild sessions (parentSession set): {len(children)}')
for c in children:
    print(f'  {c[\"name\"][:40]}  entries:{c[\"entries\"]}  user:{c[\"users\"]}  asst:{c[\"assistants\"]}  tools:{c[\"tools\"]}')

fork_count = sum(1 for c in children if c['is_child'])
print(f'\nFork sessions: {fork_count}')

if errors:
    print(f'\n❌ ERRORS ({len(errors)}):')
    for e in errors:
        print(f'  - {e}')
    sys.exit(1)
else:
    print(f'\n✅ All {len(files)} sessions are well-formed')
    print(f'   {len(parents)} parent + {len(children)} child sessions')
    print(f'   {fork_count} fork-linked session(s)')
"
```

## Step 5: Report

Print a final summary:

```
╭─────────────────────────────────────────────╮
│ Integration Test Results                    │
├─────────────────────────────────────────────┤
│ Unit tests:        114/114 ✅               │
│ Mux surface:       8/8  ✅                  │
│ Subagent lifecycle: 7/7  ✅                 │
│ Session validation: X sessions verified ✅  │
│ Fork linkage:      verified ✅              │
╰─────────────────────────────────────────────╯
```

If any step failed, summarize what broke and suggest next steps.
