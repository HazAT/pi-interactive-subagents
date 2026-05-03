# Plan: Add con-terminal adapter for interactive subagents

## Context

Add support for [con-terminal](https://github.com/nowledge-co/con-terminal/issues/94) as another terminal backend for `pi-interactive-subagents`, alongside cmux, tmux, zellij, and WezTerm. The goal is to preserve the existing interactive-subagent behavior: the first subagent opens a visible split, later subagents attach as additional surfaces inside that same worker pane, commands are driven by surface id, screens can be read, Escape can interrupt Pi-backed subagents, and surfaces are closed after completion.

## CLI probe findings

Non-mutating/no-op checks against the installed `con-cli`:

- Binary exists at `/Users/jayghiya/.cargo/bin/con-cli`.
- `con-cli --version` is not supported; version is exposed through `con-cli identify` / `con-cli --json identify`.
- `con-cli --help` reports commands: `identify`, `capabilities`, `tabs`, `panes`, `tree`, `surfaces`, `tmux`, `agent`.
- `con-cli surfaces --help` reports the needed subcommands: `list`, `create`, `split`, `focus`, `rename`, `close`, `read`, `send-text`, `send-key`, `wait-ready`.
- `con-cli --json identify` succeeds without an explicit socket and returns:
  - `app: "con"`
  - `version: "0.1.0"`
  - `socket_path: "/tmp/con.sock"`
  - `active_tab_index: 1`
  - method inventory including all required `surfaces.*` methods.
- `con-cli --json tree` returns tab/pane/surface state. The current pane/surface example was:
  - `tab_index: 1`
  - `pane_id: 0`
  - `pane_ref: "pane:1"`
  - `surface_id: 1`
  - `surface_ref: "surface:1"`
  - `surface_ready: true`
  - `has_shell_integration: true`
- `con-cli --json surfaces list` returns an array of surfaces with useful fields: `surface_id`, `surface_ref`, `pane_id`, `pane_ref`, `tab_index`, `title`, `cwd`, `rows`, `cols`, `is_alive`, `is_active`, `surface_ready`, `has_shell_integration`, `owner`, `close_pane_when_last`.
- Target flags require numeric IDs, not refs:
  - `--surface-id surface:1` fails.
  - `--surface-id 1` works.
  - `--pane-id pane:1` fails.
  - `--pane-id 0` works.
- `con-cli --json surfaces read --surface-id 1 --lines 5` returns `{ content, pane_id, surface_id, tab_index }`.
- `con-cli --json surfaces wait-ready --surface-id 1 --timeout 1` returns readiness metadata including `status: "ready"`, `is_alive`, `is_busy`, and `surface_ready`.
- No con-specific environment variables were present in this shell from `env | grep -Ei '(^|_)CON(_|=)|CONCLI|CON_TERMINAL|CON_SOCKET|CON_PANE|CON_TAB|CON_SURFACE'`.

Mutating probes were run only against temporary owned surfaces/panes and then cleaned up:

- `surfaces create --tab 1 --pane-id 0 --title ... --owner pi-interactive-subagents-probe` returns JSON shaped like:
  - `created_pane: false`
  - `pane_id: 0`
  - `surface_id: 4`
  - `surface_ready: false`
- `surfaces split --tab 1 --pane-id 0 --location right --title ... --owner pi-interactive-subagents-probe` returns JSON shaped like:
  - `created_pane: true`
  - `pane_id: 2`
  - `surface_id: 5`
  - `surface_ready: false`
- After either create or split, `surfaces wait-ready --surface-id <id> --timeout 10` transitions the surface to a shell-ready state.
- Omitting `--command` is the correct adapter behavior. con starts the user's shell naturally. Passing `--command "$SHELL"` caused the shell path to appear/exeute inside the new terminal and is not needed.
- `surfaces send-text --surface-id <id> "echo ..."` followed by `surfaces send-key --surface-id <id> enter` works and the output is visible via `surfaces read`.
- `surfaces send-key --surface-id <id> escape` succeeds; use lowercase `escape` for `sendEscape()`.
- `surfaces rename --surface-id <id> <title>` works and returns `{ status: "renamed", title }`.
- `surfaces focus --surface-id <id>` works and marks the temporary surface active. After closing it, con returned focus/active state to the original surface.
- `surfaces close --surface-id <id>` closes a temporary surface inside an existing pane without closing the pane.
- `surfaces close --surface-id <id> --close-empty-owned-pane` closes the newly-created split pane when that owned split surface is the last surface in it.
- Final state after all probes had one original pane and one original surface; no workspace/tab was closed.

## Approach

Extend the existing mux adapter in `pi-extension/subagents/cmux.ts` with a new `con` backend. Reuse the same behavior as the existing cmux implementation: for each running Pi process, track a module-level worker pane for subagents; create that process's first child worker via `surfaces split`; create later child workers from that same process via `surfaces create` inside the already-created worker pane; wait for readiness; then drive the resulting numeric surface id.

This is intentionally the same behavioral model as cmux:

- Main Pi session launches first subagent → create one right split worker pane.
- Main Pi session launches additional subagents → create additional con surfaces in that same worker pane, not more splits.
- If a subagent itself is allowed to spawn subagents, that child Pi process has its own adapter state. Its first nested subagent creates a split relative to the child process's current con pane/surface, and its later nested subagents attach as more surfaces in that nested worker pane.

In cmux terms, con `surfaces create` is the equivalent of creating another tab/surface inside the tracked worker pane. The target is not one split per subagent; the target is one worker split per spawning Pi process, with subsequent workers multiplexed as pane-local con surfaces.

Because no con environment variables were detected, runtime detection should be command/API based rather than env-only: `hasCommand("con-cli")` plus a successful `con-cli --json identify` whose parsed `app` is `"con"`. This is different from tmux/cmux/zellij, but matches the installed CLI behavior.

Use numeric ids internally for con surfaces and panes. Do not store `surface_ref` / `pane_ref` as operational ids because con's CLI flags reject `surface:1` and `pane:1`.

Do not pass `--command` during adapter-created surfaces. Let con start the user's shell, wait for readiness, then use the existing `sendLongCommand()` flow to send `bash <script>` via `send-text` and `send-key enter`.

## Files to modify

- `pi-extension/subagents/cmux.ts`
  - Add `con` to `MuxBackend`.
  - Add con availability, preference, setup hint, create/read/send/escape/close/rename branches.
  - Add con JSON parsing helpers and tracked worker pane state.
- `README.md`
  - Add con-terminal to supported multiplexers and `PI_SUBAGENT_MUX=con` docs.
- `package.json`
  - Update description if desired to mention con.
- `test/integration/harness.ts`
  - Add con to backend discovery/probing once mutating create/split behavior is validated.

## Reuse

- Existing backend dispatcher functions in `pi-extension/subagents/cmux.ts`:
  - `getMuxBackend()`
  - `isMuxAvailable()`
  - `createSurface()`
  - `sendCommand()`
  - `sendEscape()`
  - `readScreen()` / `readScreenAsync()`
  - `closeSurface()`
  - `pollForExit()`
- Existing cmux first-split/subsequent-tab pattern:
  - `cmuxSubagentPane`
  - `createSurfaceInPane()` concept
  - `parseCmuxCreatedSurface()` concept, but con should parse JSON not regex.
- Existing `tailLines()` utility is likely unnecessary for con `read --lines`, but available if JSON content needs trimming.
- Existing shell launch flow in `index.ts` should remain unchanged: create surface, wait briefly, then `sendLongCommand()` drives the generated script.

## Steps

- [x] Validate mutating con operations in a controlled manual test: create a temporary owned surface in current pane, wait-ready, read it, send a harmless command, close it.
- [x] Validate first-worker split behavior: `surfaces split --tab 1 --pane-id 0 --location right --title ... --owner pi-interactive-subagents-probe`, parse returned JSON, wait-ready, send/read, then close with `--close-empty-owned-pane`.
- [x] Validate `surfaces rename`, `surfaces focus`, `surfaces send-key enter`, and `surfaces send-key escape` on temporary surfaces.
- [ ] Add `con` backend type, preference parsing, availability detection, setup hints, and exported availability helper if needed.
- [ ] Add con helpers:
  - [ ] `conJson(args)` / `readConJson(args)` for parsed JSON command execution.
  - [ ] `captureConIdentify()` to get active tab.
  - [ ] `readConCurrentSurface()` or `readConSurfaces()` to locate current tab/pane/surface.
  - [ ] `parseConCreatedSurface()` using JSON keys (`surface_id`, `pane_id`, `tab_index`).
  - [ ] `createConSplitSurface()` and `createConSurfaceInPane()` without `--command`.
  - [ ] `waitForConSurfaceReady()`.
- [ ] Wire con branches into:
  - [ ] `createSurface()`
  - [ ] `createSurfaceSplit()` if useful; otherwise support only standard `createSurface()` and throw/route appropriately.
  - [ ] `sendCommand()` with `send-text` + `send-key enter`.
  - [ ] `sendEscape()` with `send-key escape`.
  - [ ] `readScreen()` / `readScreenAsync()` parsing JSON `content`.
  - [ ] `closeSurface()` using `surfaces close --surface-id <id> --close-empty-owned-pane` so the first worker split pane is removed when its last owned surface closes.
  - [ ] `renameCurrentTab()` using `surfaces rename` if current surface id can be resolved; otherwise no-op.
  - [ ] `renameWorkspace()` as no-op unless con exposes a workspace/tab rename API needed here.
- [ ] Update README/docs.
- [ ] Add/update tests where practical.

## Verification

- Run unit tests: `npm test`.
- Run integration tests for existing backends where available: `npm run test:integration`.
- Manual con verification:
  - Start `pi` inside con.
  - Set `PI_SUBAGENT_MUX=con`.
  - Spawn one subagent and verify a right split appears.
  - Spawn a second subagent and verify it appears as another surface inside the first worker pane, not as a second split.
  - Verify the widget updates from `readScreenAsync()` polling.
  - Verify `subagent_interrupt` sends Escape.
  - Verify completion closes only the owned worker surface/pane and does not close the user's original pane.

## Open questions

- Should con be auto-detected whenever `con-cli --json identify` succeeds, even when not launched from a con-specific environment variable? The probe suggests yes because no con env vars were present.
- Should `renameCurrentTab()` map to current con surface rename or remain a no-op? `surfaces rename` works for a target surface, but current-tab semantics are not the same as a pane-local surface title.
