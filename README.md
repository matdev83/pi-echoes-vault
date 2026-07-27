# EchoesVault for Pi (Earendil Works)

Persistent, file-based project memory for the **Earendil Works Pi coding agent** (`@earendil-works/pi-coding-agent`). Obsidian-style Markdown vault with daily logs, encyclopedia pages, and session restore — without a custom GUI.

This package is a **Pi harness port** of [`echoes-vault-opencode`](https://github.com/psinetron/echoes-vault-opencode) (MIT). Domain behavior is preserved; OpenCode-specific plugin/TUI pieces are replaced with a Pi extension, tools, commands, and skills.

## Pi distribution target

This port is built and typed against the **Earendil Works** Pi distribution and its package API:

- Peer / import: `@earendil-works/pi-coding-agent`
- Extension surface used here: `ExtensionAPI`, `registerTool`, `registerCommand`, `sendUserMessage` (including `deliverAs: "followUp"`), and session lifecycle events (`session_start`, `session_before_switch`, `session_before_fork`, `session_shutdown`)

That choice is deliberate for environments that ship Earendil Works Pi. It is **not** a drop-in peer rename of upstream [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono).

### Adapting for other Pi distributions

If you run upstream Mario Zechner Pi (or another fork) instead:

1. Change `peerDependencies` / `devDependencies` from `@earendil-works/pi-coding-agent` to your distribution’s package name (e.g. `@mariozechner/pi-coding-agent`).
2. Update the type-only import in `extensions/echoes-vault.ts` to match.
3. Confirm your harness still exposes the same extension hooks (`registerTool` / `registerCommand` / `sendUserMessage` / session lifecycle events). Adjust call sites only if the API differs.
4. Re-run `npm run check` against that package’s typings.

Domain logic under `src/vault.ts` is harness-agnostic and usually needs no changes.

## Install

From a trusted project directory (with Earendil Works `pi` on your PATH):

```bash
pi install /absolute/path/to/pi-echoesvault
# or, once published:
# pi install npm:pi-echoes-vault
```

Use `-l` for project-local settings (`.pi/settings.json`). For a one-off trial without installing:

```bash
pi -e ./extensions/echoes-vault.ts
```

Peer runtime modules (`@earendil-works/pi-coding-agent`, `typebox`) are provided by Pi; you do not need a separate app install for those when running inside Pi.

## Usage

| Command | Purpose |
|---------|---------|
| `/echoes-init` | Bootstrap `EchoesVault/`, write `.pi/echoes-state.json`, activate, instruct the agent |
| `/echoes-start` | Mark session started; inject index + last 3 daily logs via `pi.sendUserMessage` |
| `/echoes-end` | Ask the agent to call `commit_memory_to_echoes_vault` |
| `/echoes-status` | Inject vault metrics + index/today log for a short health dashboard |

### Automatic session lifecycle

When the extension is loaded **and** a real vault already exists (`EchoesVault/` directory with `index.md`):

| Event | Behavior |
|-------|----------|
| `session_start` (`startup` / `new` / `resume` / `fork`) | Runs the same restoration workflow as `/echoes-start` once per extension runtime |
| `session_start` (`reload`) | Refreshes stats only — does **not** re-inject start context |
| `session_before_switch` / `session_before_fork` | If the session is started and not yet saved, queues the existing `/echoes-end` prompt once and **cancels** the switch/fork so the model can commit. Retry after a successful commit (or after a failed end turn settles — see below). |
| `agent_settled` | If an end prompt was queued and the agent turn finished **without** `commit_memory_to_echoes_vault`, clears the in-flight end flag so a later switch or `/echoes-end` can retry. Does **not** auto-loop the end prompt. |
| `session_shutdown` (`quit`) | Never sends a model prompt (teardown would abort it). If unsaved, records `endPending` for the next start. |
| `session_shutdown` (`reload`) | No end-pending marker |

Successful `commit_memory_to_echoes_vault` is the authoritative “already saved” signal: it clears `endPending`, marks `saved`, and suppresses automatic end prompts.

Start dedupe is **runtime-local** (per extension instance / cwd). A process restart or Pi session replacement (`/new`, `/resume`, `/fork`) binds a fresh instance, so restoration runs again even if persisted `startPromptSent` was left true. If a prior quit left `endPending`, the next start includes a conservative recovery instruction and keeps `endPending` until a successful commit.

State read-modify-write for lifecycle and commit is serialized **in-process** per cwd (no cross-process lock).

Vault creation is **not** triggered merely by loading the extension. Use `/echoes-init` for a fresh project. State-only `.pi/echoes-state.json` without `EchoesVault/index.md` does not enable auto-start. Manual `/echoes-end` (and `/echoes-start` / `/echoes-status`) on a project without a real vault notify you to run `/echoes-init` and do not create one.

Manual `/echoes-start` / `/echoes-end` after the automatic prompts are no-ops for that runtime (deduped via runtime-local start tracking and `endPromptSent` / in-flight end state).

If the agent is busy, prompts are queued with `deliverAs: "followUp"` and a brief `ctx.ui.notify` is shown when UI is available.

On before-switch/fork handler errors while a save is still needed, the transition is **cancelled defensively** rather than allowing an unsaved exit.

### Tools (LLM-callable)

- `commit_memory_to_echoes_vault` — session wrap-up: daily summary, optional pages, index appends/updates (new pages require a matching index line)
- `echoes_append_to_daily_log` — mid-session scratchpad append
- `echoes_search_vault_pages` — bounded keyword search under `pages/`
- `echoes_create_or_update_page` — create/update a page; `indexDescription` required for new files

Activation / session tracking is handled in command handlers and lifecycle hooks (not separate model tools).

### Skills

Package skills under `skills/` document when to call the three daily/page tools (Pi tool names use underscores; skill frontmatter names use hyphens matching the directories).

## Layout (project cwd)

```
EchoesVault/
  raw/          # source materials (read-only by convention)
  pages/        # encyclopedia Markdown
  daily/        # YYYY-MM-DD.md session logs
  assets/       # diagrams / images
  index.md      # master registry
.pi/
  echoes-state.json   # schema v2 (lifecycle flags)
```

## Develop / test

No network install is required if peer packages already exist on the machine (as with a global Pi install). From the package root:

```bash
npm install --omit=optional
npm run check
```

- `npm test` — focused `node:test` coverage for vault domain logic
- `npm run smoke` — loads the extension with a mock registration API and exercises lifecycle hooks
- `npm run typecheck` — `tsc --noEmit`

## Attribution & license

MIT. Substantial portions are derived from [echoes-vault-opencode](https://github.com/psinetron/echoes-vault-opencode) by Fail (Copyright 2026 Fail). See [LICENSE](LICENSE). Original OpenCode plugin README/marketing and TUI sidebar are intentionally not ported.
