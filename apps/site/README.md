# BANG! Sites local acceptance

This folder contains the portable Sites Worker app. T106's supplemental S01–S08 acceptance is local-only and is separate from the existing 97-case game baseline. It does not create, publish, or deploy a Site, and it does not use a remote D1 database. The existing baseline remains 95/97 with D06 and D18 NOT RUN.

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
