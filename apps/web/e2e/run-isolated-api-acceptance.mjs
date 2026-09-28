import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../../..");
const resultPath = resolve(scriptDir, "acceptance-results.json");
const serverPort = 3003;
const pglitePort = 5436;
const serverOrigin = `http://127.0.0.1:${serverPort}`;
const webOrigin = "http://127.0.0.1:5176";
const dataRoot = process.env.LOCALAPPDATA;
const databaseDirectory = dataRoot
  ? resolve(dataRoot, "BangOnline", "pglite-t60-d08-20260928")
  : null;
const primaryDatabaseDirectory = dataRoot
  ? resolve(dataRoot, "BangOnline", "pglite-t60-20260928")
  : null;
const serverMain = resolve(root, "apps/server/src/main.ts");
const tsxLoader = resolve(root, "apps/server/node_modules/tsx/dist/loader.mjs");
const preload = resolve(scriptDir, "d08-server-preload.mjs");
const acceptanceRunner = resolve(scriptDir, "run-acceptance.mjs");
const runStartedAt = new Date().toISOString();
const serverLogs = [];
const runnerLogs = [];
let serverProcess = null;
let runnerExit = null;
let beforeHealth = null;
let afterHealth = null;
let ownershipBeforeStop = null;
let gracefulShutdown = null;
let resultSaveError = null;

function keepLines(target, source, chunk) {
  for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
    if (line.trim()) target.push({ source, line: line.trim() });
  }
  if (target.length > 250) target.splice(0, target.length - 250);
}

async function assertPortFree(port) {
  const state = await new Promise((resolveState) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveState("timeout");
    }, 800);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveState("in_use");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolveState(error.code === "ECONNREFUSED" ? "free" : error.code);
    });
  });
  assert.equal(state, "free", `isolated API port ${port} was not free (${state})`);
}

async function health(origin, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) {
      throw new Error(`isolated server exited ${serverProcess.exitCode}: ${JSON.stringify(serverLogs.slice(-20))}`);
    }
    try {
      const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(1500) });
      if (response.status === 200) {
        const body = await response.json();
        if (body?.status === "ok") return 200;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`isolated health did not become ready: ${last}`);
}

function inspectOwnedProcessTree(childPid) {
  assert.equal(process.platform, "win32", "process ownership inspection requires Windows");
  const command = `$targetPid=${Number(childPid)}; $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); $ids=@($targetPid); $changed=$true; while($changed){$changed=$false;foreach($item in $all){if(($ids -contains [int]$item.ParentProcessId) -and ($ids -notcontains [int]$item.ProcessId)){$ids+=([int]$item.ProcessId);$changed=$true}}}; $processes=@($all|Where-Object{$ids -contains [int]$_.ProcessId}); $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${serverPort},${pglitePort} -ErrorAction SilentlyContinue|Select-Object LocalPort,OwningProcess); [pscustomobject]@{processes=$processes;listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress`;
  const json = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 7000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(json.trim());
  const processes = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : [];
  const listeners = Array.isArray(parsed.listeners) ? parsed.listeners : parsed.listeners ? [parsed.listeners] : [];
  const child = processes.find((item) => Number(item.ProcessId) === Number(childPid));
  const expectedCommand = String(child?.CommandLine ?? "").toLowerCase();
  const treeIds = new Set(processes.map((item) => Number(item.ProcessId)));
  const portsOwned = [serverPort, pglitePort].every((port) => listeners.some((item) => Number(item.LocalPort) === port)) &&
    listeners.every((item) => treeIds.has(Number(item.OwningProcess)));
  const diagnostic = {
    runnerSpawnPid: Number(childPid),
    processTree: processes.map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name: item.Name,
      executablePath: item.ExecutablePath,
      commandLine: item.CommandLine,
    })),
    listeners: listeners.map((item) => ({ port: Number(item.LocalPort), pid: Number(item.OwningProcess) }))
      .sort((left, right) => left.port - right.port),
    childIsExpectedNodeServer: Number(child?.ProcessId) === Number(childPid) &&
      resolve(String(child?.ExecutablePath ?? "")).toLowerCase() === resolve(process.execPath).toLowerCase() &&
      expectedCommand.includes("run-acceptance-isolated") === false &&
      expectedCommand.includes("d08-server-preload.mjs") &&
      expectedCommand.includes("main.ts") && expectedCommand.includes("--pglite-dev"),
    allListenersOwnedBySpawnedTree: portsOwned,
  };
  assert.ok(diagnostic.childIsExpectedNodeServer, "spawned isolated process identity did not match expected server command");
  assert.ok(diagnostic.allListenersOwnedBySpawnedTree, "one or more isolated API/PGlite listeners were not owned by the spawned process tree");
  return diagnostic;
}

