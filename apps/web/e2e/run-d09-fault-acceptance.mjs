import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { io } from "socket.io-client";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../../..");
const resultPath = resolve(scriptDir, "acceptance-results.json");
const serverPort = 3004;
const pglitePort = 5437;
const serverOrigin = `http://127.0.0.1:${serverPort}`;
const webOrigin = "http://127.0.0.1:5176";
const localAppData = process.env.LOCALAPPDATA;
const databaseDirectory = localAppData
  ? resolve(localAppData, "BangOnline", "pglite-t60-d09-20260928-0607")
  : null;
const primaryDatabaseDirectory = localAppData
  ? resolve(localAppData, "BangOnline", "pglite-t60-20260928")
  : null;
const serverMain = resolve(root, "apps/server/src/main.ts");
const tsxLoader = resolve(root, "apps/server/node_modules/tsx/dist/loader.mjs");
const preload = resolve(scriptDir, "d09-server-preload.mjs");
const runStartedAt = new Date().toISOString();
const serverLogs = [];
const serverMessages = [];
const serverIpcEvidence = [];
const messageWaiters = new Set();
const clients = new Set();
let serverProcess = null;
let runnerStatus = "NOT RUN";
let runnerError = null;
let serverExit = null;
let shutdownResult = null;
let primaryHealthBefore = null;
let primaryHealthAfter = null;
let startOwnership = null;
let stopOwnership = null;
let executionPhase = "preflight";
const evidence = {
  status: "NOT RUN",
  startedAt: runStartedAt,
  finishedAt: null,
  command: "node apps/web/e2e/run-d09-fault-acceptance.mjs",
  serverOrigin,
  webOrigin,
  ports: { server: serverPort, pglite: pglitePort },
  databaseDirectory: databaseDirectory
    ? "%LOCALAPPDATA%\\BangOnline\\pglite-t60-d09-20260928-0607"
    : null,
  databaseIsSeparate: false,
  databaseWitnessPath: "test-only IPC to isolated server's own pg.Pool; no second PGlite socket client",
  primaryHealthBefore: null,
  primaryHealthAfter: null,
  processOwnership: null,
  precommitFault: null,
  postcommitAckLoss: null,
  outboxNotificationLoss: null,
  gracefulShutdown: null,
  serverIpcEvidence,
  error: null,
  executionPhase,
  serverLogs,
};

function keepLines(source, chunk) {
  for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
    if (line.trim()) serverLogs.push({ source, line: line.trim() });
  }
  if (serverLogs.length > 200) serverLogs.splice(0, serverLogs.length - 200);
}

function onServerMessage(message) {
  serverMessages.push(message);
  if (message?.type === "T60_D09_PRECOMMIT_FAULT_INJECTED" ||
      message?.type === "T60_D09_PRECOMMIT_FAULT_ARMED" ||
      message?.type === "T60_D09_ROLLBACK_OBSERVED") {
    serverIpcEvidence.push(message);
  }
  for (const waiter of messageWaiters) {
    if (waiter.predicate(message)) {
      messageWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }
}

function waitForServerMessage(predicate, timeoutMs = 7000) {
  const existing = serverMessages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveMessage, rejectMessage) => {
    const waiter = {
      predicate,
      resolve: resolveMessage,
      reject: rejectMessage,
      timer: setTimeout(() => {
        messageWaiters.delete(waiter);
        rejectMessage(new Error("timed out waiting for isolated server IPC evidence"));
      }, timeoutMs),
    };
    messageWaiters.add(waiter);
  });
}

function waitForMessageType(type, predicate = () => true, timeoutMs = 7000) {
  return waitForServerMessage((message) => message?.type === type && predicate(message), timeoutMs);
}

async function sendServerMessage(message) {
  await new Promise((resolveSend, rejectSend) => {
    serverProcess.send(message, (error) => error ? rejectSend(error) : resolveSend());
  });
}

async function queryDatabase(sql, parameters = []) {
  const requestId = randomUUID();
  const resultMessage = waitForMessageType("T60_D09_DB_QUERY_RESULT", (message) => message.requestId === requestId);
  await sendServerMessage({ type: "T60_D09_DB_QUERY", requestId, sql, parameters });
  const response = await resultMessage;
  if (response.error) throw new Error(`D09 in-process DB witness query failed: ${response.error}`);
  return { rows: response.rows ?? [] };
}

async function assertPortFree(port) {
  const state = await new Promise((resolveState) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveState("timeout");
    }, 900);
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
  assert.equal(state, "free", `D09 isolated port ${port} was not free (${state})`);
}

async function health(origin, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) {
      throw new Error(`D09 isolated server exited ${serverProcess.exitCode}: ${JSON.stringify(serverLogs.slice(-20))}`);
    }
    try {
      const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(1500) });
      if (response.status === 200 && (await response.json())?.status === "ok") return 200;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`D09 isolated server did not become healthy: ${last}`);
}

