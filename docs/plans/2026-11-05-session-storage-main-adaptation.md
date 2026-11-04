# JSONL persistence adaptation to current upstream

This merges `aipoch/open-science` main at `4525352c7b9563345528c12b3e702be38e124509`, then incorporates its final refreshed head `495361a2b1103170a8240ef59d4b8ff93529c17f`, into `fengdwx/open-science:fix/session-storage-incremental` (previous tip `17b32d104`). The work and downloads started on 2026-11-04; validation finished on 2026-11-05, Asia/Shanghai. No upstream PR is submitted by this change.

## Compatibility and retained behavior

- Upstream already owns migrations 0051–0054. New databases use `0055_session_history`. The exact released Fork ledger ending in `0051_session_history` is recognized by its frozen checksum and complete prefix. A database backup is taken before changing that ledger; existing history rows are retained, upstream migrations run, and 0055 adopts the tables. Modified, incomplete or unknown Fork ledgers are rejected. Interrupted upgrade and retry are covered.
- New sessions use JSONL; existing JSON sessions remain JSON and return complete history without building a pagination index. Imported packages retain provenance and read-only research content; their writable forks can continue.
- Paginated display content is hydrated before edits, continuation and recovery. Recovery bypasses cached authority and detects replacement/invalidation while loading. Branched conversations retain complete graph navigation.
- Upstream use-case commands, diagnostics, recovery-file deletion, admission/Stop handling, scoped tool identities and scrolling behavior are retained. Recovery deletion also rejects replacement JSONL and unfinished publication files. The existing E2E fault injector now recognizes JSONL snapshots and append updates.
- All eight locale catalogs were merged, and the i18n guard passed. New files are registered with upstream module ownership and dependency checks.

## Current official samples

