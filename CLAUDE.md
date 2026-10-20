# llm_chrome

Chrome MV3 extension that lets a local LLM (llama-server, OpenAI-compatible API,
on another LAN machine) browse sites like a human to find information.
Runs can happen overnight; speed is not a priority, robustness is.

## Architecture

- **content script** (dom-extractor) — runs in the page, serializes DOM/iframes/
  shadow DOM into a compact text snapshot with numeric element IDs.
- **content script** (action-executor) — resolves IDs from the snapshot and
  performs human-like click/type/scroll/navigate, verifies effect.
- **background service worker** (llm-client) — sends snapshot + instructions to
  llama-server over the LAN, parses the JSON command back, retries on drops.
- **background service worker** (agent-loop) — orchestrates
  snapshot → model → action → verify, stop conditions, step log in
  `chrome.storage`, survives service-worker restarts.
- Cross-cutting: security-reviewer (manifest/prompt-injection/endpoint audit,
  read-only), log-reader (console/server/test log triage, read-only).

## Interfaces between modules

These already have a real implementation — see the linked files for the
authoritative shape; this section is a map, not the spec.

### Page snapshot format
`ElementInfo` ([src/lib/dom/types.ts](src/lib/dom/types.ts)) — one entry per
interactive element: `index`, `tag`, `role`, `name`, `attrs`, `states`, `zone`
(above/visible/below viewport), `flags` (risk hints, never shown to the
model). Rendered to text by [src/lib/dom/serialize.ts](src/lib/dom/serialize.ts)
as sectioned `[N] tag "name" attrs` lines + a text block with `[N]` markers.

### Model command format
`AgentStep` / `AgentAction` ([src/lib/agent/actions.ts](src/lib/agent/actions.ts)) —
one step = `{reasoning, expected_outcome, actions[], risky?}`; actions are a
closed union (click/type/select/scroll/hover/press_key/drag/wait_for/navigate/
go_back/wait/new_tab/switch_tab/extract/done/ask_user), addressed by `index`
from the snapshot. Parsed in [src/lib/agent/parse.ts](src/lib/agent/parse.ts),
executed in [src/lib/dom/act.ts](src/lib/dom/act.ts), orchestrated in
[src/lib/agent/loop.ts](src/lib/agent/loop.ts) / [runner.ts](src/lib/agent/runner.ts).

`.claude/agents/*.md` were written generically, before this mapping was
checked against the real tree — reconcile file references there with the
paths above rather than treating the agent prompts as the source of truth.
