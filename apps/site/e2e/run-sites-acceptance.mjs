import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "../..");
const requestedBaseUrl = process.env.SITES_BASE_URL ?? process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length)
  ?? process.argv[process.argv.indexOf("--base-url") + 1]
  ?? "http://127.0.0.1:8799";
const parsedBaseUrl = new URL(requestedBaseUrl);
if (parsedBaseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedBaseUrl.hostname)) {
  throw new Error("T106 only accepts a loopback HTTP Worker URL.");
}
const baseUrl = parsedBaseUrl.origin;
const resultPath = path.join(repoRoot, "apps", "web", "e2e", "sites-results.json");
const commandResults = {};
let localWorker = null;
let localWorkerOutput = "";

try {
  const response = await fetch(new URL("/", baseUrl), { signal: AbortSignal.timeout(1_000) });
  throw new Error(`The local acceptance port is already serving HTTP ${response.status} at ${baseUrl}; stop that service before running T106.`);
} catch (error) {
  if (error instanceof Error && error.message.includes("already serving HTTP")) throw error;
}

function run(id, executable, args, cwd, options = {}) {
  const command = [executable, ...args].join(" ");
  console.log(`RUN ${id}: ${command}`);
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const tap = output.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/u);
  const checks = [...output.matchAll(/^(PASS|FAIL) ([\w.-]+): (.+)$/gmu)].map(([, status, checkId, detail]) => ({
    id: checkId,
    status,
    detail,
  }));
  const subtests = [...output.matchAll(/^# Subtest: (.+)$/gmu)].map(([, name]) => name);
  const exitCode = result.status ?? 1;
  const parsed = {
    command,
    cwd: path.relative(repoRoot, cwd) || ".",
    exitCode,
    status: exitCode === 0 ? "PASS" : "FAIL",
    ...(tap ? { tests: Number(tap[1]), passed: Number(tap[2]), failed: Number(tap[3]) } : {}),
    ...(checks.length ? { checks } : {}),
    ...(subtests.length ? { subtests } : {}),
    ...(result.error ? { error: result.error.message } : {}),
    outputTail: output.trim().slice(-4_000),
  };
  commandResults[id] = parsed;
  console.log(`RESULT ${id}: ${parsed.status}${parsed.tests === undefined ? "" : ` ${parsed.passed}/${parsed.tests}`}`);
  if (exitCode !== 0) console.error(parsed.outputTail);
  return parsed;
}

function liveCheck(id) {
  return commandResults.workerHttpSmoke?.checks?.find((check) => check.id === id);
}

function testAssertion(id, title, commandId, subtestName, detail) {
  const commandResult = commandResults[commandId];
  const matched = commandResult?.subtests?.includes(subtestName) === true;
  const commandPassed = commandResult?.status === "PASS" && matched;
  return {
    id,
    title,
    status: commandPassed ? "PASS" : "FAIL",
    command: commandResult?.command ?? "",
    fixture: subtestName,
    result: commandPassed ? `PASS; ${detail}` : `Expected passing subtest not present or command failed: ${detail}`,
  };
}

function liveAssertion(id, title, checkId, detail) {
  const checkIds = Array.isArray(checkId) ? checkId : [checkId];
  const checks = checkIds.map((id) => liveCheck(id));
  const successful = checks.length > 0 && checks.every((check) => check?.status === "PASS");
  return {
    id,
    title,
    status: successful ? "PASS" : "FAIL",
    command: commandResults.workerHttpSmoke?.command ?? "",
    fixture: checkIds.join(" + "),
    result: successful ? checks.map((check) => check.detail).join("; ") : checks.map((check, index) => `${checkIds[index]}: ${check?.detail ?? detail}`).join("; "),
  };
}

function notRun(id, title, reason) {
  return { id, title, status: "NOT RUN", command: null, fixture: null, result: reason };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendWorkerOutput(chunk) {
  localWorkerOutput = `${localWorkerOutput}${chunk}`.slice(-12_000);
}

async function startLocalWorker() {
  const workerUrl = new URL(baseUrl);
  const port = workerUrl.port || (workerUrl.protocol === "https:" ? "443" : "80");
  const args = [
    "--import", "./scripts/sites-env.mjs",
    "./node_modules/wrangler/bin/wrangler.js", "dev",
    "--config", "dist/server/wrangler.json",
    "--local", "--persist-to", ".wrangler/t106-state",
    "--ip", "127.0.0.1", "--inspector-port", "0", "--port", port,
  ];
  const command = [process.execPath, ...args].join(" ");
  console.log(`START localWorker: ${command}`);
  localWorkerOutput = "";
  try {
    localWorker = spawn(process.execPath, args, {
      cwd: siteRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    localWorker.stdout.on("data", appendWorkerOutput);
    localWorker.stderr.on("data", appendWorkerOutput);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (localWorker.exitCode !== null) throw new Error(`Wrangler exited with code ${localWorker.exitCode}.`);
      try {
        const response = await fetch(new URL("/", baseUrl));
        if (response.status === 200) {
          commandResults.localWorkerStart = {
            command,
            cwd: path.relative(repoRoot, siteRoot),
            exitCode: 0,
            status: "PASS",
            readyUrl: baseUrl,
            readyStatus: response.status,
            outputTail: localWorkerOutput.trim().slice(-4_000),
          };
          console.log(`RESULT localWorkerStart: PASS ${baseUrl} HTTP ${response.status}`);
          return true;
        }
      } catch {
        // The first loopback request can arrive before Wrangler finishes booting.
      }
      await wait(500);
    }
    throw new Error(`Timed out waiting for ${baseUrl} to return HTTP 200.`);
  } catch (error) {
    commandResults.localWorkerStart = {
      command,
      cwd: path.relative(repoRoot, siteRoot),
      exitCode: localWorker?.exitCode ?? 1,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      outputTail: localWorkerOutput.trim().slice(-4_000),
    };
    console.error(`RESULT localWorkerStart: FAIL ${commandResults.localWorkerStart.error}`);
    return false;
  }
}

async function stopLocalWorker() {
  if (!localWorker?.pid) return;
  const command = process.platform === "win32"
    ? `taskkill.exe /PID ${localWorker.pid} /T /F`
    : `kill -- -${localWorker.pid}`;
  let error = null;
  if (process.platform === "win32") {
    const taskkillPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const stopped = spawnSync(taskkillPath, ["/PID", String(localWorker.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    if (stopped.error || (stopped.status !== 0 && localWorker.exitCode === null)) error = stopped.error?.message ?? stopped.stderr?.trim() ?? "taskkill failed";
  } else if (localWorker.exitCode === null) {
    try { process.kill(-localWorker.pid, "SIGTERM"); } catch (stopError) { error = String(stopError); }
  }
  if (localWorker.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => localWorker.once("exit", resolve)),
      wait(5_000),
    ]);
  }
  commandResults.localWorkerStop = {
    command,
    cwd: path.relative(repoRoot, siteRoot),
    exitCode: error ? 1 : 0,
    status: error ? "FAIL" : "PASS",
    workerPid: localWorker.pid,
    outputTail: localWorkerOutput.trim().slice(-4_000),
    ...(error ? { error } : {}),
  };
  console.log(`RESULT localWorkerStop: ${commandResults.localWorkerStop.status} pid=${localWorker.pid}`);
  localWorker = null;
}

const siteTests = run("siteMiniflareTests", process.execPath, [
  "--import", "tsx", "--test",
  "test/storage/migrations.test.ts",
  "test/storage/d1-storage.test.ts",
  "test/server/session-room.test.ts",
  "test/server/match-sync.test.ts",
], siteRoot);

const webTests = run("webTransportAndRoutes", process.execPath, [
  "--experimental-strip-types",
  "--loader", "./packages/engine/test/setup/ts-source-loader.mjs",
  "--test",
  "apps/web/test/sites-transport.test.mjs",
  "apps/web/src/app/routes.test.mjs",
], repoRoot);

const typecheck = run("siteTypecheck", process.execPath, [
  "node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json",
], siteRoot);

const build = run("siteBuild", process.execPath, ["scripts/run-framework.mjs", "build"], siteRoot);
const syntax = run("workerSmokeSyntax", process.execPath, ["--check", "e2e/worker-http-smoke.mjs"], siteRoot);
const workerStarted = await startLocalWorker();
const smoke = workerStarted
  ? run("workerHttpSmoke", process.execPath, ["--import", "tsx", "e2e/worker-http-smoke.mjs"], siteRoot, {
      env: { SITES_BASE_URL: baseUrl },
    })
  : (commandResults.workerHttpSmoke = {
      command: `${process.execPath} --import tsx e2e/worker-http-smoke.mjs`,
      cwd: path.relative(repoRoot, siteRoot),
      exitCode: 1,
      status: "FAIL",
      error: "Skipped because the runner could not start its loopback Worker.",
    });
await stopLocalWorker();

const serverMatch = "Worker match commands resolve effects and turn continuations with atomic receipts and stale no-write behavior";
const concurrentMatch = "D1 expected-version CAS allows one writer for concurrent match commands";
const projectionMatch = "room and match sync use strict canonical parsers and viewer-scoped private projections";
const unsupportedMatch = "unsupported match schema and ruleset disclose recovery only to members and never mutate state";
const replayMatch = "existing successful receipts replay before unsupported snapshot decoding without exposing recovery to outsiders";
const sseMatch = "SSE refreshes membership before cursor reads, emits only allowlisted data, and resumes after cancellation";
const guestRoom = "guest cookie create/restore is Worker-safe, expires correctly, and assigned-room restore is identity-scoped";
const inviteRoom = "invite preview is strict and redacted; persistent limiter honors peer IP, backoff, and successful JOIN reset";
const concurrentJoin = "concurrent JOIN is single-writer; room receipts replay and command hash mismatch is rejected";
const concurrentStart = "room ready/owner/version guards and concurrent START_MATCH persist the full initialized snapshot once";
const returnRoom = "completed direct restart and RETURN_TO_LOBBY preserve history, allocate one fresh match, and reset readiness";
const boundariesRoom = "HTTP origin/content-type/body limits, strict command parsing, and closed-room lifecycle are enforced";
const d1Receipt = "fresh Miniflare D1 runtimes are isolated and persisted receipts survive repository recreation";
const d1Unsupported = "unsupported state schema is returned as a safe recovery error";
const d1Limiter = "D1 invite limiter persists reservations across limiter instances and admits at most five";
const d1Reset = "D1 invite limiter success JOIN reset clears prior failures and retry backoff";
const d1Atomic = "room, player, receipt, and outbox writes roll back together on statement failure";
const d1ParallelStart = "parallel START_MATCH replay writes room, match, receipt and both outbox signals once";
const d1Rollback = "event, state, receipt, and outbox writes roll back together on outbox conflict";
const d1Restart = "START_MATCH persists the initialized turn-start/draw snapshot and restarts the completed match";
const transportSse = "SSE messages only invalidate, hidden streams close, and visible reconnect resumes the cursor";
const transportRetry = "Sites requests use strict DTO parsing, cookie credentials and same-payload command retry";
const routePaths = "direct room, role, game, result and invite URLs resolve to the expected path state";

const gates = [
  {
    id: "S01",
    assertions: [
      liveAssertion("S01-A1", "Worker entry exports default fetch", "S01.worker-default-fetch", ""),
      liveAssertion("S01-A2", "Worker client output includes 42 card/role/character PNGs and favicon", "S01.static-assets", ""),
      liveAssertion("S01-A3", "Worker/client bundle excludes pg and Socket.IO", "S01.worker-dependency-boundary", ""),
      liveAssertion("S01-A4", "Worker serves root/direct route/static resources and safe API 404", "S01.local-html-and-static-http", ""),
      {
        id: "S01-A5", title: "Home and direct room route render in one CUA context/profile", status: "PASS",
        command: "Manual parent CUA browser check on local Worker; one in-app browser profile/context",
        fixture: "http://127.0.0.1:8799/ and http://127.0.0.1:8799/rooms/new",
        result: "Root opened home and /rooms/new in separate tabs within one in-app browser context/profile; home navigation and the direct room guest-name field/continue button rendered. This is route smoke only, not a full game flow.",
      },
    ],
  },
  {
    id: "S02",
    assertions: [
      liveAssertion("S02-A1", "Guest create/restore/204/invalid-cookie/401 HTTP shapes", "S02.session-http", ""),
      liveAssertion("S02-A2", "Cookie flags and no-store behavior", "S02.session-http", ""),
      testAssertion("S02-A3", "Raw session credential omitted from JSON and stored only as D1 hash", "siteMiniflareTests", guestRoom,
        "the fixture reads the issued cookie, checks no JSON copy and compares D1 token_hash to SHA-256"),
      notRun("S02-A4", "Scan all local Worker request/error logs for raw session secrets", "The Worker log stream was not captured/scanned for generated cookie credentials."),
    ],
  },
  {
    id: "S03",
    assertions: [
      testAssertion("S03-A1", "Five failed invite lookups are admitted, sixth is limited; delay/expiry and valid-state errors follow contract", "siteMiniflareTests", inviteRoom,
        "fixed-clock HTTP fixtures cover rolling expiry, peer-IP trust, backoff and invalid-vs-valid invitation states"),
      testAssertion("S03-A2", "D1 reservation is shared across limiter instances and successful JOIN clears the failure window", "siteMiniflareTests", d1Limiter,
        "the same isolated D1 binding is used by concurrent limiter instances"),
      testAssertion("S03-A3", "A successful JOIN reset clears previous failures and exponential retry delay", "siteMiniflareTests", d1Reset,
        "isolated D1 fixture checks reservation allowance before/after JOIN success"),
      notRun("S03-A4", "Repeat invite abuse from separately restarted/isolated real Worker processes", "Miniflare handler/D1 concurrency was tested; independently managed Worker processes were not started for this abuse fixture."),
    ],
  },
  {
    id: "S04",
    assertions: [
      testAssertion("S04-A1", "Room command receipt replay returns original outcome and hash mismatch rejects", "siteMiniflareTests", concurrentJoin,
        "isolated D1 route fixture replays CREATE/JOIN command IDs and checks COMMAND_ID_REUSED"),
      testAssertion("S04-A2", "Stale room version rejects without mutation", "siteMiniflareTests", concurrentStart,
        "room fixture asserts STALE_VERSION/currentVersion and unchanged room/match/receipt/outbox counts"),
      testAssertion("S04-A3", "Concurrent join/start has one writer", "siteMiniflareTests", concurrentJoin,
        "two concurrent same-version JOIN/START_MATCH requests produce one success and one stale rejection"),
      testAssertion("S04-A4", "Room/player/match/receipt/outbox writes roll back together on failures", "siteMiniflareTests", d1Atomic,
        "D1 statement failure fixture checks all row counts and commit guards after rollback"),
      liveAssertion("S04-A5", "Real local Worker 4P and 7P create/join/ready/start lifecycle", ["S04-S07.worker-4p-http-flow", "S04-S07.worker-7p-http-flow"], ""),
    ],
  },
  {
    id: "S05",
    assertions: [
      testAssertion("S05-A1", "Same-version match commands admit one writer and leave stale contender without writes", "siteMiniflareTests", concurrentMatch,
        "isolated D1 service concurrency fixture checks one accepted and one stale command"),
      testAssertion("S05-A2", "Accepted ACK replay and reused command ID do not duplicate events/outbox/state", "siteMiniflareTests", serverMatch,
        "match command fixture compares event and outbox counts before/after exact request replay"),
      liveAssertion("S05-A3", "Live Worker accepts a current actor legal END_TURN and exact replay is duplicate ACK in 4P and 7P fixtures", ["S04-S07.worker-4p-http-flow", "S04-S07.worker-7p-http-flow"], ""),
      notRun("S05-A4", "Two independent browser contexts submit different commands at the same match version", "Root had one in-app browser context/profile and completed only home plus /rooms/new route smoke in separate tabs; independent cookie/browser contexts for concurrent commands were unavailable."),
    ],
  },
  {
    id: "S06",
    assertions: [
      testAssertion("S06-A1", "Strict canonical room/match sync parsers and private viewer projections", "siteMiniflareTests", projectionMatch,
        "Miniflare fixtures cover authenticated participant and outsider projection responses"),
      liveAssertion("S06-A2", "4P/7P Worker match sync passes canonical parser and viewer identity/private-self boundary", ["S04-S07.worker-4p-http-flow", "S04-S07.worker-7p-http-flow"], ""),
      testAssertion("S06-A3", "Unsupported schema/ruleset is disclosed only to member and never mutates state", "siteMiniflareTests", unsupportedMatch,
        "member and outsider sync fixture validates strict rejection shape and no-write state"),
      liveAssertion("S06-A4", "Live 4P/7P SSE contains only current member room/match invalidation fields", ["S04-S07.worker-4p-http-flow", "S04-S07.worker-7p-http-flow"], ""),
      notRun("S06-A5", "Scan all browser HTML and Worker logs for hidden projections/internal context", "The live smoke checks canonical sync/SSE bodies; it does not inspect all emitted HTML/log records for secret sentinel strings."),
    ],
  },
  {
    id: "S07",
    assertions: [
      testAssertion("S07-A1", "SSE auth refresh, member allowlist, cancellation and cursor resume", "siteMiniflareTests", sseMatch,
        "server fixture checks membership before cursor reads and verifies reconnect after cancellation"),
      liveAssertion("S07-A2", "Live 4P/7P Worker stream emits allowlisted invalidation; reconnect from last cursor sees new match version", ["S04-S07.worker-4p-http-flow", "S04-S07.worker-7p-http-flow"], ""),
      testAssertion("S07-A3", "Client transport closes hidden streams and reconnects visibly with cursor/full sync", "webTransportAndRoutes", transportSse,
        "fake EventSource/visibility fixture verifies lifecycle and sync after invalidation; not a real browser tab"),
      notRun("S07-A4", "Real browser tab hide/close, network loss, and resumed full-page sync", "Root's one in-app browser context/profile verified only / and /rooms/new in separate tabs. Independent browser contexts and real game-page visibility/network recovery were unavailable; transport mocks and Worker HTTP/SSE are supporting non-browser evidence only."),
    ],
  },
  {
    id: "S08",
    assertions: [
      testAssertion("S08-A1", "D1-backed command receipt survives repository recreation; independent runtime starts empty", "siteMiniflareTests", d1Receipt,
        "Miniflare fixture checks repository recreation over stored D1 and isolation of a separate runtime"),
      testAssertion("S08-A2", "Full initialized match snapshot/completed restart state remains valid in D1", "siteMiniflareTests", d1Restart,
        "fixture checks turn-start/draw snapshot, same roster rotation, card-ID separation and preserved prior match history"),
      testAssertion("S08-A3", "Unsupported stored state is safely rejected/member-only", "siteMiniflareTests", d1Unsupported,
        "Miniflare storage test plus match-sync recovery test check unsupported schema no-write boundaries"),
      notRun("S08-A4", "Restart the local Wrangler Worker and recover the same guest, seat, role, hand, pending cursor and exact command receipt", "S08 full Worker process-restart path was not exercised; only isolated D1/repository fixtures were run."),
    ],
  },
].map((gate) => {
  const statuses = gate.assertions.map(({ status }) => status);
  return {
    ...gate,
    status: statuses.includes("FAIL") ? "FAIL" : statuses.includes("NOT RUN") ? "PARTIAL" : "PASS",
  };
});

const assertions = gates.flatMap(({ assertions: entries }) => entries);
const statusCounts = assertions.reduce((counts, { status }) => {
  counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}, {});
const gateCounts = gates.reduce((counts, { status }) => {
  counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}, {});
const fullBrowserFlows = {
  status: "NOT RUN",
  fourPlayer: "NOT RUN",
  sevenPlayer: "NOT RUN",
  unmet: [
    "4P browser UI: create room, join all seats, set readiness, and start",
    "7P browser UI: create room, join all seats, set readiness, and start",
    "turn actions and response-card/response-chain UI",
    "elimination/cleanup UI and winner/result presentation",
    "browser reconnect after reload or network loss with the same seat and state",
    "return-to-lobby UI and readiness reset after a completed game",
  ],
  reason: "Root used one accessible in-app browser context/profile and verified only the home route and direct /rooms/new guest-entry route in separate tabs. Independent browser cookie contexts for complete UI games were unavailable; the workspace has no Playwright or agent-browser package.",
};

const result = {
  task: "T106",
  generatedAt: new Date().toISOString(),
  mode: "local-only portable Sites Worker; no public Site, external provider, or deployment",
  workerBaseUrl: baseUrl,
  runtime: { node: process.version, localWrangler: true, isolatedMiniflareTests: true },
  legacyAcceptance: { passed: 95, total: 97, D06: "NOT RUN", D18: "NOT RUN", modified: false },
  commands: commandResults,
  gates,
  fullBrowserFlows,
  publicDeploymentAndRemoteD1: "NOT RUN (out of scope for T106)",
  counts: {
    assertions: {
      pass: statusCounts.PASS ?? 0,
      fail: statusCounts.FAIL ?? 0,
      notRun: statusCounts["NOT RUN"] ?? 0,
      total: assertions.length,
    },
    gates: {
      pass: gateCounts.PASS ?? 0,
      partial: gateCounts.PARTIAL ?? 0,
      fail: gateCounts.FAIL ?? 0,
    },
  },
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`SAVED ${path.relative(repoRoot, resultPath)}`);
console.log(`T106 ASSERTIONS ${result.counts.assertions.pass} PASS / ${result.counts.assertions.fail} FAIL / ${result.counts.assertions.notRun} NOT RUN`);
console.log(`T106 GATES ${result.counts.gates.pass} PASS / ${result.counts.gates.partial} PARTIAL / ${result.counts.gates.fail} FAIL`);

if (Object.values(commandResults).some(({ status }) => status !== "PASS") || result.counts.assertions.fail > 0) {
  process.exitCode = 1;
}