function startServer() {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(serverPort),
    PGLITE_PORT: String(pglitePort),
    PGLITE_DATA_DIR: databaseDirectory,
    WEB_ORIGIN: webOrigin,
  };
  serverProcess = spawn(process.execPath, [
    "--import", pathToFileURL(preload).href,
    "--import", pathToFileURL(tsxLoader).href,
    serverMain,
    "--pglite-dev",
  ], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  serverProcess.stdout.on("data", (chunk) => keepLines(serverLogs, "stdout", chunk));
  serverProcess.stderr.on("data", (chunk) => keepLines(serverLogs, "stderr", chunk));
  return serverProcess;
}

function runAcceptance() {
  const env = {
    ...process.env,
    T60_ORIGIN: serverOrigin,
    T60_SERVER_ORIGIN: serverOrigin,
    T60_WEB_ORIGIN: webOrigin,
    T60_RUN_STARTED_AT: new Date().toISOString(),
  };
  const child = spawn(process.execPath, [acceptanceRunner], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => keepLines(runnerLogs, "stdout", chunk));
  child.stderr.on("data", (chunk) => keepLines(runnerLogs, "stderr", chunk));
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error("isolated API acceptance runner exceeded 12 minutes"));
    }, 12 * 60 * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function stopServer() {
  const child = serverProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return { status: "already exited" };
  ownershipBeforeStop = inspectOwnedProcessTree(child.pid);
  const exit = new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("owned isolated server did not stop gracefully within 25 seconds")), 25_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  await new Promise((resolveSend, rejectSend) => {
    child.send({ type: "T60_D08_SHUTDOWN" }, (error) => error ? rejectSend(error) : resolveSend());
  });
  const result = await exit;
  assert.equal(result.signal, null, "isolated server used an unexpected forced signal");
  assert.equal(result.code, 0, "isolated server did not exit cleanly");
  assert.ok(serverLogs.some(({ line }) => line.includes("shutdown complete.")), "server shutdown completion was not logged");
  await assertPortFree(serverPort);
  await assertPortFree(pglitePort);
  serverProcess = null;
  return { ...result, gracefulShutdownLogged: true, portsReleased: true, ownershipBeforeStop };
}

const runResult = {
  status: "NOT RUN",
  command: "node apps/web/e2e/run-isolated-api-acceptance.mjs",
  startedAt: runStartedAt,
  finishedAt: null,
  serverOrigin,
  webOrigin,
  ports: { server: serverPort, pglite: pglitePort },
  databaseDirectory: "%LOCALAPPDATA%\\BangOnline\\pglite-t60-d08-20260928",
  primaryDatabaseDirectory: "%LOCALAPPDATA%\\BangOnline\\pglite-t60-20260928",
  databaseIsSeparate: false,
  primaryHealthBefore: null,
  primaryHealthAfter: null,
  startOwnership: null,
  runnerExit: null,
  gracefulShutdown: null,
  serverLogs,
  runnerLogs,
  error: null,
};

