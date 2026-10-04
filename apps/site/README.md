# BANG! Codex Sites deployment and local acceptance

This folder contains the portable Sites Worker app. This document records the public T107 deployment and T106's local S01–S08 acceptance separately. The T106 run did not publish a Site or use remote D1; the public deployment below is a later step. The existing 97-case game baseline remains 95/97 with D06 and D18 NOT RUN.

## Public deployment

- Site: [뱅! 온라인 기본판](https://bang-online-ko.rkdwoals159.chatgpt.site/)
- Published: 2026-09-29; access mode: **public**; Codex Sites Worker with its managed D1 binding.
- Source: `99c2c41ad639295fd83601995c4498a0516e46e7`; saved Site version: **1**; Sites deployment: `appgdep_6abace1e94f48191b386cc77d1f97309`; status: **succeeded**.
- Live HTTP smoke: `/` and `/rooms/new` returned `200 text/html`; `/assets/cards/playing/01_bang.png` returned `200 image/png` (116,634 bytes); `GET /api/guest-sessions` returned `204`.
- No production room or match fixture was seeded. Full 4-player and 7-player browser games, result screens, reload/network recovery, and return-to-lobby are **NOT RUN**; S09 is partial and must not be read as a gameplay acceptance pass.
- Free tier limits currently include 100,000 Worker requests per day and 10 ms CPU per invocation, plus D1 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage. Daily Worker/D1 limits reset at 00:00 UTC; requests or D1 queries can fail after limits are reached. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [D1 free-tier enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

## Reproduce the local checks

Prerequisites are the repository's pinned workspace dependencies and Node.js 22.13 or newer. From the repository root, install with `pnpm install --frozen-lockfile` if needed. Ensure `127.0.0.1:8799` is free, then run this single command from `apps/site`:

```powershell
node e2e/run-sites-acceptance.mjs --base-url=http://127.0.0.1:8799
```

The runner records each command, exit status, test fixture/subtest, Worker HTTP check, and unrun assertion in [`apps/web/e2e/sites-results.json`](../web/e2e/sites-results.json). It runs the isolated Site Miniflare suites, existing web Sites-transport/route tests, Site typecheck/build, smoke-script syntax check, then starts a local Wrangler Worker after the build, performs HTTP checks, and stops that Worker process tree. The worker smoke exercises unauthenticated/session HTTP, direct paths and static resources, plus 4P and 7P guest/create/join/ready/start, viewer sync, one legal `END_TURN`, exact receipt replay, SSE allowlist/reconnect, and guest restore. It uses generated local guest/session data; `.wrangler/t106-state` is local generated D1 state retained for potential Worker restart/recovery follow-up. To use another port, pass a loopback HTTP URL with `--base-url`; the runner rejects non-loopback URLs.

The Worker serves direct paths through the Site catch-all; T106 observed HTTP 200 for `/`, `/rooms/t106-direct-route`, the Korean card PNG, and the favicon. Root's CUA check used one in-app browser context/profile, opening `/` and `/rooms/new` in separate tabs; it observed home navigation and guest name/continue controls. This is route smoke only. It is not a browser game-flow pass.

## Evidence limits

The live Worker HTTP scenarios cover both 4P and 7P room/match fixtures, but the complete 4P and 7P browser UI flows remain NOT RUN: create/join/readiness/start through the UI, turn and response chains, elimination, result, browser reconnection, and return-to-lobby were not completed. Root had one accessible in-app browser context/profile for `/` and `/rooms/new`; independent browser cookie contexts were unavailable. Local Worker-process restart recovery and scanning all Worker/browser logs for secret sentinels also remain NOT RUN. See the assertion-level S01–S08 records in the result JSON and [`06_ACCEPTANCE_TESTS.md`](../../outputs/development-plan/06_ACCEPTANCE_TESTS.md).

## Latest recorded run

The final T106 run completed **29 PASS / 0 FAIL / 6 NOT RUN** across 35 assertions: Site Miniflare tests **35/35**, web Sites transport/route tests **20/20**, Site typecheck/build, Worker startup, local HTTP smoke, and Worker shutdown all passed. S01 and S04 are fully PASS; S02, S03, S05, S06, S07, and S08 are PARTIAL because their explicitly listed unrun assertions were not promoted. The direct Worker smoke recorded `GET /assets/cards/playing/01_bang.png` as `200 image/png` (116,634 bytes), `GET /favicon.svg` as `200 image/svg+xml`, and an unknown API path as safe JSON 404. The process launched by the runner has stopped; `127.0.0.1:8799` is free. Full browser 4P/7P play and real Worker restart recovery remain NOT RUN. Existing 95/97, D06, and D18 are unchanged.


## UI/API follow-up — 2026-10-04

Local implementation and verification completed: 235 automated tests PASS, types/build PASS, complete local 4P/7P Worker HTTP games and mobile/desktop browser UI checks. See [implementation report](../../outputs/review-2026-10-04/IMPLEMENTATION_REPORT.md). Original 95/97 and D06/D18 NOT RUN remain unchanged.

The same public Site version 2 was saved from pushed source 5e21250692e825e58cc085074da85543f0d2b63a, but publication FAILED on initial table creation: command_receipts already exists. This update is not confirmed live. Existing application migration ledger has initial version 1 applied; platform migration history must be reconciled before retry. Applied initial SQL and production data were preserved. T116 remains IN_PROGRESS. See [deployment evidence](../../outputs/review-2026-10-04/deployment-result.json).


## Platform baseline recovery

The specifically failed initial platform CREATE SQL uses IF NOT EXISTS to adopt the legacy schema. The exact applied application SQL is preserved in db/legacy with its original SHA-256. Request-time initialization now checks schema readiness only. No production table or existing application ledger is dropped or overwritten. Local preparation is explicit: build, then pnpm --filter @bang/site db:local before start. The local migration command always uses --local. Full regression: 239/239 PASS, including 4 new preservation/readiness tests; check/build and Drizzle check PASS. Final publish outcome is recorded separately.