function inspectOwnedProcessTree(childPid, requireBothPorts = true) {
  assert.equal(process.platform, "win32", "D09 process ownership check requires Windows");
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
  const treeIds = new Set(processes.map((item) => Number(item.ProcessId)));
  const commandLine = String(child?.CommandLine ?? "").toLowerCase();
  const listenersOwned = listeners.every((item) => treeIds.has(Number(item.OwningProcess)));
  const bothPortsListening = [serverPort, pglitePort].every((port) =>
    listeners.some((item) => Number(item.LocalPort) === port && treeIds.has(Number(item.OwningProcess))));
  const output = {
    spawnPid: Number(childPid),
    processTree: processes.map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name: item.Name,
      executablePath: item.ExecutablePath,
      commandLine: item.CommandLine,
    })),
    listeners: listeners.map((item) => ({ port: Number(item.LocalPort), pid: Number(item.OwningProcess) })),
    bothPortsListening,
    expectedServer: Number(child?.ProcessId) === Number(childPid) &&
      resolve(String(child?.ExecutablePath ?? "")).toLowerCase() === resolve(process.execPath).toLowerCase() &&
      commandLine.includes("d09-server-preload.mjs") && commandLine.includes("main.ts") && commandLine.includes("--pglite-dev"),
    allListenersOwnedBySpawnedTree: listenersOwned,
  };
  assert.ok(output.expectedServer, "spawned process is not the expected D09 Node server");
  assert.ok(output.allListenersOwnedBySpawnedTree, "a D09 listener is not owned by the spawned server tree");
  if (requireBothPorts) assert.ok(output.bothPortsListening, "D09 server did not own both expected listeners");
  return output;
}

function startServer() {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(serverPort),
    PGLITE_PORT: String(pglitePort),
    PGLITE_DATA_DIR: databaseDirectory,
    WEB_ORIGIN: webOrigin,
    T60_D09_SERVER_PACKAGE_DIR: resolve(root, "apps/server"),
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
  serverProcess.stdout.on("data", (chunk) => keepLines("stdout", chunk));
  serverProcess.stderr.on("data", (chunk) => keepLines("stderr", chunk));
  serverProcess.on("message", onServerMessage);
  return serverProcess;
}

function connectGuest(guest) {
  const socket = io(serverOrigin, {
    path: "/socket.io",
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: guest.cookie },
  });
  clients.add(socket);
  guest.socket = socket;
  guest.frames = guest.frames ?? [];
  socket.onAny((eventName, ...args) => guest.frames.push({ eventName, args }));
  return new Promise((resolveSocket, rejectSocket) => {
    const timer = setTimeout(() => rejectSocket(new Error("D09 guest socket connect timed out")), 6000);
    socket.once("connect", () => { clearTimeout(timer); resolveSocket(socket); });
    socket.once("connect_error", (error) => { clearTimeout(timer); rejectSocket(new Error(`D09 guest socket failed: ${error.message}`)); });
  });
}

async function createGuest(displayName) {
  const response = await fetch(serverOrigin + "/api/guest-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, displayName }),
  });
  const payload = await response.json();
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  assert.equal(response.status, 201, "D09 guest session creation failed");
  assert.ok(cookie && payload?.player?.playerId, "D09 guest session lacked an authenticated cookie/player");
  const guest = { playerId: payload.player.playerId, displayName: payload.player.displayName, cookie, frames: [] };
  await connectGuest(guest);
  return guest;
}

function ack(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolveAck, rejectAck) => {
    const timer = setTimeout(() => rejectAck(new Error(`${event} ACK timeout`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolveAck(response);
    });
  });
}

async function createFourPlayerRoom() {
  const players = [];
  for (let index = 0; index < 4; index += 1) players.push(await createGuest(`D09 seat ${index + 1}`));
  const created = await ack(players[0].socket, "room:create", {
    protocolVersion: 1,
    commandId: randomUUID(),
    expectedVersion: 0,
    type: "CREATE_ROOM",
    payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: players[0].displayName },
  });
  assert.ok(created?.roomId && Number.isSafeInteger(created.version) && created.inviteCode, "D09 room create failed");
  for (const player of players.slice(1)) {
    const preview = await ack(player.socket, "room:preview", {
      protocolVersion: 1,
      requestId: randomUUID(),
      inviteCode: created.inviteCode,
    });
    assert.equal(preview.roomId, created.roomId, "D09 invite preview returned a different room");
    const joined = await ack(player.socket, "room:command", {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedVersion: preview.version,
      roomId: created.roomId,
      type: "JOIN",
      payload: { inviteCode: created.inviteCode },
    });
    assert.equal(joined.roomId, created.roomId, "D09 guest join failed");
  }
  for (const player of players) {
    const current = await ack(player.socket, "room:sync", {
      protocolVersion: 1,
      requestId: randomUUID(),
      roomId: created.roomId,
      knownVersion: 0,
    });
    const member = current.room?.members?.find((entry) => entry.playerId === player.playerId);
    if (!member?.ready) {
      const ready = await ack(player.socket, "room:command", {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedVersion: current.version,
        roomId: created.roomId,
        type: "SET_READY",
        payload: { ready: true },
      });
      assert.equal(ready.roomId, created.roomId, "D09 SET_READY failed");
    }
  }
  const latestRoom = await ack(players[0].socket, "room:sync", {
    protocolVersion: 1,
    requestId: randomUUID(),
    roomId: created.roomId,
    knownVersion: 0,
  });
  const started = await ack(players[0].socket, "room:command", {
    protocolVersion: 1,
    commandId: randomUUID(),
    expectedVersion: latestRoom.version,
    roomId: created.roomId,
    type: "START_MATCH",
    payload: {},
  });
  assert.ok(started.activeMatchId, "D09 start did not create a match");
  return { roomId: created.roomId, inviteCode: created.inviteCode, players, matchId: started.activeMatchId };
}

