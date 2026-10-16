# dsh-session-toolkit

[中文](README.md) · English (this file)

Six read-only, re-runnable tools extracted from the "**how does a long session hand itself over
to the next session / the next machine, safely**" pipeline, generalized and published as a repo.

> **This is not a plugin** and not an application: it is a set of **Node.js scripts** with
> **zero third-party dependencies** — three core modules plus three shared libs, all of which
> speak the **DSH directory conventions** and can be run standalone or imported by other scripts.

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

## 1. The six pieces

| Module | Role | Reads / writes |
|---|---|---|
| `src/relay-facts.mjs` | **Handoff fact collector**: turns "what this leg did, what is still open" into machine-checkable material — board ledger cards and executions, changelog tail, files this session wrote, a 7-day scan of handoff docs. Also renders the *degraded fact sheet* used when no model is available. | **Read-only** |
| `src/session-tail-for-llm.mjs` | **Session tail, rendered for a model**: multi-frame zstd decoding, the last N turns with event types and turn boundaries (no 200-char truncation), under a **hard budget** (I/O ≤ 2 MB, decode ≤ 3 s). | **Read-only**; ships a CLI |
| `src/dsh-sessions-land.mjs` | **Session landing orchestration**: lands sessions that exist in another instance/another machine. It performs the *judgements* (is the checkout still encrypted, was the output degraded, was the pull non-fast-forward, "last run was fine and the repo HEAD has not moved → skip") and delegates the actual pull/merge to the script you pass via `--ps`. | Read-only judgements + **bookkeeping**; ships a CLI |
| `src/lib/dsh-home.mjs` | The **single resolution point** for instance home / workspace root / report directory (injectable via arguments and environment). | Reads env |
| `src/lib/session-file-name.mjs` | The **source of truth for session log file names** (all generations: legacy name and `session.vN` names). | No I/O |
| `src/lib/sessions-land-skip.mjs` | The "skip landing" decision as a **pure function**, plus atomic state-file I/O. | Reads/writes one state file |

**Why the landing action itself is not here**: it is "merge the session directories of a git
repository into this machine", which is inseparable from *your* sync script — encrypted-checkout
unlocking, merge policy, path habits. So this repo ships the **judgement and the bookkeeping**,
which is the half that is most often written incorrectly and the most worth reusing.

---

## 2. Runtime and host compatibility

| Item | Value |
|---|---|
| Runtime | **Node.js ≥ 20** (`engines.node`) |
| Dependencies | **None** — only `node:fs` / `node:path` / `node:os` / `node:zlib` / `node:child_process` / `node:url` |
| Host peer dependency | **Declared: none** |
| Host version tested | **`0.2.0-rc.2`** — smoke-tested on this single host version at release time. Other versions are **untested and not promised**. |

**Why no host peer dependency**: a peer declaration says "my code is *loaded by* this version of
the host" — which is true for plugins that the host assembles and that import host packages.
None of the six modules here is loaded through the host assembly chain, and none imports a host
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
| Board ledger | `<DSH_HOME>/task-board/ledger-v2.json` (`tasks[]` preferred, `cards[]` tolerated) |
| Workspace tree | Environment variable `DSH_WORKSPACE` (or derived from a redirected home); `<workspace>/docs` and `<workspace>/docs/变更流水` are used |

---

## 3. Install

**Not published to npm.** Clone and run — there is nothing to install:

```bash
git clone https://gitee.com/kira905/dsh-session-toolkit.git
# or https://github.com/kira905/dsh-session-toolkit.git
cd dsh-session-toolkit
node --check src/relay-facts.mjs        # per-file syntax check; `npm run check` does all six
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
│  └─ lib/
│     ├─ dsh-home.mjs            home / workspace resolution authority
│     ├─ session-file-name.mjs   session log file-name truth source
│     └─ sessions-land-skip.mjs  skip decision + state file
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