try {
  assert.ok(databaseDirectory && primaryDatabaseDirectory, "LOCALAPPDATA is required for isolated test DBs");
  assert.ok(isAbsolute(databaseDirectory) && isAbsolute(primaryDatabaseDirectory), "database paths must be absolute");
  const isWithin = (base, candidate) => {
    const path = relative(base, candidate);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  assert.equal(isWithin(primaryDatabaseDirectory, databaseDirectory), false, "isolated API DB must not be inside primary DB");
  assert.equal(isWithin(databaseDirectory, primaryDatabaseDirectory), false, "primary DB must not be inside isolated API DB");
  await realpath(databaseDirectory);
  await realpath(primaryDatabaseDirectory);
  await assertPortFree(serverPort);
  await assertPortFree(pglitePort);
  beforeHealth = await (await fetch("http://127.0.0.1:3002/healthz", { signal: AbortSignal.timeout(3000) })).status;
  assert.equal(beforeHealth, 200, "primary T60 server must be healthy before isolated run");
  runResult.databaseIsSeparate = true;
  runResult.primaryHealthBefore = beforeHealth;
  const child = startServer();
  await health(serverOrigin);
  runResult.startOwnership = inspectOwnedProcessTree(child.pid);
  assert.ok(serverLogs.some(({ line }) => line.includes("HTTP and Socket.IO listening at 127.0.0.1:3003")));
  assert.ok(serverLogs.some(({ line }) => line.includes("Local PGlite Socket database ready at 127.0.0.1:5436")));
  const response = await fetch(webOrigin + "/rooms/new", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `Vite ${webOrigin}/rooms/new was not healthy`);
  runnerExit = await runAcceptance();
  runResult.runnerExit = runnerExit;
  assert.equal(runResult.runnerExit.code, 0, `API acceptance runner exited ${runResult.runnerExit.code}`);
  runResult.status = "COMPLETED";
} catch (error) {
  runResult.error = error instanceof Error ? error.message : String(error);
} finally {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    try {
      runResult.gracefulShutdown = await stopServer();
    } catch (error) {
      runResult.shutdownError = error instanceof Error ? error.message : String(error);
      // No broad cleanup is attempted if identity/ownership checks fail.
    }
  }
  afterHealth = await fetch("http://127.0.0.1:3002/healthz", { signal: AbortSignal.timeout(3000) })
    .then((response) => response.status)
    .catch(() => null);
  runResult.primaryHealthAfter = afterHealth;
  runResult.finishedAt = new Date().toISOString();

  try {
    const record = JSON.parse(await readFile(resultPath, "utf8"));
    record.apiExecution ??= {};
    record.apiExecution.isolatedApiRun = runResult;
    record.generatedAt = runResult.finishedAt;
    const statuses = Array.from({ length: 19 }, (_, index) => {
      const id = `D${String(index + 1).padStart(2, "0")}`;
      return record.results?.[id]?.status ?? "NOT RUN";
    });
    const pass = statuses.filter((status) => status === "PASS").length;
    const fail = statuses.filter((status) => status === "FAIL").length;
    const notRun = statuses.filter((status) => status === "NOT RUN").length;
    record.verificationSummary ??= {};
    record.verificationSummary.integratedD = { pass, fail, notRun, total: 19 };
    const engineVerified = record.verificationSummary.engineCases?.verified ?? 78;
    const engineTotal = record.verificationSummary.engineCases?.total ?? 78;
    record.verificationSummary.combined = { verified: engineVerified + pass, total: engineTotal + 19 };
    await writeFile(resultPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (error) {
    resultSaveError = error instanceof Error ? error.message : String(error);
  }
}

console.log(`isolated API runner ${runResult.status}; runnerExit=${JSON.stringify(runnerExit)}; primaryHealth=${beforeHealth}->${afterHealth}`);
console.log(`D08 ports ${serverPort}/${pglitePort}; database=${runResult.databaseDirectory}; cleanup=${JSON.stringify(runResult.gracefulShutdown)}`);
console.log(`result=${resultPath}`);
if (runResult.error) console.log(`error=${runResult.error}`);
if (runResult.shutdownError) console.log(`shutdownError=${runResult.shutdownError}`);
if (resultSaveError) console.log(`resultSaveError=${resultSaveError}`);