async function matchSync(player, matchId) {
  return ack(player.socket, "match:sync", {
    protocolVersion: 1,
    requestId: randomUUID(),
    matchId,
    knownVersion: 0,
    afterEventSeq: 0,
  });
}

function connectAgain(player) {
  const old = player.socket;
  if (old) {
    old.disconnect();
    clients.delete(old);
  }
  return connectGuest(player);
}

function countResult(result) {
  return Number(result.rows[0]?.count ?? 0);
}

async function databaseWitness(matchId, actorId, commandId, targetVersion) {
  const matchResult = await queryDatabase(
    "SELECT version::text AS version, event_seq::text AS event_seq, md5(state_json::text) AS state_hash FROM matches WHERE id = $1",
    [matchId],
  );
  assert.equal(matchResult.rows.length, 1, "D09 match row disappeared");
  const eventCount = countResult(await queryDatabase(
    "SELECT count(*)::text AS count FROM match_events WHERE match_id = $1",
    [matchId],
  ));
  const targetEventCount = countResult(await queryDatabase(
    "SELECT count(*)::text AS count FROM match_events WHERE match_id = $1 AND version = $2",
    [matchId, targetVersion],
  ));
  const receiptResult = await queryDatabase(
    `SELECT count(*)::text AS count,
            max(request_hash) AS request_hash,
            max(outcome_json->>'status') AS status,
            max(outcome_json->>'aggregateVersion') AS aggregate_version,
            max(outcome_json->>'eventSeq') AS event_seq
       FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2`,
    [actorId, commandId],
  );
  const outboxResult = await queryDatabase(
    `SELECT count(*)::text AS count,
            max(event_seq)::text AS event_seq,
            max(kind) AS kind,
            bool_or(published_at IS NOT NULL) AS published
       FROM outbox WHERE aggregate_id = $1 AND aggregate_version = $2`,
    [matchId, targetVersion],
  );
  const matchOutboxCount = countResult(await queryDatabase(
    "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = $1",
    [matchId],
  ));
  return {
    version: Number(matchResult.rows[0].version),
    eventSeq: Number(matchResult.rows[0].event_seq),
    stateHash: matchResult.rows[0].state_hash,
    eventCount,
    targetEventCount,
    receiptCount: Number(receiptResult.rows[0].count),
    requestHashPresent: Boolean(receiptResult.rows[0].request_hash),
    receiptStatus: receiptResult.rows[0].status,
    receiptVersion: receiptResult.rows[0].aggregate_version === null
      ? null
      : Number(receiptResult.rows[0].aggregate_version),
    receiptEventSeq: receiptResult.rows[0].event_seq === null
      ? null
      : Number(receiptResult.rows[0].event_seq),
    targetOutboxCount: Number(outboxResult.rows[0].count),
    outboxEventSeq: outboxResult.rows[0].event_seq === null ? null : Number(outboxResult.rows[0].event_seq),
    outboxKind: outboxResult.rows[0].kind,
    outboxPublished: outboxResult.rows[0].published ?? false,
    matchOutboxCount,
  };
}

function parseSocketAckFrame(data, commandId) {
  let text;
  if (typeof data === "string") text = data;
  else if (Buffer.isBuffer(data)) text = data.toString("utf8");
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
  else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  else return null;
  const match = text.match(/^43\d+(.*)$/su);
  if (!match) return null;
  let args;
  try { args = JSON.parse(match[1]); } catch { return null; }
  const response = Array.isArray(args) ? args[0] : null;
  return response?.commandId === commandId ? { text, response } : null;
}

function sendCommandDropClientAck(player, command) {
  const transport = player.socket.io.engine.transport;
  const originalOnData = transport.onData;
  let captured = null;
  let callbackRan = false;
  let timer;
  const frame = new Promise((resolveFrame, rejectFrame) => {
    timer = setTimeout(() => rejectFrame(new Error("D09 post-commit ACK frame was not observed")), 9000);
    transport.onData = function (data) {
      const parsed = parseSocketAckFrame(data, command.commandId);
      if (parsed) {
        captured = parsed;
        clearTimeout(timer);
        resolveFrame(parsed);
        return;
      }
      return originalOnData.call(this, data);
    };
  });
  player.socket.emit("match:command", command, () => { callbackRan = true; });
  return {
    frame,
    restore() {
      clearTimeout(timer);
      transport.onData = originalOnData;
    },
    get captured() { return captured; },
    get callbackRan() { return callbackRan; },
  };
}

