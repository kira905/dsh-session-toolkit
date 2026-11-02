# dsh-session-toolkit

> ### What this is
> **A handoff toolkit for long sessions**: collect the facts of a half-finished task into a document another session can pick up.
>
> ### What it solves
> Context is finite. The longer a session runs, the more likely it forgets early details — until it either crashes or starts drifting. This does not "summarise"; it **collects facts**: goal, acceptance criteria, progress, remaining list, where each rule came from — kept verbatim, with only the two cells that should change being updated. **Better long than missing the target.**
>
> ### Run it in one command
> ```powershell
> npm i -g @kira905/dsh-session-toolkit
> dsh-context-check          # how much context this session has used (same source as the ring in the GUI)
> dsh-session-tail <id>      # session tail, ready for the next session to read
> ```
>
> ### Real output
> ```text
> Usage
>   dsh-context-check [--session <id>] [--threshold 300000] [--json] [--all]
>
> How much context this session has used (same source as the ring next to the input box);
> close to the threshold means it is time to hand the work over to a new session.
> ```
>
> Install steps and three read-only self-checks are below.

---

[中文](README.md) · English (this file)

Thirteen read-only, re-runnable tools extracted from the "**how does a long session hand itself over
to the next session / the next machine, safely**" pipeline, generalized and published as a repo.

> **This is not a plugin** and not an application: it is a set of **Node.js scripts** with
> **zero third-party dependencies** — six top-level modules (five of them ship a CLI) plus seven
> shared libs, all of which speak the **DSH directory conventions** and can be run standalone or
> imported by other scripts.

---

## Design basis

This repository is one implementation of the system described by the
**ops-handoff-design** documentation repository:

- **Why it exists and where its boundary is** → *Long-conversation handoff and relay*
  **§3.2** (the seven-section structure contract), **§3.3** (forbidden-content list),
  **§5** (the relay action chain and its ordering rules), **§8.4** (three separate budgets).
- **How a session crosses between machines** → *Multi-machine handoff and cloud relay*
  **§4.2** (the landing layer: five actions).
- **Where session-lifecycle autonomy stops** → *Autonomous operations steward* **§2**
  (session lifecycle coverage matrix) and *System overview and house rules* **§3.8**.

