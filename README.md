# EchoesVault for Pi Agent Harness

Persistent agent memory for the Pi coding-agent harness: a Markdown/Obsidian-compatible knowledge base with daily logs, architecture/ADR pages, and session continuity — without a custom GUI.

Vault pages use YAML frontmatter and typed Markdown conventions inspired by Google’s [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf). This port follows those practical patterns (frontmatter, encyclopedia pages, index registry); it does **not** ship a formal OKF schema validator or claim certified compliance.

This package is a **Pi harness port** of [`echoes-vault-opencode`](https://github.com/psinetron/echoes-vault-opencode) (MIT). Domain behavior is preserved; OpenCode-specific plugin/TUI pieces are replaced with a Pi extension, tools, commands, and skills.

## Pi distribution target

Built and typed against the `@earendil-works/pi-coding-agent` package API (compatibility requirement):

- Peer / import: `@earendil-works/pi-coding-agent`
- Extension surface used here: `ExtensionAPI`, `registerTool`, `registerCommand`, `sendUserMessage` (including `deliverAs: "followUp"`), and session lifecycle events (`session_start`, `session_before_switch`, `session_before_fork`, `session_shutdown`)

That peer is deliberate for environments that ship this Pi distribution. It is **not** a drop-in peer rename of upstream [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono).

### Adapting for other Pi distributions

If you run upstream Mario Zechner Pi (or another fork) instead:

1. Change `peerDependencies` / `devDependencies` from `@earendil-works/pi-coding-agent` to your distribution’s package name (e.g. `@mariozechner/pi-coding-agent`).
2. Update the type-only import in `extensions/echoes-vault.ts` to match.
3. Confirm your harness still exposes the same extension hooks (`registerTool` / `registerCommand` / `sendUserMessage` / session lifecycle events). Adjust call sites only if the API differs.
4. Re-run `npm run check` against that package’s typings.

Domain logic under `src/vault.ts` is harness-agnostic and usually needs no changes.

## Requirements

- **Node.js** `>=22` (matches this package’s `engines` field)
- Pi coding agent with the `@earendil-works/pi-coding-agent` extension API on your PATH (see [Pi distribution target](#pi-distribution-target))

## Install

Canonical install is from this GitHub repository (`pi` on your PATH), in a trusted project directory:

```bash
pi install https://github.com/matdev83/pi-echoes-vault
```

Equivalent git shorthand (same unpinned source):

```bash
pi install git:github.com/matdev83/pi-echoes-vault
```

Use `-l` to install into project-local settings (`.pi/settings.json`) instead of user settings:

```bash
pi install -l https://github.com/matdev83/pi-echoes-vault
# or: pi install -l git:github.com/matdev83/pi-echoes-vault
```

Pin a stable release tag (recommended for shared/team settings):

```bash
pi install git:github.com/matdev83/pi-echoes-vault@vX.Y.Z
```

One-session trial without writing settings (`-e` / `--extension`):

```bash
pi -e https://github.com/matdev83/pi-echoes-vault
# or: pi -e git:github.com/matdev83/pi-echoes-vault
# or from a checkout:
pi -e ./extensions/echoes-vault.ts
```

Local checkout path also works: `pi install /absolute/path/to/pi-echoes-vault`.

### Update / remove

Unpinned installs (no `@ref`) track the repository default / upstream branch tip. `pi update --extensions`, `pi update --all`, or the exact package source fetches and advances that clone.

Pinned installs (`@vX.Y.Z` or a commit) stay on that ref: package updates reconcile the clone to the configured ref and do **not** move you to a newer tag. To change pins, reinstall with the new ref, for example:

```bash
pi install git:github.com/matdev83/pi-echoes-vault@vX.Y.Z
```

```bash
pi update --extensions                 # update packages; reconcile pinned git refs
pi update git:github.com/matdev83/pi-echoes-vault
pi remove git:github.com/matdev83/pi-echoes-vault   # add -l for project settings
pi list                                             # show installed packages
```

Peer runtime modules (`@earendil-works/pi-coding-agent`, `typebox`) are provided by Pi; you do not need a separate app install for those when running inside Pi.

## Release artifacts

Pushing a `v*` tag that matches `package.json` `version` runs `.github/workflows/release.yml`, which creates or updates a **GitHub Release** with an `npm pack` tarball and `SHA256SUMS`. Those assets are for **audit and offline verification** only.

**Pi installs the git repository / tag** (`https://github.com/...` or `git:github.com/...@vX.Y.Z`), not the Release tarball and not workflow run artifacts. Do not treat Actions artifacts as an install source.

## Usage

| Command | Purpose |
|---------|---------|
| `/echoes-init` | Bootstrap `EchoesVault/`, write `.pi/echoes-state.json`, activate, instruct the agent |
| `/echoes-start` | Mark session started; inject index + last 3 daily logs via `pi.sendUserMessage` |
| `/echoes-end` | Ask the agent to call `commit_memory_to_echoes_vault` |
| `/echoes-status` | Inject vault metrics + index/today log for a short health dashboard |
| `/echoes-doctor` | Bounded diagnostics: vault, config, lifecycle, recovery lock/transcript, and Git baseline |

### Automatic session lifecycle

When the extension is loaded and an `EchoesVault/` directory exists in the project, automatic behavior is enabled by default:

| Event | Behavior |
|-------|----------|
| `session_start` (`startup` / `new` / `resume` / `fork`) | Starts lifecycle tracking silently. Pending recovery may launch in an isolated SDK session; interactive restoration requires `/echoes-start`. |
| `session_start` (`reload`) | Refreshes stats only — does **not** re-inject start context |
| `session_before_switch` / `session_before_fork` | If the session is started and not yet saved, queues the existing `/echoes-end` prompt once and **cancels** the switch/fork so the model can commit. Retry after a successful commit (or after a failed end turn settles — see below). |
| `agent_settled` | If an end prompt was queued and the agent turn finished **without** `commit_memory_to_echoes_vault`, clears the in-flight end flag so a later switch or `/echoes-end` can retry. Does **not** auto-loop the end prompt. |
| `session_shutdown` (`quit`) | Never sends a model prompt (teardown would abort it). If unsaved, records `endPending` and the interrupted session transcript path for isolated recovery. |
| `session_shutdown` (`reload`) | No end-pending marker |

Successful `commit_memory_to_echoes_vault` is the authoritative “already saved” signal: it clears `endPending`, marks `saved`, and suppresses automatic end prompts.

Automatic session starts never inject EchoesVault messages or trigger an interactive model turn. On the first user-driven turn of a logical session, projects containing `EchoesVault/` add a bounded local Git snapshot as hidden context (repository/worktree, branch/HEAD, cached upstream ahead/behind, operation state, and staged/unstaged/untracked/conflicted counts). The snapshot is appended to the outgoing request as a genuine `role: "user"` message via the per-turn `context` event — never as a custom/non-standard message role — so strict inference providers that accept only `user`/`system` roles do not reject it. The injected message exists only in that request: it is not persisted to the session file, not shown in the UI, and never appears in transcripts or event streams. Changes are split into **project** work and **EchoesVault-managed** files; both are always reported, and a worktree dirty only under `EchoesVault/` is never described as clean. When the state differs from the last successful vault update, a structured offline delta is added (branch change, HEAD movement classified as advanced/rewound/diverged with up to five recent commits, cached-upstream movement, and newly changed/resolved paths). The baseline is captured **after** each commit's own vault writes, so the extension's own files do not create false "changed" reports; when nothing changed, the snapshot collapses to one line. Git context never fetches or uses the network. A logical session replacement (`/new`, `/resume`, `/fork`) re-injects a fresh snapshot once; no automatic turn is ever sent. Use `/echoes-start` for explicit interactive vault restoration (deduplicated per runtime). See [Configuration](#configuration) for opt-outs.

Interrupted-session recovery is narrower: only Pi launched in the same project folder may claim `endPending`. Recovery runs in a separate in-memory Pi SDK session with extension/context discovery disabled and only the EchoesVault commit tool enabled, so its transcript and instructions never enter the new interactive context. An atomic cross-process lock (`.pi/echoes-recovery.lock`) plus a persisted 30-minute lease guarantee a single worker per project; stale or dead-owner locks are reclaimed, failures release the claim for retry, and a successful commit clears `endPending` and the transcript reference. Calm, folder-specific UI notifications report start, success, and retry-later failure; they never enter model context.

Optionally, current-branch pull-request context can be enabled with `prContext: true`. It is fetched asynchronously via `gh` (never blocking the first turn or running `git fetch`), cached for 10 minutes, injected as hidden context on a later turn, and degrades silently when `gh`, auth, network, or a GitHub remote is unavailable.

State read-modify-write for lifecycle and commit is serialized **in-process** per cwd. Background recovery additionally uses an atomic **cross-process** lock (`.pi/echoes-recovery.lock`) with a stale lease so only one worker runs per project.

Vault creation is **not** triggered merely by loading the extension. Use `/echoes-init` for a fresh project. State-only `.pi/echoes-state.json` without `EchoesVault/index.md` does not enable auto-start. Manual `/echoes-end` (and `/echoes-start` / `/echoes-status`) on a project without a real vault notify you to run `/echoes-init` and do not create one.

Manual `/echoes-start` / `/echoes-end` after the automatic prompts are no-ops for that runtime (deduped via runtime-local start tracking and `endPromptSent` / in-flight end state).

If the agent is busy, prompts are queued with `deliverAs: "followUp"` and a brief `ctx.ui.notify` is shown when UI is available.

On before-switch/fork handler errors while a save is still needed, the transition is **cancelled defensively** rather than allowing an unsaved exit.

### Subagent and headless sessions

EchoesVault targets interactive main sessions. Pi subagents run as separate headless Pi processes, and injected steering messages break their agent loops, so the extension **disables itself completely** in such sessions — no tools, no commands, no event handlers, no state writes:

- **Load-time detection:** the extension registers nothing when it finds nested-session environment markers (`PI_SESSION_ID` / `PI_SESSION_FILE`, which Pi injects only into commands spawned by a parent session's bash tool) or non-interactive CLI flags (`--mode text|json|rpc`, `-p`, `--print`).
- **Runtime guard:** every handler and command additionally no-ops when the bound extension mode is not `tui` (covers SDK embeddings and piped-stdin print fallbacks that argv inspection cannot see).

A side effect: RPC-driven and print/JSON invocations never get vault automation, even when launched by hand. Run the interactive TUI in the project for full EchoesVault behavior.

### Configuration

All automatic behavior is opt-out per project via `.pi/echoes-config.json` (malformed JSON safely falls back to defaults and is reported by `/echoes-doctor`):

```json
{
  "automaticActions": true,
  "gitContext": true,
  "prContext": false
}
```

| Key | Default | Effect |
|-----|---------|--------|
| `automaticActions` | `true` | `false` disables **all** automatic lifecycle tracking, background recovery, Git context, and PR context. Manual commands still work. |
| `gitContext` | `true` | `false` disables only the first-turn local Git snapshot. |
| `prContext` | `false` | `true` opts in to asynchronous current-branch PR enrichment via `gh`. |

Precedence: `automaticActions: false` overrides `gitContext` and `prContext`.

### Verification recipes

- **Project vs vault dirtiness:** dirty a source file and an `EchoesVault/` file, start a fresh session, and ask the agent to report the supplied Git snapshot without running tools; both categories appear, and a vault-only change is never called clean.
- **Unchanged baseline:** run `/echoes-end`, exit, restart with no changes; the snapshot collapses to a single "matches the last vault update" line.
- **Opt-outs:** set `gitContext: false` (or `automaticActions: false`) and confirm no snapshot is supplied; remove it to restore.
- **Diagnostics:** run `/echoes-doctor` to inspect vault, config, lifecycle, recovery lock/transcript, and Git baseline state.
- **Recovery concurrency:** two simultaneous Pi starts in one project produce exactly one background worker (`.pi/echoes-recovery.lock`).
- **PR opt-in:** with `prContext: true` and `gh` authenticated, the current branch PR appears on a later turn; without `gh` it degrades silently (visible via `/echoes-doctor`).

### Tools (LLM-callable)

- `commit_memory_to_echoes_vault` — session wrap-up: daily summary, optional pages, index appends/updates (new pages require a matching index line)
- `echoes_append_to_daily_log` — mid-session scratchpad append
- `echoes_search_vault_pages` — bounded keyword search under `pages/`
- `echoes_create_or_update_page` — create/update a page; `indexDescription` required for new files

Activation is convention-based: the presence of an `EchoesVault/` directory enables the extension with no migration or initialization action required. `/echoes-init` remains available to create and bootstrap a vault. Session tracking is handled in command handlers and lifecycle hooks (not separate model tools).

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