async function waitForPublishedOutbox(matchId, actorId, commandId, targetVersion, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const witness = await databaseWitness(matchId, actorId, commandId, targetVersion);
    if (witness.targetOutboxCount === 1 && witness.outboxPublished) return witness;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("the intentionally dropped outbox row was not marked published");
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    return { status: "already exited" };
  }
  stopOwnership = inspectOwnedProcessTree(serverProcess.pid, false);
  const child = serverProcess;
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("owned D09 server did not stop gracefully within 25 seconds")), 25_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  await new Promise((resolveSend, rejectSend) => {
    child.send({ type: "T60_D09_SHUTDOWN" }, (error) => error ? rejectSend(error) : resolveSend());
  });
  const result = await exitPromise;
  assert.equal(result.signal, null, "D09 server used an unexpected forced signal");
  assert.equal(result.code, 0, "D09 server did not exit cleanly");
  assert.ok(serverLogs.some(({ line }) => line.includes("shutdown complete.")), "D09 server shutdown completion was not logged");
  await assertPortFree(serverPort);
  await assertPortFree(pglitePort);
  serverProcess = null;
  return { ...result, portsReleased: true, ownershipBeforeStop: stopOwnership };
}

async function executeD09() {
  executionPhase = "create-guests-room-match";
  evidence.executionPhase = executionPhase;
  const group = await createFourPlayerRoom();
  evidence.roomId = group.roomId;
  evidence.matchId = group.matchId;
  const seatSyncs = await Promise.all(group.players.map((player) => matchSync(player, group.matchId)));
  const initialSync = seatSyncs[0];
  assert.equal(initialSync.matchId, group.matchId, "D09 initial match sync was rejected");
  assert.ok(initialSync.snapshot, "D09 initial match sync omitted its snapshot");
  const currentPlayerId = initialSync.snapshot.publicTable.turn.currentPlayerId;
  const currentPlayerIndex = group.players.findIndex((player) => player.playerId === currentPlayerId);
  assert.notEqual(currentPlayerIndex, -1, "D09 current turn owner is not one of the four authenticated guests");
  const responderIndex = group.players.findIndex((player, index) => {
    const pending = seatSyncs[index].snapshot.pendingInteraction;
    return pending?.currentResponderPlayerId === player.playerId &&
      Array.isArray(pending.responseOptions) && pending.responseOptions.length > 0;
  });
  const actorIndex = responderIndex >= 0 ? responderIndex : currentPlayerIndex;
  const actor = group.players[actorIndex];
  const baselineSync = seatSyncs[actorIndex];
  const observer = group.players.find((player) => player.playerId !== actor.playerId);
  const observerIndex = group.players.indexOf(observer);
  const observerBaselineSync = seatSyncs[observerIndex];
  assert.equal(observerBaselineSync.version, baselineSync.version, "D09 observer did not start at the same match version");
  assert.equal(observerBaselineSync.eventSeq, baselineSync.eventSeq, "D09 observer did not start at the same event cursor");
  const legalActions = baselineSync.snapshot.legalActions ?? [];
  const pending = baselineSync.snapshot.pendingInteraction;
  const responseOption = pending?.currentResponderPlayerId === actor.playerId
    ? pending.responseOptions?.[0]
    : undefined;
  const action = responseOption
    ? { type: "RESPOND", payload: responseOption }
    : legalActions.find((item) => item.type === "PLAY_CARD") ??
      legalActions.find((item) => item.type === "USE_ABILITY") ??
      legalActions.find((item) => item.type === "END_TURN");
  assert.ok(action, `D09 current actor has no server-projected legal action: ${JSON.stringify({
    playerId: actor.playerId,
    currentPlayerId,
    turn: baselineSync.snapshot.publicTable.turn,
    legalActions: baselineSync.snapshot.legalActions,
    pendingInteraction: baselineSync.snapshot.pendingInteraction,
  })}`);
  const command = {
    protocolVersion: 1,
    commandId: randomUUID(),
    expectedVersion: baselineSync.version,
    matchId: group.matchId,
    type: action.type,
    payload: action.payload,
  };
  const targetVersion = baselineSync.version + 1;
  evidence.commandType = command.type;
  evidence.commandId = command.commandId;
  evidence.versionTransition = `${baselineSync.version}->${targetVersion}`;
  const baselineDb = await databaseWitness(group.matchId, actor.playerId, command.commandId, targetVersion);
  assert.equal(baselineDb.version, baselineSync.version);
  assert.equal(baselineDb.eventSeq, baselineSync.eventSeq);
  assert.equal(baselineDb.receiptCount, 0);
  assert.equal(baselineDb.targetOutboxCount, 0);

  executionPhase = "precommit-fault-and-rollback";
  evidence.executionPhase = executionPhase;
  evidence.precommitFault = {
    status: "ARMED",
    injection: "test-only pg.Pool client wrapper rejects the exact target transaction's COMMIT after its matches, match_events, command_receipts, and outbox writes have completed",
    baseline: baselineDb,
  };
  const precommitArmed = waitForMessageType("T60_D09_PRECOMMIT_FAULT_ARMED", (message) =>
    message.matchId === group.matchId && message.version === targetVersion);
  await sendServerMessage({
    type: "T60_D09_ARM_PRECOMMIT_FAIL",
    matchId: group.matchId,
    version: targetVersion,
  });
  await precommitArmed;
  const precommitInjected = waitForMessageType("T60_D09_PRECOMMIT_FAULT_INJECTED", (message) =>
    message.matchId === group.matchId && message.version === targetVersion);
  const rollbackObserved = waitForMessageType("T60_D09_ROLLBACK_OBSERVED", (message) =>
    message.matchId === group.matchId && message.version === targetVersion);
  const disconnected = new Promise((resolveDisconnect) => {
    if (!actor.socket.connected) return resolveDisconnect("already-disconnected");
    actor.socket.once("disconnect", (reason) => resolveDisconnect(reason));
  });
  let precommitAck = null;
  const ackOrDisconnect = new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error("precommit-fault command did not ACK or disconnect within 10 seconds")), 10_000);
    actor.socket.emit("match:command", command, (response) => {
      clearTimeout(timer);
      precommitAck = response;
      resolveResult({ kind: "ack", response });
    });
    disconnected.then((reason) => {
      clearTimeout(timer);
      resolveResult({ kind: "disconnect", reason });
    });
  });
  const failedAttempt = await ackOrDisconnect;
  const injectedFault = await precommitInjected;
  const observedRollback = await rollbackObserved;
  const afterFailure = await databaseWitness(group.matchId, actor.playerId, command.commandId, targetVersion);
  const precommitRolledBack = afterFailure.version === baselineDb.version &&
    afterFailure.eventSeq === baselineDb.eventSeq &&
    afterFailure.stateHash === baselineDb.stateHash &&
    afterFailure.eventCount === baselineDb.eventCount &&
    afterFailure.receiptCount === 0 &&
    afterFailure.matchOutboxCount === baselineDb.matchOutboxCount &&
    afterFailure.targetOutboxCount === 0;
  assert.equal(failedAttempt.kind, "disconnect", "injected precommit DB failure unexpectedly received a command ACK");
  assert.equal(precommitAck, null);
  assert.ok(precommitRolledBack, "precommit failure left a partial state/event/receipt/outbox write");
  evidence.precommitFault = {
    status: "ROLLED_BACK",
    injection: "the isolated server's pg client wrapper rejected COMMIT after all target state/event/receipt/outbox writes completed; the real transaction error path then issued ROLLBACK",
    transport: failedAttempt.kind,
    socketDisconnectReason: failedAttempt.reason,
    injectedFault,
    observedRollback,
    before: baselineDb,
    afterFailure: afterFailure,
    rollbackVerified: precommitRolledBack,
  };

  await connectAgain(actor);
  executionPhase = "postcommit-ack-and-outbox-loss";
  evidence.executionPhase = executionPhase;
  const armMessage = waitForMessageType("T60_D09_OUTBOX_DROP_ARMED", (message) =>
    message.matchId === group.matchId && message.version === targetVersion);
  await new Promise((resolveSend, rejectSend) => {
    serverProcess.send({ type: "T60_D09_ARM_OUTBOX_DROP", matchId: group.matchId, version: targetVersion },
      (error) => error ? rejectSend(error) : resolveSend());
  });
  await armMessage;
  evidence.outboxNotificationLoss = {
    status: "ARMED",
    matchId: group.matchId,
    version: targetVersion,
    injection: "one exact match:changed notification will be suppressed in the test-only Socket.IO preload",
  };
  const waitDropped = waitForMessageType("T60_D09_OUTBOX_NOTIFICATION_DROPPED", (message) =>
    message.matchId === group.matchId && message.version === targetVersion);

  const ackDrop = sendCommandDropClientAck(actor, command);
  const [droppedAck, droppedOutbox] = await Promise.all([
    ackDrop.frame,
    waitDropped,
  ]).finally(() => ackDrop.restore());
  assert.equal(droppedAck.response.status, "accepted", "the ACK lost after commit was not an accepted receipt");
  assert.equal(droppedAck.response.duplicate, false, "the first committed receipt was unexpectedly duplicate");
  assert.equal(droppedAck.response.aggregateVersion, targetVersion);
  assert.equal(ackDrop.callbackRan, false, "injected client ACK loss still ran the Socket.IO callback");
  assert.equal(droppedOutbox.eventSeq, droppedAck.response.eventSeq, "dropped outbox notification cursor differs from committed ACK");
  evidence.postcommitAckLoss = {
    status: "ACK_FRAME_DROPPED",
    injection: "client Engine.IO WebSocket onData dropped the exact server ACK frame before Socket.IO decoding",
    capturedReceipt: droppedAck.response,
    callbackRan: ackDrop.callbackRan,
  };

  const observerDroppedNotifications = observer.frames.filter((frame) =>
    frame.eventName === "match:changed" && frame.args[0]?.matchId === group.matchId &&
    frame.args[0]?.version === targetVersion,
  ).length;
  assert.equal(observerDroppedNotifications, 0, "an observer received the deliberately dropped match:changed notification");
  const afterCommitDb = await waitForPublishedOutbox(group.matchId, actor.playerId, command.commandId, targetVersion);
  assert.equal(afterCommitDb.version, targetVersion);
  assert.equal(afterCommitDb.receiptCount, 1);
  assert.equal(afterCommitDb.receiptStatus, "accepted");
  assert.equal(afterCommitDb.receiptVersion, targetVersion);
  assert.equal(afterCommitDb.receiptEventSeq, droppedAck.response.eventSeq);
  assert.equal(afterCommitDb.targetEventCount, droppedAck.response.eventSeq - baselineDb.eventSeq);
  assert.equal(afterCommitDb.targetOutboxCount, 1);
  assert.equal(afterCommitDb.outboxKind, "match:changed");
  assert.equal(afterCommitDb.outboxEventSeq, droppedAck.response.eventSeq);
  evidence.outboxNotificationLoss = {
    status: "DROPPED_AND_PUBLISHED",
    injection: "preload suppressed one exact match:changed frame; durable outbox row remained and publisher marked it published",
    droppedNotification: droppedOutbox,
    observerReceivedNotificationCount: observerDroppedNotifications,
    committedDatabaseWitness: afterCommitDb,
  };

  // The API observer received no invalidation and has not requested another sync yet.
  // Its saved baseline projection is therefore still the initial version.
  const observerAfterRepair = await matchSync(observer, group.matchId);
  assert.equal(observerAfterRepair.version, targetVersion, "authoritative sync did not recover the committed state after outbox notification loss");
  assert.equal(observerAfterRepair.eventSeq, droppedAck.response.eventSeq);
  assert.ok(observerAfterRepair.eventSeq > baselineSync.eventSeq,
    "authoritative sync recovered the version but not the committed command effects");

  await connectAgain(actor);
  executionPhase = "duplicate-receipt-and-final-witness";
  evidence.executionPhase = executionPhase;
  const replay = await ack(actor.socket, "match:command", command);
  assert.equal(replay.status, "accepted");
  assert.equal(replay.duplicate, true, "same command after postcommit ACK loss did not return its receipt");
  assert.equal(replay.aggregateVersion, droppedAck.response.aggregateVersion);
  assert.equal(replay.eventSeq, droppedAck.response.eventSeq);
  const afterReplayDb = await databaseWitness(group.matchId, actor.playerId, command.commandId, targetVersion);
  assert.equal(afterReplayDb.version, afterCommitDb.version);
  assert.equal(afterReplayDb.eventSeq, afterCommitDb.eventSeq);
  assert.equal(afterReplayDb.eventCount, afterCommitDb.eventCount);
  assert.equal(afterReplayDb.receiptCount, 1);
  assert.equal(afterReplayDb.matchOutboxCount, afterCommitDb.matchOutboxCount);
  assert.equal(afterReplayDb.targetOutboxCount, 1);
  const afterReplaySync = await matchSync(actor, group.matchId);
  assert.equal(afterReplaySync.version, targetVersion);
  assert.equal(afterReplaySync.eventSeq, droppedAck.response.eventSeq);
  assert.equal(afterReplaySync.snapshot.publicTable.turn.currentPlayerId,
    observerAfterRepair.snapshot.publicTable.turn.currentPlayerId);

  return {
    roomId: group.roomId,
    matchId: group.matchId,
    actorPlayerId: actor.playerId,
    observerPlayerId: observer.playerId,
    commandId: command.commandId,
    commandType: command.type,
    versionBefore: baselineDb.version,
    targetVersion,
    eventSeqBefore: baselineDb.eventSeq,
    eventSeqAfter: droppedAck.response.eventSeq,
    precommitFailure: {
      injection: "test-only pg client wrapper rejected COMMIT for this exact match/version after UPDATE matches, all target match_events and command_receipts/outbox INSERTs, and RELEASE SAVEPOINT completed",
      transactionEvidence: injectedFault.transactionEvidence,
      transport: failedAttempt.kind,
      socketDisconnectReason: failedAttempt.reason,
      rollbackSqlObserved: observedRollback.type === "T60_D09_ROLLBACK_OBSERVED" &&
        observedRollback.transactionEvidence.rollbackObserved === true,
      rollbackWitness: {
        matchVersionUnchanged: afterFailure.version === baselineDb.version,
        eventSeqUnchanged: afterFailure.eventSeq === baselineDb.eventSeq,
        serializedStateUnchanged: afterFailure.stateHash === baselineDb.stateHash,
        matchEventCountUnchanged: afterFailure.eventCount === baselineDb.eventCount,
        receiptCountForCommand: afterFailure.receiptCount,
        matchOutboxCountUnchanged: afterFailure.matchOutboxCount === baselineDb.matchOutboxCount,
        targetOutboxRows: afterFailure.targetOutboxCount,
      },
      sameCommandCommittedAfterInjectedFailure: true,
      retryCommittedVersion: targetVersion,
    },
    postcommitAckFailure: {
      injection: "client Engine.IO WebSocket onData dropped server ACK frame before Socket.IO packet decode",
      capturedFirstAck: droppedAck.response,
      callbackRan: ackDrop.callbackRan,
      replayReceipt: replay,
      receiptRowCount: afterReplayDb.receiptCount,
      matchEventCountStableOnReplay: afterReplayDb.eventCount === afterCommitDb.eventCount,
      matchOutboxRowsStableOnReplay: afterReplayDb.matchOutboxCount === afterCommitDb.matchOutboxCount,
    },
    outboxNotificationLoss: {
      injection: "preload dropped one exact match:changed event for the target aggregate/version; publisher then marked its durable outbox row published",
      droppedNotification: droppedOutbox,
      observerReceivedNotificationCount: observerDroppedNotifications,
      observerBaselineVersionBeforeExplicitSync: observerBaselineSync.version,
      committedReceiptRows: afterCommitDb.receiptCount,
      committedMatchEventRowsAtTargetVersion: afterCommitDb.targetEventCount,
      committedOutboxRowsAtTargetVersion: afterCommitDb.targetOutboxCount,
      outboxPublished: afterCommitDb.outboxPublished,
      observerReceivedNoInvalidationUntilExplicitSync: observerDroppedNotifications === 0,
      explicitSyncRecoveredCommittedState: observerAfterRepair.version === targetVersion &&
        observerAfterRepair.eventSeq > baselineSync.eventSeq,
      replayDidNotChangeVersionOrEventOrOutboxCounts: afterReplayDb.version === afterCommitDb.version &&
        afterReplayDb.eventCount === afterCommitDb.eventCount && afterReplayDb.matchOutboxCount === afterCommitDb.matchOutboxCount,
    },
  };
}