Documentation repository: [Gitee](https://gitee.com/kira905/ops-handoff-design) ·
[GitHub](https://github.com/kira905/ops-handoff-design). The component index lives in that repo's
*Release notes* **§4.5**, where this repository occupies one row.

---

## 1. The thirteen pieces

(Added in v0.1.1: the `context-check` / `session-axis-set` / `archive-inactive-sessions` entry points
and the four shared libs they depend on. See the `v0.1.1` section of the [CHANGELOG](./CHANGELOG.md).)

| Module | Role | Reads / writes |
|---|---|---|
| `src/relay-facts.mjs` | **Handoff fact collector**: turns "what this leg did, what is still open" into machine-checkable material — board ledger cards and executions, changelog tail, files this session wrote, a 7-day scan of handoff docs. Also renders the *degraded fact sheet* used when no model is available. | **Read-only** |
| `src/session-tail-for-llm.mjs` | **Session tail, rendered for a model**: multi-frame zstd decoding, the last N turns with event types and turn boundaries (no 200-char truncation), under a **hard budget** (I/O ≤ 2 MB, decode ≤ 3 s). | **Read-only**; ships a CLI |
| `src/dsh-sessions-land.mjs` | **Session landing orchestration**: lands sessions that exist in another instance/another machine. It performs the *judgements* (is the checkout still encrypted, was the output degraded, was the pull non-fast-forward, "last run was fine and the repo HEAD has not moved → skip") and delegates the actual pull/merge to the script you pass via `--ps`. | Read-only judgements + **bookkeeping**; ships a CLI |
| `src/lib/dsh-home.mjs` | The **single resolution point** for instance home / workspace root / report directory (injectable via arguments and environment). | Reads env |
| `src/lib/session-file-name.mjs` | The **source of truth for session log file names** (all generations: legacy name and `session.vN` names). | No I/O |
| `src/lib/sessions-land-skip.mjs` | The "skip landing" decision as a **pure function**, plus atomic state-file I/O. | Reads/writes one state file |
| `src/context-check.mjs` | **Context-pressure check**: reads the session projection (`contextPressure`) through the host RPC and reports current / all sessions against a threshold — the "time to hand over" signal. | **Read-only** (RPC only); ships a CLI |
| `src/session-axis-set.mjs` | **Relay-axis marks**: sets or changes a session title's `【续】` / `【已交接】` axis (via `session.rename`, the same path the relay chain uses); `--self-test` runs pure functions plus a fake server, zero production writes. | RPC only, no files; ships a CLI |
| `src/archive-inactive-sessions.mjs` | **Inactive-session archiving**: moves whole session directories (older than 48 h, no unclosed turn) into `<DSH_HOME>/_archived-sessions/` — **never deletes**, writes a manifest, verifies every generation byte-for-byte before removing the source. `--synced-only` archives only sessions already synced to a replica repo. | Moves directories + manifest + metadata store; ships a CLI |
| `src/lib/dsh-rpc-client.mjs` | **Host HTTP RPC client** (publishable): endpoint table, new/legacy dual-stack fallback, adaptive wire names. Cookie sources: explicit argument / environment / optional host credential module (absent in public environments ⇒ no credential). | HTTP only — reads no files, touches no home directory |
| `src/lib/archive-meta-store.mjs` | **Archive metadata store** (accelerating cache, not a source of truth): atomic write, cross-process lock, fail-closed on corruption, `.bak` rotation, three-state `turns` semantics (real count / real zero / unknown). | Reads/writes one JSON store (`<archive root>/archive-meta.json`) |
| `src/lib/projcache-read.mjs` | **Single read/write policy for `session_projcache`**: sharded layout first, legacy single file as fallback, both key spellings accepted; never creates directories on the read path. | Mostly read (plus same-address atomic write helpers) |
| `src/lib/zstd-frames.mjs` | **zstd multi-frame splitting** (strict frame-structure parsing): complete frame boundaries; a torn tail frame yields `tornStart` instead of a guess. | No I/O (pure) |

> The four added libs (`dsh-rpc-client` plus the three archive helpers) are the dependency closure of
> the three entry points and can also be imported on their own. `dsh-rpc-client` is kept **separate**
> from the host-only credential module: the public module hard-codes no credential path and simply
> has no credential where the host module is absent.

**Why the landing action itself is not here**: it is "merge the session directories of a git
repository into this machine", which is inseparable from *your* sync script — encrypted-checkout
unlocking, merge policy, path habits. So this repo ships the **judgement and the bookkeeping**,
which is the half that is most often written incorrectly and the most worth reusing.

---

## Shared-source notice

Some files in this repository **share a source with an internal production implementation**
(the same engineering effort, evolved over time, with two landing places).

- **How much**: measured by the **line-level shared-source ratio** (among same-named comparable files, how
  many non-empty lines of this repository's files are found in the reference files, multiset-deducted); this
  repository's "≥50% line-share" figure is **100%**.
- **What that means**: this repository is a **distilled export** of that implementation — **neither a verbatim
  copy nor a fully rewritten independent implementation**. Before reading any single file as an "independent
  reference implementation", run the check below.
- **How to re-run it**: the shared-source scanner ships with `dsh-quality-toolkit` as `dsh-sim-scan.mjs`
  (`--repo <this repo> --prod-root <reference root>`); the bucket thresholds and the measurement caliber live
  in its `config/sim-scan.json`, not buried in code.
- **License**: see `LICENSE` at the repository root (when a subdirectory carries its own exception, that
  subdirectory's `LICENSE` wins).

## 2. Runtime and host compatibility

| Item | Value |
|---|---|
| Runtime | **Node.js ≥ 20** (`engines.node`) |
| Dependencies | **None** — only `node:fs` / `node:path` / `node:os` / `node:zlib` / `node:child_process` / `node:url` |
| Host peer dependency | **Declared: none** |
| Host version tested | **`0.2.0-rc.2`** — the six v0.1.0 modules were smoke-tested on this single host version. The v0.1.1 entry points got an **isolated fixture smoke test** only (no live host run). Other versions are **untested and not promised**. |

**Why no host peer dependency**: a peer declaration says "my code is *loaded by* this version of
the host" — which is true for plugins that the host assembles and that import host packages.
None of the modules here is loaded through the host assembly chain, and none imports a host
package: they are standalone processes that only speak **directory conventions and file formats**.
The real compatibility surface is therefore the conventions below, and a peer range would send the
wrong signal ("a version mismatch means it cannot work") when the actual criterion is whether the
conventions and formats line up.

### The interface surface these modules depend on

| Purpose | Convention |
|---|---|
| Instance home | Environment variable `DSH_HOME`; falls back to `~/.dsh`. The legacy private name `BUTLER_DSH_HOME` is kept as a one-time compatibility read. |
| Live sessions | `<DSH_HOME>/sessions/…`, log name `session.vN.jsonl.zstd` (all generations accepted; never compare exact file names) |
| Archived sessions | `<DSH_HOME>/_archived-sessions/…` |
| Archive metadata store | `<archive root>/archive-meta.json` (**accelerating cache**; `.bak` files land in `<DSH_HOME>/backups/archive-meta/`, redirectable via `ARCHIVE_META_BACKUP_DIR`) |
| Projection cache | `<DSH_HOME>/storages/session_projcache/sessions/<key>.json` (sharded) ∪ `<DSH_HOME>/storages/session_projcache.json` (legacy single file) |
| Board ledger | `<DSH_HOME>/task-board/ledger-v2.json` (`tasks[]` preferred, `cards[]` tolerated) |
| Workspace tree | Environment variable `DSH_WORKSPACE` (or derived from a redirected home); `<workspace>/docs` and `<workspace>/docs/变更流水` are used |
| Host RPC | `POST http://<host>:<port>/api/<ns>/<method>` (0.1.5+ path-segment form), cookie-authenticated, with automatic fallback to the legacy dotted form |

---

## 3. Install

The package is published on npm as **`@kira905/dsh-session-toolkit`** (zero dependencies). Two routes:

```bash
# Route A (recommended): npm — installs the command-line entries
#   dsh-session-tail / dsh-sessions-land / dsh-context-check / dsh-session-axis-set / dsh-archive-inactive
npm install -g @kira905/dsh-session-toolkit
# Used as a library? Install it locally: npm install @kira905/dsh-session-toolkit
#   then import '@kira905/dsh-session-toolkit/context-check' and the other subpaths

# Route B: clone from git (reading the source / offline)
git clone https://gitee.com/kira905/dsh-session-toolkit.git
# or https://github.com/kira905/dsh-session-toolkit.git
cd dsh-session-toolkit
node --check src/relay-facts.mjs        # per-file syntax check; `npm run check` covers every module
```

---

## 4. Usage

### 4.1 `session-tail-for-llm.mjs` — session tail for a model

```bash
node src/session-tail-for-llm.mjs <session-id> [--turns N] [--max-bytes N] [--budget-ms N] [--home <DSH home>] [--json]
```

- `--turns` (default 4); `--max-bytes` (default 2 MB) and `--budget-ms` (default 3000) are **hard
  budgets** — on overflow the result carries `budgetTruncated=true` and names the budget that blew,
  instead of silently returning half a file.
- Exit codes: `0` read; `1` not read (`reason` says why); `2` usage error.

Library: `readSessionTail({ sessionId, maxTurns, maxBytes, budgetMs, home })` ·
`findSessionFile(sessionId, { home, roots })` · `isMainEntry(argv1)`.

### 4.2 `dsh-sessions-land.mjs` — session landing (orchestration)

```bash
node src/dsh-sessions-land.mjs [--json] [--dry-run] [--verbose] [--no-skip]
  --repo <sessions repo dir> --ps <your-pull-script.ps1>
  [--sessions-dir <dir>] [--archive-dir <dir>] [--timeout-ms <n>]
  [--state-file <path>] [--max-age-ms <n>]
```

- **`--repo` and `--ps` are mandatory** (environment equivalents: `DSH_SESSIONS_REPO`,
  `DSH_SESSIONS_LAND_PS`). This repo bakes in no local path; without them it exits **rc=2**
  rather than guessing a directory.
- `--dry-run` judges and previews without invoking the pull script; `--no-skip` disables the
  "unchanged HEAD → skip" shortcut; `--state-file` injects the state file path (test isolation).

**Exit codes** (diagnostic only — prefer the `reason` field of the `--json` output):
`0` ok · `4` repo checkout not unlocked (ciphertext detected, landing **refused**) ·
`5` degraded output · `6` unparsable output · `7` non-fast-forward pull ·
`8` script missing / spawn failed / timeout · `9` repo busy · `2` usage error (includes
missing `--repo` / `--ps`).

Library: `run(argv)` · `land(opts)` · `parseCounts(stdout)` · `findDegradedMarker(stdout)` · `DEFAULTS`.

### 4.3 `relay-facts.mjs` — handoff facts (library, no CLI)

```js
import { collectFacts, renderFactsForPrompt, renderFactSheet, factSheetPath } from './src/relay-facts.mjs'

const facts = collectFacts({
  sourceSessionId: '<session-id>',
  home: '<DSH home>',                 // or set DSH_HOME
  docsDir: '<workspace>/docs',        // defaults to $DSH_WORKSPACE/docs
  changelogDir: '<workspace>/docs/变更流水',
  now: Date.now(),
})
console.log(renderFactsForPrompt(facts))
```

Main exports: `collectFacts` · `renderFactsForPrompt` · `renderFactSections(facts, opts)` ·
`renderFactSheet(facts, opts)` · `factSheetPath(mainline, opts)` · `readBoardCards` ·
`readChangelogTail` · `scanHandoffDocs` · `extractTouchedFiles` · `buildCardExecutorIndex` ·
`collectInFlightCards` · `findCardForSession`. Every path is injectable through `opts.*`, so tests
can be fully isolated from production paths.

### 4.4 `lib/dsh-home.mjs` — the single authority for path resolution

```js
import { resolveDshHome, resolveDshWorkspace, resolveReportDir, resolveChangelogDir } from './src/lib/dsh-home.mjs'

resolveDshHome()        // explicit arg > $DSH_HOME > (legacy name) > ~/.dsh
resolveDshWorkspace()   // explicit arg > $DSH_WORKSPACE > derived from a redirected home
                        // otherwise it THROWS — no machine-specific default ships here
```

> The private original carried a hard-coded workspace constant (`DEFAULT_DSH_WORKSPACE`); this
> release **removes** it (see CHANGELOG). Failure is explicit, never a silent fallback to some
> directory on disk.

### 4.5 `lib/session-file-name.mjs` — session log file-name predicate

```js
import { isSessionFileName, sessionFileGeneration, rankSessionFilesInDir, SESSION_FILE_NAME_CURRENT } from './src/lib/session-file-name.mjs'
```

Three rules are fixed: (1) readers use the predicates, never exact string comparison;
(2) generations are extracted from the file name, never hard-coded; (3) writers use
`SESSION_FILE_NAME_CURRENT`. Anything that reads **content** must use the candidate chain
(`rankSessionFilesInDir` / `collectSessionFilesByDir`, `.files`).

### 4.6 `lib/sessions-land-skip.mjs` — skip-landing decision

```js
import { resolveSkipStatePath, readSkipState, writeSkipState, makeSkipState, shouldSkipLanding } from './src/lib/sessions-land-skip.mjs'

const state = readSkipState(resolveSkipStatePath())
shouldSkipLanding({ state, repoHead, localCount, now, maxAgeMs, enabled })
```

Fail-safe by construction: anything unjudgeable (missing/corrupt state, clock going backwards,
unknown local count) means **do not skip**.

### 4.7 `context-check.mjs` — context-pressure check

```bash
node src/context-check.mjs                     # current session (reads DSH_SESSION_ID)
node src/context-check.mjs --threshold 300000  # custom threshold (default 300000)
node src/context-check.mjs --json              # machine-readable
node src/context-check.mjs --session <id>      # a specific session
node src/context-check.mjs --all               # every session, sorted by usage
```

- Data source: the `contextPressure` projection of the host's `session.list` (the same numbers the
  GUI ring shows).
- Exit codes: `0` under threshold · `7` **over threshold** (time to hand over) · `2` session not
  found / service unavailable.
- Endpoint from `DSH_WEB_URL` (default `http://127.0.0.1:3080`).

### 4.8 `session-axis-set.mjs` — relay-axis marks

```bash
node src/session-axis-set.mjs --session <sid> --axis 续 --base "<mainline>"          # dry-run by default
node src/session-axis-set.mjs --session <sid> --axis 续 --base "<mainline>" --apply  # really write
node src/session-axis-set.mjs --self-test                                            # fake server, zero writes
```

- Calls `session.rename` only: no files, no ledger, no new sessions.
- Without `--base` the base name is derived by stripping known axis prefixes; if nothing remains it
  **refuses to write**.
- Exit codes: `0` written / idempotent skip · `1` call failed · `2` usage error · `3` session not in
  the list (write refused).

### 4.9 `archive-inactive-sessions.mjs` — inactive-session archiving

```bash
node src/archive-inactive-sessions.mjs --dry-run                # preview, move nothing
node src/archive-inactive-sessions.mjs                          # move (>48 h inactive, no unclosed turn)
node src/archive-inactive-sessions.mjs --min-size-mb 1          # only sessions ≥ 1 MB
node src/archive-inactive-sessions.mjs --include-empty          # include empty shells
node src/archive-inactive-sessions.mjs --sess-root=<dir>        # alternative scan root (testing)
node src/archive-inactive-sessions.mjs --synced-only --synced-repo=<dir>  # only already-synced ones
```

- **Never deletes**: copies the whole session directory (all generations), verifies every file by
  sha256, only then removes the source; writes `manifest.json` for restore.
- Empty-shell sessions (no user/assistant message at all) are skipped by default.
- `--synced-only` **requires** `--synced-repo` (no machine-specific default ships here; missing it is
  **fail-closed — nothing is archived**, rc=3).
- Exit codes: `0` ok / dry-run · `3` fail-closed (running-session list unavailable, or
  `--synced-repo` missing).

### 4.10 `lib/dsh-rpc-client.mjs` — host RPC client (library)

```js
import { hostRpc, hostRpcValue, hostCookie, detectStack } from './src/lib/dsh-rpc-client.mjs'

const { status, body } = await hostRpc('http://127.0.0.1:3080', 'session.list', {})
```

- Works against both 0.1.4 (dotted endpoints) and 0.1.5+ (path segments + `args` envelope); the wire
  argument name is learned from the error response when it differs.
- Cookie sources: (1) `hostCookie(base, { cookieSecret })`, (2) `DSH_RPC_COOKIE_SECRET`, (3) an
  **optional** host credential module — absent in public environments, which simply means "no
  credential". **This module reads no files and touches no home directory.**
- Exports: `hostRpc` / `hostRpcJson` / `hostRpcValue` / `hostCookie` / `clearCookieCache` /
  `detectStack` / `ENDPOINT_TABLE` / `REMOVED_ENDPOINTS`.

### 4.11–4.13 The three archive shared libs

- `lib/archive-meta-store.mjs`: `upsertMany` / `setState` / `readStore` / `recoverFromBackup` and
  friends. The store is an **accelerating cache, not a source of truth**; on corruption the write
  path fails closed; three `.bak` copies are kept.
- `lib/projcache-read.mjs`: `projcacheSessionsTable` / `lookupProjcacheRecord` (sharded layout first,
  legacy single file as fallback). **Update `PROJCACHE_SHARD_KNOWN_VERSIONS` when the host changes
  generation.**
- `lib/zstd-frames.mjs`: `scanZstdFrames(buffer)` → `{ frames, tornStart }`; torn frames are dropped,
  never guessed.

---

## 5. Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DSH_HOME` | Instance home | `~/.dsh` |
| `BUTLER_DSH_HOME` | Legacy private name, **compatibility read** (used only when `DSH_HOME` is unset) | — |
| `DSH_WORKSPACE` | Workspace root (the tree holding `docs/`) | derived from a redirected home, else **error** |
| `DSH_SESSIONS_REPO` | Sessions repository directory (lander) | none, mandatory |
| `DSH_SESSIONS_LAND_PS` | Pull script path (lander) | none, mandatory |
| `DSH_SESSIONS_DIR` / `DSH_ARCHIVE_DIR` | Live / archived session directories | `<DSH_HOME>/sessions`, `<DSH_HOME>/_archived-sessions` |
| `DSH_SESSIONS_LAND_STATE` | State file for the skip decision | `<DSH_HOME>/sessions-land.json` |
| `DSH_WEB_URL` | Host web endpoint (`context-check`) | `http://127.0.0.1:3080` |
| `DSH_BASE_URL` | Host web endpoint (`session-axis-set`) | `http://localhost:3080` |
| `DSH_HOST_API_URL` | Host web endpoint (`archive-inactive`, running-session query) | `http://localhost:3080` |
| `DSH_RPC_COOKIE_SECRET` | Cookie signing secret for host RPC (base64, 32 bytes); falls back to the host credential module, else "no credential" | — |
| `ARCHIVE_META_BACKUP_DIR` | Where the archive store keeps its `.bak` files (testing / isolation) | `<DSH_HOME>/backups/archive-meta` |

Windows (cmd): `set DSH_HOME=%USERPROFILE%\.dsh` · `set DSH_WORKSPACE=<workspace root>`.
POSIX (bash): `export DSH_HOME=~/.dsh` · `export DSH_WORKSPACE=~/dsh`.

---

## 6. License

**AGPL-3.0-only + a commercial license (dual licensing)** — see [LICENSE](./LICENSE).

Use and modification are free for individuals, learning and open-source projects. If you need it
in a **closed-source** or **commercial** setting, a **commercial license** is available — this
repository has no public contact address yet, so **please open an issue**.

> **Terminology note**: **AGPL-3.0 does not forbid commercial use** — it requires derivative works
> to be open-sourced as well. "Either comply with the AGPL or obtain a commercial license" is what
> dual licensing means here.

---

## 7. Repository layout

```
dsh-session-toolkit/
├─ src/
│  ├─ relay-facts.mjs            handoff fact collector (library)
│  ├─ session-tail-for-llm.mjs   session tail for models (library + CLI)
│  ├─ dsh-sessions-land.mjs      session landing orchestration (library + CLI)
│  ├─ context-check.mjs          context-pressure check (CLI)
│  ├─ session-axis-set.mjs       relay-axis marks (CLI)
│  ├─ archive-inactive-sessions.mjs  inactive-session archiving (CLI)
│  └─ lib/
│     ├─ dsh-home.mjs            home / workspace resolution authority
│     ├─ session-file-name.mjs   session log file-name truth source
│     ├─ sessions-land-skip.mjs  skip decision + state file
│     ├─ dsh-rpc-client.mjs      host RPC client (publishable)
│     ├─ archive-meta-store.mjs  archive metadata store (cache + lock + atomic write)
│     ├─ projcache-read.mjs      single policy for projcache reads/writes
│     └─ zstd-frames.mjs         zstd multi-frame splitting (strict parsing)
├─ CHANGELOG.md
├─ LICENSE            full AGPL-3.0 text + commercial-license section
├─ README.md / README.en.md
└─ package.json
```

---

## 8. Known limitations (stated honestly)

- `dsh-sessions-land.mjs` does **not** include the pull/merge script (see §1); you supply it via `--ps`.
- These tools target an **existing DSH directory layout**; they are not general-purpose
  "session file processing" libraries.
- Decoding covers the **multi-frame zstd** form of DSH session logs; a different container format
  means editing `session-tail-for-llm.mjs`.
- This release was smoke-tested on **one host version** (§2); no cross-version matrix was run.
- `archive-inactive-sessions.mjs --synced-only` **requires** `--synced-repo`: no machine-specific
  default ships here, and a missing argument fails closed (nothing is archived).
- `lib/dsh-rpc-client.mjs` carries **no built-in credential** in a public environment. Features that
  need host RPC (`context-check`, `session-axis-set`, the running-session query behind
  `--synced-only`) require an explicit `cookieSecret` or `DSH_RPC_COOKIE_SECRET`; without one they
  **fail loudly** instead of silently returning empty results.
- `lib/archive-meta-store.mjs` is an **accelerating cache**, not a source of truth; on a corrupt store
  the write path fails closed (no overwrite) and `recoverFromBackup()` restores from a `.bak`.