The official [gallery](https://aipoch.com/open-science/use-cases) and its [download manifest](https://statics.aipoch.com/open-science/usecases/manifest.json) were checked after basic tests passed. The downloaded manifest contained 136 cases (the retrieved gallery snapshot displayed 135). Its SHA-256 is `c970051d4f78ebc83f2d9d202d60c97b4b553f88e1f2b3d167c0199da99cf97b`.

| Case                                                                                                       | Downloaded at (UTC+08:00) |     Bytes | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------- | --------: | ------------------------------------------------------------------ |
| [Investment comparison](https://aipoch.com/open-science/use-cases/10-000-nvidia-bitcoin-or-both)           | 2026-11-04 23:47:19       |   653,867 | `b260f774af1190f7a4e5dee5495aa8cd55d180bf7a18781c7c5fae995a3fcf8d` |
| [Molecular handedness](https://aipoch.com/open-science/use-cases/99-pure-does-molecular-handedness-matter) | 2026-11-04 23:47:22       |   725,418 | `32905d517617c013333224e29049e8b7e4212d2061070c37c38a336561af84e9` |
| [Century rainfall](https://aipoch.com/open-science/use-cases/a-city-s-100-year-rainfall-record)            | 2026-11-04 23:47:26       | 8,186,696 | `2817a64e416c0003d790c23c00745f0d4289d0acc48698213eb89f6b062eefc8` |

All three sizes and hashes matched the current manifest and the previously recorded sample hashes. Results below were measured again, with no old performance numbers reused. Exact download URLs and timestamps are in the adjacent [results JSON](2026-11-05-session-storage-main-adaptation-results.json).

The current catalog also has a distinct “Chiral Molecules - Can a 0.1% Lead Take Over” case and newer astronomy/AI examples. The three requested cases were retained for this bounded run: their imported histories contain 8/6/19 messages and 27/9/140 tool records. The rainfall case exercises multiple display pages without downloading substantially larger cases. No larger stress test was needed after this validation passed.

## Real-data validation and matched comparison

Both current upstream and the candidate separately inspect, import and fork each freshly downloaded archive into isolated roots. Candidate imports and forks physically create JSONL. The benchmark then clones the same upstream-created seed for each version, retaining identical IDs, timestamps and historical content. Only the candidate benchmark copy is initialized as a JSONL snapshot, outside the measured continuation. This initialization is a test fixture, not an automatic product migration of old JSON files.

One synthetic 32 KiB reply is appended through the real `RuntimeSessionOwner`. All 192 input batches are retained but grouped into four flushes, plus prompt, admission and terminal commits: **7 commits per case per version**. No package Notebook, script, tool, model call or shell command is executed. The history's recorded tool results are only data.

| Case       | Upstream JSON session-file writes | Candidate JSONL session-file writes | Reduction | Display items / pages |
| ---------- | --------------------------------: | ----------------------------------: | --------: | --------------------: |
| Investment |                       2,195,315 B |                           285,674 B |     87.0% |                37 / 1 |
| Handedness |                       1,203,471 B |                           242,422 B |     79.9% |                17 / 1 |
| Rainfall   |                       4,487,472 B |                           252,237 B |     94.4% |               161 / 3 |

For all three cases, the complete final canonical document and business SQLite digest match between versions. Separate fresh processes reopen the saved sessions and verify both digests. Pagination checks compare every returned message, tool record, contextual prompt, group and artifact against an independent oracle; all pages terminate correctly. The upstream baseline loads once and slices resident history for the display comparison, while the candidate uses the native history-page API.

These are single-run smoke measurements with coarse 24-second virtual flush groups, warm OS cache, and no scheduler sleeps. They establish correctness and session-file byte reduction under this workload; they do not establish production latency or SSD endurance. Session-file byte counts include the seven commits only, excluding fixture initialization, SQLite, history indexes and imported-title control writes. Per-process I/O accounting below has a broader scope.

## Reproduction

Use the same downloaded archives and hashes for both versions. Build packages and generate the Prisma client first. `scripts/performance/official-science-seed.test.ts` accepts `OPEN_SCIENCE_OFFICIAL_SEED_SOURCE`, `OPEN_SCIENCE_OFFICIAL_SEED_ROOT`, and `OPEN_SCIENCE_OFFICIAL_SEED_REPORT` for isolated inspect/import/fork checks. Set `hashes.imported` and `hashes.fork` on each prepared seed to its corresponding `summary.canonicalDigest` and wrap the seeds as `{ "seeds": [...] }`.

For `src/main/session-persistence/official-science-runtime-storage.benchmark.test.ts`, use `OPEN_SCIENCE_RUNTIME_BATCHES_PER_FLUSH=48`, `OPEN_SCIENCE_RUNTIME_PHASE=write`, the matched seed JSON as `OPEN_SCIENCE_RUNTIME_INPUT`, and a report path as `OPEN_SCIENCE_RUNTIME_REPORT`. Use variant `original-json` on the pinned upstream checkout and `current-jsonl` on this branch. The baseline receives only the benchmark/helper files as test instrumentation; its production source is unchanged. Repeat with `PHASE=read`, `STAGE=fork`, then `PHASE=page`, `MODE=all`, selecting each `CASE` and using the write report as input. Each command is a fresh Vitest process with `--maxWorkers=1`.

Local raw logs, downloaded archives, seed metadata and I/O samples are retained under `.scratch/jsonl-validation-20261104/` and are not committed. No archive content is added to Git. The supplemental `jsonl-local-tests.patch` path supplied by the user was absent on this machine and could not be used; the existing branch tests and new regressions were used instead.

## Regression evidence

Checks were run against the merged production source. Initial failures are retained in local logs and paired with their corrective reruns; they are not silently counted as initially passing. The broad suites were not repeated after their specific failures passed, to avoid unnecessary database writes.

| Scope                                                                       | Evidence                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core journal, codecs and runtime reducer                                    | 6 files, 120 tests passed                                                                                                                                                          |
| Persistence and migrations                                                  | 76 files initially: 1,738 passed, 6 failed, 9 skipped; all six failures fixed and covered by the successful targeted rerun below                                                   |
| Renderer history, admission, recovery, scrolling and composer               | 16 files initially: 1,345 passed, 4 failed; all four fixed and covered by the targeted rerun                                                                                       |
| Targeted corrections, including i18n, recovery and JSONL fault injection    | 9 files, 1,000 tests passed                                                                                                                                                        |
| Additional database regression                                              | 38 files initially: 328 passed, 15 failed; moving-tail migration assertions corrected                                                                                              |
| Database corrections and application command composition                    | 6 files, 68 tests passed                                                                                                                                                           |
| Package import/fork, details, diagnostics, commands, preload and provenance | 51 files, 1,445 tests passed; the remaining command-composition suite initially could not import Electron, then passed after dependency installation in the preceding targeted run |
| Renderer session store                                                      | 333 passed; the additional facade guard passed after registering the two new consumers (targeted rerun: 1 passed)                                                                  |
| Architecture                                                                | Initial 8-file run: 76 passed, 2 failed; final host-layer/consumer-coverage run: 8 passed; boundary suite: 13 passed                                                               |
| Official archives                                                           | 6 independent import/fork runs, 2 matched write runs, 6 fresh-process reads and 6 all-page checks passed                                                                           |
| Real Electron                                                               | 5 passed, 0 skipped, 0 flaky: mixed legacy/new storage, linear pagination before continuation, branched JSONL, committed crash recovery, and in-flight partial-reply recovery      |
| Static/build checks                                                         | Node, sandbox and renderer typechecks; changed-source ESLint; i18n guard; database schema and web API map generation; module-consumer coverage; Electron/backend/web builds        |

The full repository-wide `npm test` and a native Windows test run were not performed. Headless service tests use the real official samples; Electron UI tests use controlled synthetic fixtures. The initial Electron and pinned Node downloads required retrying with `curl`; their pinned checksums were verified before use.

The final upstream refresh adds Windows process identity and installation-occupancy handling. Its diff changes no session storage, reducer, paging, package, schema or benchmark helper source. The matched comparison above remains explicitly pinned to `4525352c7`; focused upstream consumer tests and final typechecks cover the refresh.

The refreshed-upstream check completed with **5 files / 140 tests passed and 8 skipped** (platform-gated Windows cases). Pinned native components were refreshed and verified; final Node, sandbox and renderer typechecks passed.

## Validation disk writes

The monitored commands observed at least **15,657,738,240 bytes (15.66 GB)** written, including initial failed runs, corrective runs and measured builds. The real-case import/comparison/restore/page sequence accounts for **1,333,379,072 bytes (1.33 GB)**; the five Electron tests account for **246,390,784 bytes (0.25 GB)**. Most writes came from repeated temporary database construction in the broad migration/package suites.

The monitor sampled macOS `proc_pid_rusage` (`RUSAGE_INFO_V2`, `ri_diskio_byteswritten`) for each measured command and descendants every 200 ms, retaining the maximum per PID/start identity. This is a lower bound: brief processes or writes after the last sample can be missed. Dependency downloads/setup, unmonitored Git/lint/typecheck work and SSD firmware amplification are excluded. It is neither total machine writes nor a physical NAND-wear estimate. Per-run counts, timings and initial nonzero exit codes are retained in the results JSON.