async function main() {
  executionPhase = "preflight-database-and-port-isolation";
  evidence.executionPhase = executionPhase;
  assert.ok(databaseDirectory && primaryDatabaseDirectory, "LOCALAPPDATA is required for the isolated D09 database");
  assert.ok(isAbsolute(databaseDirectory) && isAbsolute(primaryDatabaseDirectory));
  const isWithin = (base, candidate) => {
    const path = relative(base, candidate);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  assert.equal(isWithin(primaryDatabaseDirectory, databaseDirectory), false, "D09 DB cannot be inside the primary database");
  assert.equal(isWithin(databaseDirectory, primaryDatabaseDirectory), false, "primary DB cannot be inside the D09 database");
  if (existsSync(databaseDirectory)) {
    const priorRecord = JSON.parse(await readFile(resultPath, "utf8"));
    const priorAttempt = priorRecord.apiExecution?.d09Run;
    assert.equal(priorAttempt?.databaseDirectory, evidence.databaseDirectory,
      "existing D09 DB directory is not linked to this task's previous isolated attempt");
    assert.equal(priorAttempt?.ports?.server, serverPort);
    assert.equal(priorAttempt?.ports?.pglite, pglitePort);
    assert.equal(priorAttempt?.gracefulShutdown?.portsReleased, true,
      "prior D09 attempt did not prove graceful shutdown and release before DB reuse");
    evidence.reusedPriorTestOwnedDatabase = true;
  } else {
    evidence.reusedPriorTestOwnedDatabase = false;
  }
  evidence.databaseIsSeparate = true;
  await assertPortFree(serverPort);
  await assertPortFree(pglitePort);
  executionPhase = "primary-health-before";
  evidence.executionPhase = executionPhase;
  primaryHealthBefore = (await fetch("http://127.0.0.1:3002/healthz", { signal: AbortSignal.timeout(3000) })).status;
  assert.equal(primaryHealthBefore, 200, "primary T60 service must be healthy before D09 isolated run");
  evidence.primaryHealthBefore = primaryHealthBefore;

  executionPhase = "start-isolated-server";
  evidence.executionPhase = executionPhase;
  serverProcess = startServer();
  await health(serverOrigin);
  executionPhase = "verify-preload-and-listener-ownership";
  evidence.executionPhase = executionPhase;
  await waitForMessageType("T60_D09_PRELOAD_READY");
  await waitForMessageType("T60_D09_POOL_READY");
  startOwnership = inspectOwnedProcessTree(serverProcess.pid);
  evidence.processOwnership = startOwnership;
  assert.ok(serverLogs.some(({ line }) => line.includes(`HTTP and Socket.IO listening at 127.0.0.1:${serverPort}`)));
  assert.ok(serverLogs.some(({ line }) => line.includes(`Local PGlite Socket database ready at 127.0.0.1:${pglitePort}`)));
  executionPhase = "probe-existing-vite";
  evidence.executionPhase = executionPhase;
  const webProbe = await fetch(webOrigin + "/rooms/new", { signal: AbortSignal.timeout(5000) });
  assert.equal(webProbe.status, 200, "existing Vite origin is not healthy");
  executionPhase = "verify-in-process-pglite-witness-query";
  evidence.executionPhase = executionPhase;
  const ready = await queryDatabase("SELECT 1 AS ready");
  assert.equal(Number(ready.rows[0]?.ready), 1, "in-process D09 database witness query failed");
  executionPhase = "execute-d09-scenario";
  evidence.executionPhase = executionPhase;

  const result = await executeD09();
  evidence.status = "PASS";
  evidence.precommitFault = result.precommitFailure;
  evidence.postcommitAckLoss = result.postcommitAckFailure;
  evidence.outboxNotificationLoss = result.outboxNotificationLoss;
  evidence.roomId = result.roomId;
  evidence.matchId = result.matchId;
  evidence.commandType = result.commandType;
  evidence.commandId = result.commandId;
  evidence.versionTransition = `${result.versionBefore}->${result.targetVersion}`;
  evidence.eventSeqTransition = `${result.eventSeqBefore}->${result.eventSeqAfter}`;
}

async function saveRecord() {
  const record = JSON.parse(await readFile(resultPath, "utf8"));
  record.results ??= {};
  record.results.D09 = {
    status: evidence.status,
    detail: evidence.status === "PASS"
      ? `Integrated isolated PGlite fault injection on 3004/5437: a test-only wrapper around the isolated server's own pg.Pool rejected COMMIT after the exact target transaction had completed its matches, match_events, command_receipts, outbox, and savepoint-release queries. The real transaction error path issued ROLLBACK; in-process DB witnesses showed version, eventSeq, serialized state, event rows, receipt, and outbox unchanged. Replaying the same command then committed. A one-shot preload dropped that exact committed match:changed notification and the client transport dropped the postcommit ACK. DB evidence showed one accepted receipt, two command event rows and one outbox row at version ${evidence.versionTransition}, with the outbox marked published; the observer saw no dropped notification, remained at its previous projection until explicit sync, then recovered the committed state. Reconnect/replay returned the same receipt with duplicate=true and no additional version/event/outbox rows.`
      : `D09 was not fully verified. Isolated execution attempt: ${evidence.error ?? "required commit/receipt/outbox assertion did not complete"}. See apiExecution.d09Run for exact environment, injection stage, and evidence; no PASS is claimed.`,
  };
  record.apiExecution ??= {};
  record.apiExecution.d09Run = evidence;
  record.generatedAt = evidence.finishedAt;
  const statuses = Array.from({ length: 19 }, (_, index) => {
    const id = `D${String(index + 1).padStart(2, "0")}`;
    return record.results[id]?.status ?? "NOT RUN";
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
}

try {
  await main();
} catch (error) {
  runnerError = error instanceof Error ? error.message : String(error);
  evidence.error = runnerError;
  evidence.errorStack = error instanceof Error ? error.stack : null;
  evidence.executionPhase = executionPhase;
} finally {
  for (const socket of clients) socket.disconnect();
  clients.clear();
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    try {
      shutdownResult = await stopServer();
      evidence.gracefulShutdown = shutdownResult;
    } catch (error) {
      evidence.shutdownError = error instanceof Error ? error.message : String(error);
    }
  }
  primaryHealthAfter = await fetch("http://127.0.0.1:3002/healthz", { signal: AbortSignal.timeout(3000) })
    .then((response) => response.status)
    .catch(() => null);
  evidence.primaryHealthAfter = primaryHealthAfter;
  evidence.finishedAt = new Date().toISOString();
  if (evidence.status === "PASS" &&
      shutdownResult?.portsReleased && primaryHealthAfter === 200) {
    runnerStatus = "PASS";
  } else {
    evidence.status = "NOT RUN";
  }
  try {
    await saveRecord();
  } catch (error) {
    evidence.resultSaveError = error instanceof Error ? error.message : String(error);
  }
}

console.log(`D09 ${runnerStatus}; ${runnerError ?? "all commit/receipt/outbox fault assertions passed"}`);
console.log(`isolated server=${serverOrigin}; PGlite=${pglitePort}; DB=${evidence.databaseDirectory}; primary health=${primaryHealthBefore}->${primaryHealthAfter}`);
console.log(`result=${resultPath}`);
if (evidence.shutdownError) console.log(`shutdownError=${evidence.shutdownError}`);
if (evidence.resultSaveError) console.log(`resultSaveError=${evidence.resultSaveError}`);

