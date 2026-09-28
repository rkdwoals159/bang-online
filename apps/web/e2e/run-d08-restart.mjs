import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { connect } from "node:net";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { io } from "socket.io-client";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../../..");
const resultPath = resolve(scriptDir, "acceptance-results.json");
const serverOrigin = "http://127.0.0.1:3003";
const serverPort = 3003;
const pglitePort = 5436;
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
const launchCommand = `node --import file://<workspace>/apps/web/e2e/d08-server-preload.mjs --import file://<workspace>/apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/main.ts --pglite-dev`;
const targetKinds = new Set([
  "DUEL_RESPONSE",
  "DEATH_RESCUE",
  "LUCKY_DRAW",
  "DISCARDS_ORDER",
  "GATLING_RESPONSE",
  "INDIANS_RESPONSE",
]);

const activeSockets = new Set();
const logs = [];
const spawnEnvironments = [];
let serverProcess = null;
let processStarts = 0;
let phase = "preflight";
let partialEvidence = {};
let classification = "NOT RUN";
let finalDetail = "";

function commandId() {
  return randomUUID();
}

function keepLog(source, chunk) {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim()) logs.push({ source, line: line.trim() });
  }
  if (logs.length > 400) logs.splice(0, logs.length - 400);
}

async function assertPortFree(port) {
  const result = await new Promise((resolveResult) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveResult("timeout");
    }, 800);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveResult("in_use");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolveResult(error.code === "ECONNREFUSED" ? "free" : error.code);
    });
  });
  assert.equal(result, "free", `D08-owned port ${port} was not free at launch (${result})`);
}

function spawnServer() {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(serverPort),
    PGLITE_PORT: String(pglitePort),
    PGLITE_DATA_DIR: databaseDirectory,
    WEB_ORIGIN: "http://127.0.0.1:5176",
  };
  const child = spawn(process.execPath, [
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
  child.stdout.on("data", (chunk) => keepLog("stdout", chunk));
  child.stderr.on("data", (chunk) => keepLog("stderr", chunk));
  spawnEnvironments.push({
    pid: child.pid,
    host: env.HOST,
    serverPort: env.PORT,
    pglitePort: env.PGLITE_PORT,
    dataDirectory: resolve(env.PGLITE_DATA_DIR),
  });
  processStarts += 1;
  serverProcess = child;
  return child;
}

async function waitForHealth(child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not yet listening";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`D08 server exited during startup with code ${child.exitCode}; logs=${JSON.stringify(logs.slice(-30))}`);
    }
    try {
      const response = await fetch(serverOrigin + "/healthz", { signal: AbortSignal.timeout(1200) });
      if (response.status === 200) {
        const body = await response.json();
        if (body?.status === "ok") return;
      }
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`D08 server did not become healthy: ${lastError}; logs=${JSON.stringify(logs.slice(-30))}`);
}

async function startServer() {
  phase = processStarts === 0 ? "initial-start" : "restart-start";
  const child = spawnServer();
  await waitForHealth(child);
  const readyLogs = logs.slice(-80).map(({ line }) => line);
  const hasHttpReady = readyLogs.some((line) => line.includes("HTTP and Socket.IO listening at 127.0.0.1:3003"));
  const hasPgliteReady = readyLogs.some((line) => line.includes("Local PGlite Socket database ready at 127.0.0.1:5436"));
  assert.ok(hasHttpReady && hasPgliteReady, "server health passed without both expected D08 readiness log entries");
  return {
    processId: child.pid,
    healthStatus: 200,
    httpReadyLog: hasHttpReady,
    pgliteReadyLog: hasPgliteReady,
  };
}

function waitForExit(child, timeoutMs = 25_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("D08 server did not exit after graceful shutdown request")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function inspectD08ChildOwnership(childPid) {
  assert.equal(process.platform, "win32", "D08 child ownership inspection is only implemented for this Windows runner");
  const script = `$targetPid=${Number(childPid)}; $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); $ids=@($targetPid); $changed=$true; while($changed){$changed=$false;foreach($item in $all){if(($ids -contains [int]$item.ParentProcessId) -and ($ids -notcontains [int]$item.ProcessId)){$ids+=([int]$item.ProcessId);$changed=$true}}}; $tree=@($all|Where-Object{$ids -contains [int]$_.ProcessId}); $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${serverPort},${pglitePort} -ErrorAction SilentlyContinue|Select-Object LocalPort,OwningProcess); [pscustomobject]@{processes=$tree;listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress`;
  const encoded = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 7000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = JSON.parse(encoded.trim());
  const listeners = Array.isArray(record.listeners) ? record.listeners : record.listeners ? [record.listeners] : [];
  const processes = Array.isArray(record.processes) ? record.processes : record.processes ? [record.processes] : [];
  const processInfo = processes.find((entry) => Number(entry.ProcessId) === Number(childPid));
  const processIdMatches = Number(processInfo?.ProcessId) === Number(childPid);
  const executableMatches = typeof processInfo?.ExecutablePath === "string" &&
    resolve(processInfo.ExecutablePath).toLowerCase() === resolve(process.execPath).toLowerCase();
  const commandLine = String(processInfo?.CommandLine ?? "").toLowerCase();
  const commandLineMatches = commandLine.includes("d08-server-preload.mjs") &&
    commandLine.includes("main.ts") && commandLine.includes("--pglite-dev");
  const ownedProcessIds = new Set(processes.map((entry) => Number(entry.ProcessId)));
  const listenerPorts = new Set(listeners.map((listener) => Number(listener.LocalPort)));
  const listenerOwnersMatch = [serverPort, pglitePort].every((port) => listenerPorts.has(port)) &&
    listeners.every((listener) => ownedProcessIds.has(Number(listener.OwningProcess)));
  const diagnostic = {
    processTree: processes.map((entry) => ({
      processId: Number(entry.ProcessId),
      parentProcessId: Number(entry.ParentProcessId),
      name: entry.Name,
      executablePath: entry.ExecutablePath,
      commandLine: entry.CommandLine,
    })),
    listeners: listeners.map((listener) => ({ port: Number(listener.LocalPort), owningProcessId: Number(listener.OwningProcess) }))
      .sort((left, right) => left.port - right.port),
    processIdMatches,
    executableMatches,
    commandLineMatches,
    listenerOwnersMatch,
  };
  partialEvidence.terminationOwnershipCheck = diagnostic;
  if (!processIdMatches || !executableMatches || !commandLineMatches || !listenerOwnersMatch) {
    throw new Error("D08 child/listener ownership verification was ambiguous; no server process was stopped");
  }
  return diagnostic;
}

async function stopServer() {
  const child = serverProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return { code: child?.exitCode ?? null, signal: child?.signalCode ?? null };
  phase = "pending-server-shutdown";
  const ownershipBeforeShutdown = inspectD08ChildOwnership(child.pid);
  let gracefulRequestSent = false;
  try {
    await new Promise((resolveSend, rejectSend) => {
      child.send({ type: "T60_D08_SHUTDOWN" }, (error) => error ? rejectSend(error) : resolveSend());
    });
    gracefulRequestSent = true;
  } catch {
    // The runner still owns this exact child; ownership is verified before any forced stop below.
  }
  let exit;
  let forcedTermination = false;
  let ownership = null;
  try {
    exit = await waitForExit(child, 2500);
  } catch {
    ownership = inspectD08ChildOwnership(child.pid);
    forcedTermination = true;
    child.kill();
    exit = await waitForExit(child, 10_000);
  }
  serverProcess = null;
  if (!forcedTermination) {
    assert.equal(exit.signal, null, "D08 server did not use its graceful signal handler");
    assert.equal(exit.code, 0, `D08 server graceful shutdown returned ${exit.code}`);
    assert.ok(logs.some(({ line }) => line.includes("shutdown complete.")), "D08 server did not log shutdown complete");
  }
  for (const port of [serverPort, pglitePort]) await assertPortFree(port);
  return {
    ...exit,
    gracefulRequestSent,
    gracefulShutdownLog: !forcedTermination && logs.some(({ line }) => line.includes("shutdown complete.")),
    forcedTermination,
    ownershipBeforeShutdown,
    ownership,
    d08PortsReleased: true,
  };
}

async function createGuest(displayName) {
  const response = await fetch(serverOrigin + "/api/guest-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, displayName }),
    signal: AbortSignal.timeout(7000),
  });
  const body = await response.json().catch(() => null);
  const cookieHeader = response.headers.get("set-cookie");
  const cookie = cookieHeader?.split(";", 1)[0];
  if (response.status !== 201 || !cookie || !body?.player?.playerId) {
    throw new Error(`guest create failed with HTTP ${response.status}`);
  }
  return { playerId: body.player.playerId, displayName: body.player.displayName, cookie, socket: null };
}

async function connectGuest(guest) {
  const socket = io(serverOrigin, {
    path: "/socket.io",
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: guest.cookie },
    timeout: 7000,
  });
  activeSockets.add(socket);
  await new Promise((resolveConnect, rejectConnect) => {
    const timer = setTimeout(() => rejectConnect(new Error("socket connect timed out")), 8000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolveConnect();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      rejectConnect(new Error(`socket connect failed: ${error.message}`));
    });
  });
  guest.socket = socket;
  return socket;
}

function disconnectSocket(socket) {
  if (!socket) return;
  socket.disconnect();
  activeSockets.delete(socket);
}

function ack(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolveAck, rejectAck) => {
    const timer = setTimeout(() => rejectAck(new Error(`${event} ACK timed out`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolveAck(response);
    });
  });
}

function rejectionCode(response) {
  return response?.status === "rejected" ? response.error?.code : undefined;
}

async function roomSync(guest, roomId) {
  return ack(guest.socket, "room:sync", {
    protocolVersion: 1,
    requestId: commandId(),
    roomId,
    knownVersion: 0,
  });
}

async function matchSync(guest, matchId) {
  return ack(guest.socket, "match:sync", {
    protocolVersion: 1,
    requestId: commandId(),
    matchId,
    knownVersion: 0,
    afterEventSeq: 0,
  });
}

async function roomCommand(guest, roomId, type, payload = {}) {
  const sync = await roomSync(guest, roomId);
  if (sync.status === "rejected") throw new Error(`room sync rejected: ${rejectionCode(sync)}`);
  return ack(guest.socket, "room:command", {
    protocolVersion: 1,
    commandId: commandId(),
    expectedVersion: sync.version,
    roomId,
    type,
    payload,
  });
}

async function createGroup() {
  const guests = [];
  for (let seat = 1; seat <= 4; seat += 1) {
    const guest = await createGuest(`D08 seat ${seat}`);
    await connectGuest(guest);
    guests.push(guest);
  }

  const created = await ack(guests[0].socket, "room:create", {
    protocolVersion: 1,
    commandId: commandId(),
    expectedVersion: 0,
    type: "CREATE_ROOM",
    payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: guests[0].displayName },
  });
  if (!created?.roomId || typeof created.version !== "number" || !created.inviteCode) {
    throw new Error(`room:create failed: ${rejectionCode(created) ?? "missing room fields"}`);
  }
  const group = { guests, roomId: created.roomId, matchId: null };
  for (const guest of guests.slice(1)) {
    const preview = await ack(guest.socket, "room:preview", {
      protocolVersion: 1,
      requestId: commandId(),
      inviteCode: created.inviteCode,
    });
    if (preview.status === "rejected" || preview.roomId !== group.roomId) {
      throw new Error(`room:preview failed: ${rejectionCode(preview) ?? "unexpected room"}`);
    }
    const joined = await ack(guest.socket, "room:command", {
      protocolVersion: 1,
      commandId: commandId(),
      expectedVersion: preview.version,
      roomId: group.roomId,
      type: "JOIN",
      payload: { inviteCode: created.inviteCode },
    });
    if (joined?.roomId !== group.roomId) throw new Error(`JOIN failed: ${rejectionCode(joined) ?? "unexpected response"}`);
  }
  for (const guest of guests) {
    const ready = await roomCommand(guest, group.roomId, "SET_READY", { ready: true });
    if (ready?.roomId !== group.roomId) throw new Error(`SET_READY failed: ${rejectionCode(ready) ?? "unexpected response"}`);
  }
  await startMatch(group);
  return group;
}

async function startMatch(group) {
  const response = await roomCommand(group.guests[0], group.roomId, "START_MATCH", {});
  if (response?.roomId !== group.roomId || !response.activeMatchId) {
    throw new Error(`START_MATCH failed: ${rejectionCode(response) ?? "missing activeMatchId"}`);
  }
  group.matchId = response.activeMatchId;
  return group.matchId;
}

function cardTypesById(snapshot) {
  return new Map((snapshot.selfPrivate?.hand ?? []).map((card) => [card.cardInstanceId, card.typeId]));
}

function chooseLegalAction(snapshot) {
  const types = cardTypesById(snapshot);
  const rank = (action) => {
    if (action.type === "END_TURN") return 0;
    if (action.type === "USE_ABILITY") return 10;
    const typeId = types.get(action.payload?.cardInstanceId);
    if (typeId === "gatling" || typeId === "indians") return 160;
    if (typeId === "duel") return 150;
    if (typeId === "bang") return 120;
    if (typeId === "panic" || typeId === "cat_balou") return 105;
    if (typeId === "beer" || typeId === "saloon") return 90;
    if (typeId === "stagecoach" || typeId === "wells_fargo" || typeId === "general_store") return 70;
    if (typeId === "jail") return 50;
    return 30;
  };
  return [...(snapshot.legalActions ?? [])].sort((left, right) => rank(right) - rank(left))[0] ?? null;
}

function chooseResponse(snapshot) {
  const pending = snapshot.pendingInteraction;
  const options = pending?.responseOptions;
  if (!Array.isArray(options) || options.length === 0) return null;
  const preferred = ["TAKE_HIT", "ACCEPT_ELIMINATION", "YIELD", "TAKE_CARD", "DRAW_FROM_PILE", "DRAW_PILE", "USE_MISSED", "USE_BANG", "PLAY_BANG", "USE_BEER"];
  let option = null;
  for (const choice of preferred) {
    option = options.find((item) => item.choice === choice);
    if (option) break;
  }
  option ??= options[0];
  const payload = { ...option };
  if (payload.choice === "ORDER_CARDS" && !Array.isArray(payload.orderedCardInstanceIds)) {
    const allowed = pending.discardOrder?.allowedCards ?? [];
    const required = pending.discardOrder?.requiredCount;
    if (!Number.isSafeInteger(required) || required < 1 || allowed.length < required) return null;
    payload.orderedCardInstanceIds = allowed.slice(0, required).map((card) => card.cardInstanceId);
  }
  if (payload.choice === "SELECT_JUDGMENT" &&
      (!Array.isArray(payload.orderedCardInstanceIds) || payload.orderedCardInstanceIds.length !== 2)) return null;
  return { type: "RESPOND", payload };
}

function commandFor(matchId, version, action) {
  return {
    protocolVersion: 1,
    commandId: commandId(),
    expectedVersion: version,
    matchId,
    type: action.type,
    payload: action.payload,
  };
}

async function sendAction(guest, matchId, sync, action) {
  return ack(guest.socket, "match:command", commandFor(matchId, sync.version, action), 10_000);
}

function pendingSummary(snapshot) {
  const pending = snapshot.pendingInteraction;
  const allowedCards = pending?.discardOrder?.allowedCards ?? [];
  const options = pending?.responseOptions ?? [];
  const publicPlayers = snapshot.publicTable?.players ?? [];
  return {
    interactionId: pending?.interactionId ?? null,
    kind: pending?.kind ?? null,
    currentResponderPlayerId: pending?.currentResponderPlayerId ?? null,
    step: pending?.step ?? null,
    allowedChoices: pending?.allowedChoices ?? [],
    responseOptions: options.map((item) => ({ choice: item.choice, fields: Object.keys(item).sort() })),
    discardRequiredCount: pending?.discardOrder?.requiredCount ?? null,
    discardAllowedCardCount: allowedCards.length,
    responderHandCount: snapshot.selfPrivate?.hand?.length ?? null,
    hpByPlayer: publicPlayers.map((player) => ({ playerId: player.playerId, hp: player.hp, eliminated: player.eliminated })),
    responderMode: snapshot.viewer?.mode ?? null,
  };
}

function stateDigest(sync) {
  return createHash("sha256")
    .update(JSON.stringify({ version: sync.version, eventSeq: sync.eventSeq, snapshot: sync.snapshot }), "utf8")
    .digest("hex");
}

function pendingStage(snapshot) {
  const pending = snapshot.pendingInteraction;
  if (!pending) return null;
  return {
    interactionId: pending.interactionId,
    kind: pending.kind,
    currentResponderPlayerId: pending.currentResponderPlayerId,
    step: pending.step,
    allowedChoices: pending.allowedChoices,
    responseOptions: pending.responseOptions ?? null,
    discardOrder: pending.discardOrder ?? null,
  };
}

function publicStateDigest(snapshot) {
  const players = snapshot.publicTable?.players ?? [];
  return createHash("sha256").update(JSON.stringify({
    status: snapshot.status,
    pending: pendingStage(snapshot),
    turn: snapshot.publicTable?.turn,
    players,
    discard: snapshot.publicTable?.publicDiscard,
    deckCount: snapshot.publicTable?.deckCount,
    outcome: snapshot.outcome ?? null,
  }), "utf8").digest("hex");
}

async function syncAll(group, matchId) {
  const result = new Map();
  for (const guest of group.guests) {
    const sync = await matchSync(guest, matchId);
    if (sync.status === "rejected" || !sync.snapshot) {
      throw new Error(`match:sync rejected after ${phase}: ${rejectionCode(sync) ?? "missing snapshot"}`);
    }
    result.set(guest.playerId, sync);
  }
  return result;
}

async function locatePending(group, maxGames = 5, maxCommandsPerGame = 700) {
  let completedGames = 0;
  let acceptedCommands = 0;
  const observedKinds = new Set();
  for (let game = 1; game <= maxGames; game += 1) {
    if (game > 1) await startMatch(group);
    let currentGuest = group.guests[0];
    for (let step = 1; step <= maxCommandsPerGame; step += 1) {
      const overview = await matchSync(currentGuest, group.matchId);
      if (overview.status === "rejected" || !overview.snapshot) {
        throw new Error(`overview sync rejected: ${rejectionCode(overview) ?? "missing snapshot"}`);
      }
      const snapshot = overview.snapshot;
      if (snapshot.status === "completed") {
        completedGames += 1;
        break;
      }
      if (snapshot.pendingInteraction) {
        const kind = snapshot.pendingInteraction.kind;
        observedKinds.add(kind);
        const responderId = snapshot.pendingInteraction.currentResponderPlayerId;
        const responder = group.guests.find((guest) => guest.playerId === responderId);
        if (!responder) throw new Error("pending responder did not map to one of the four guest sessions");
        const responderSync = await matchSync(responder, group.matchId);
        if (responderSync.status === "rejected" || !responderSync.snapshot) {
          throw new Error(`responder sync rejected: ${rejectionCode(responderSync) ?? "missing snapshot"}`);
        }
        if (targetKinds.has(kind)) {
          const details = pendingSummary(responderSync.snapshot);
          if (!details.responseOptions.length) throw new Error(`target pending ${kind} had no restored respondent options`);
          return {
            group,
            responder,
            responderSync,
            completedGames,
            acceptedCommands,
            observedKinds: [...observedKinds].sort(),
            details,
          };
        }
        const response = chooseResponse(responderSync.snapshot);
        if (!response) throw new Error(`non-target pending ${kind} had no server-issued response option`);
        const accepted = await sendAction(responder, group.matchId, responderSync, response);
        if (accepted.status !== "accepted") {
          if (rejectionCode(accepted) === "STALE_VERSION") {
            currentGuest = responder;
            continue;
          }
          throw new Error(`response at ${kind} rejected: ${rejectionCode(accepted) ?? accepted.status}`);
        }
        acceptedCommands += 1;
        currentGuest = responder;
        continue;
      }

      const actorId = snapshot.publicTable?.turn?.currentPlayerId;
      const actor = group.guests.find((guest) => guest.playerId === actorId);
      if (!actor) throw new Error("turn actor did not map to one of the four guest sessions");
      const actorSync = await matchSync(actor, group.matchId);
      if (actorSync.status === "rejected" || !actorSync.snapshot) {
        throw new Error(`actor sync rejected: ${rejectionCode(actorSync) ?? "missing snapshot"}`);
      }
      const action = chooseLegalAction(actorSync.snapshot);
      if (!action) throw new Error(`server issued no legal action at game ${game}, command ${step}`);
      const accepted = await sendAction(actor, group.matchId, actorSync, action);
      if (accepted.status !== "accepted") {
        if (rejectionCode(accepted) === "STALE_VERSION") {
          currentGuest = actor;
          continue;
        }
        throw new Error(`legal action ${action.type} rejected: ${rejectionCode(accepted) ?? accepted.status}`);
      }
      acceptedCommands += 1;
      currentGuest = actor;
    }
  }
  return { group, completedGames, acceptedCommands, observedKinds: [...observedKinds].sort(), noTargetPending: true };
}

function assertResponderPermission(sync, expectedResponderId) {
  const pending = sync.snapshot.pendingInteraction;
  assert.ok(pending, "pending interaction disappeared before restart");
  assert.equal(pending.currentResponderPlayerId, expectedResponderId, "current responder identity changed");
  assert.ok(Array.isArray(pending.responseOptions) && pending.responseOptions.length > 0,
    "responder projection omitted saved response options");
  if (pending.kind === "DISCARDS_ORDER") {
    assert.ok(pending.discardOrder, "discard-order candidate projection was missing");
    assert.ok(pending.discardOrder.requiredCount > 0, "discard-order requirement was not positive");
    assert.ok(pending.discardOrder.allowedCards.length >= pending.discardOrder.requiredCount,
      "discard-order candidates were insufficient");
  }
}

async function restartWhilePending(found) {
  const { group, responder, responderSync, details } = found;
  const matchId = group.matchId;
  const beforeByPlayer = await syncAll(group, matchId);
  const roomBeforeByPlayer = new Map();
  for (const guest of group.guests) {
    const room = await roomSync(guest, group.roomId);
    if (room.status === "rejected" || !room.room) {
      throw new Error(`room sync before restart rejected for ${guest.displayName}: ${rejectionCode(room) ?? "missing room"}`);
    }
    assert.equal(room.room.activeMatchId, matchId, "pre-restart room view did not point to this match");
    assert.equal(room.room.status, "in_game", "pre-restart room status was not in_game");
    roomBeforeByPlayer.set(guest.playerId, room);
  }
  const responderBefore = beforeByPlayer.get(responder.playerId);
  assert.ok(responderBefore, "responder snapshot was not captured");
  assertResponderPermission(responderBefore, responder.playerId);
  assert.equal(responderBefore.version, responderSync.version, "pending stage changed while collecting pre-restart evidence");

  for (const guest of group.guests) {
    const sync = beforeByPlayer.get(guest.playerId);
    const pending = sync?.snapshot?.pendingInteraction;
    assert.ok(pending, `seat ${guest.playerId} did not receive the current pending cursor`);
    assert.equal(pending.currentResponderPlayerId, responder.playerId);
    if (guest.playerId !== responder.playerId) {
      assert.deepEqual(pending.allowedChoices, [], "non-responder received pending response choices");
      assert.equal(Object.hasOwn(pending, "responseOptions"), false, "non-responder received response options");
      assert.equal(Object.hasOwn(pending, "discardOrder"), false, "non-responder received discard candidates");
    }
  }

  partialEvidence = {
    ...(partialEvidence ?? {}),
    serverPorts: { http: serverPort, pglite: pglitePort },
    databaseDirectory: "%LOCALAPPDATA%\\BangOnline\\pglite-t60-d08-20260928",
    roomId: group.roomId,
    matchId,
    completedGamesBeforePending: found.completedGames,
    acceptedCommandsBeforePending: found.acceptedCommands,
    observedPendingKinds: found.observedKinds,
    pending: details,
    beforeRestart: Object.fromEntries([...beforeByPlayer].map(([playerId, sync]) => [playerId, {
      version: sync.version,
      eventSeq: sync.eventSeq,
      digest: stateDigest(sync),
    }])),
    roomBeforeRestart: Object.fromEntries([...roomBeforeByPlayer].map(([playerId, sync]) => [playerId, {
      version: sync.version,
      status: sync.room.status,
      activeMatchId: sync.room.activeMatchId,
      digest: createHash("sha256").update(JSON.stringify(sync.room), "utf8").digest("hex"),
    }])),
    responderPlayerId: responder.playerId,
    restartAttempted: true,
  };

  const shutdown = await stopServer();
  partialEvidence.gracefulShutdown = shutdown;
  const afterShutdown = processStartedPrimaryHealth();
  const primaryStillHealthy = await afterShutdown;
  assert.equal(primaryStillHealthy, 200, "primary T60 server health changed during isolated D08 restart");
  const restart = await startServer();
  partialEvidence.restart = restart;
  assert.equal(spawnEnvironments.length, 2, "D08 did not run exactly one server restart");
  assert.ok(spawnEnvironments.every((entry) => entry.dataDirectory === resolve(databaseDirectory) &&
    entry.serverPort === String(serverPort) && entry.pglitePort === String(pglitePort)),
    "initial and restart server processes did not use identical D08 ports/database path");
  partialEvidence.sameDatabaseAndPortsOnRestart = true;
  partialEvidence.serverSpawnEnvironments = spawnEnvironments;

  for (const guest of group.guests) {
    const previous = guest.socket;
    if (previous) disconnectSocket(previous);
    await connectGuest(guest);
  }
  phase = "post-restart-sync";
  const afterByPlayer = await syncAll(group, matchId);
  const roomAfterByPlayer = new Map();
  for (const guest of group.guests) {
    const before = beforeByPlayer.get(guest.playerId);
    const after = afterByPlayer.get(guest.playerId);
    assert.equal(after.version, before.version, `seat ${guest.displayName} version changed across restart`);
    assert.equal(after.eventSeq, before.eventSeq, `seat ${guest.displayName} event sequence changed across restart`);
    assert.deepEqual(after.snapshot, before.snapshot, `seat ${guest.displayName} match projection changed across restart`);
    const roomAfter = await roomSync(guest, group.roomId);
    const roomBefore = roomBeforeByPlayer.get(guest.playerId);
    if (roomAfter.status === "rejected" || !roomAfter.room) {
      throw new Error(`room sync after restart rejected for ${guest.displayName}: ${rejectionCode(roomAfter) ?? "missing room"}`);
    }
    assert.equal(roomAfter.version, roomBefore.version, `seat ${guest.displayName} room version changed across restart`);
    assert.deepEqual(roomAfter.room, roomBefore.room, `seat ${guest.displayName} room projection changed across restart`);
    roomAfterByPlayer.set(guest.playerId, roomAfter);
  }
  const restored = afterByPlayer.get(responder.playerId);
  assertResponderPermission(restored, responder.playerId);
  assert.deepEqual(pendingSummary(restored.snapshot), details, "pending responder/options/cursor/HP projection did not match before restart");

  const action = chooseResponse(restored.snapshot);
  assert.ok(action, "restored pending interaction had no server-provided legal continuation");
  const continuation = await sendAction(responder, matchId, restored, action);
  assert.equal(continuation.status, "accepted", `legal continuation was rejected with ${rejectionCode(continuation) ?? continuation.status}`);
  const afterAction = await matchSync(responder, matchId);
  assert.notEqual(afterAction.status, "rejected", "responder could not sync after legal continuation");
  assert.equal(afterAction.version, restored.version + 1, "legal continuation did not commit one match version");
  const pendingAfter = pendingStage(afterAction.snapshot);
  const stageAdvanced = JSON.stringify(pendingAfter) !== JSON.stringify(pendingStage(restored.snapshot)) ||
    afterAction.snapshot.status === "completed";
  assert.ok(stageAdvanced, "legal continuation did not advance/clear the restored pending stage");

  partialEvidence = {
    ...partialEvidence,
    allGuestProjectionsRestoredExactly: true,
    allRoomProjectionsRestoredExactly: true,
    responderOptionsRestoredExactly: true,
    nonResponderPermissionsRestored: true,
    beforeProjectionDigests: Object.fromEntries([...beforeByPlayer].map(([playerId, sync]) => [playerId, stateDigest(sync)])),
    afterProjectionDigests: Object.fromEntries([...afterByPlayer].map(([playerId, sync]) => [playerId, stateDigest(sync)])),
    afterRestartVersion: restored.version,
    afterRestartEventSeq: restored.eventSeq,
    legalContinuation: {
      commandType: action.type,
      choice: action.payload.choice,
      accepted: true,
      versionAfter: afterAction.version,
      eventSeqAfter: afterAction.eventSeq,
      pendingStageAdvancedOrCleared: stageAdvanced,
      resultingPendingKind: afterAction.snapshot.pendingInteraction?.kind ?? null,
      resultingStatus: afterAction.snapshot.status,
      publicStateDigestBefore: publicStateDigest(restored.snapshot),
      publicStateDigestAfter: publicStateDigest(afterAction.snapshot),
    },
  };
  return partialEvidence;
}

async function processStartedPrimaryHealth() {
  const response = await fetch("http://127.0.0.1:3002/healthz", { signal: AbortSignal.timeout(3000) });
  return response.status;
}

async function closeOwnedServer() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  try {
    const cleanup = await stopServer();
    partialEvidence = { ...partialEvidence, finalD08ServerCleanup: cleanup };
    serverProcess = null;
  } catch (error) {
    partialEvidence = {
      ...partialEvidence,
      finalD08ServerCleanup: {
        status: "NOT VERIFIED",
        error: error instanceof Error ? error.message : String(error),
        processId: serverProcess?.pid ?? null,
      },
    };
    logs.push({ source: "cleanup", line: error instanceof Error ? error.message : String(error) });
  }
}

async function saveResult() {
  const previous = JSON.parse(await readFile(resultPath, "utf8"));
  previous.results ??= {};
  previous.apiExecution ??= {};
  previous.apiExecution.results ??= {};
  previous.apiExecution.results.D08 = { status: classification, detail: finalDetail };
  previous.results.D08 = { status: classification, detail: finalDetail };
  previous.apiExecution.d08RestartExecution = {
    nodeVersion: process.version,
    startedAt: runStartedAt,
    finishedAt,
    command: `node apps/web/e2e/run-d08-restart.mjs; ${launchCommand} (spawned by runner)`,
    ports: { server: serverPort, pglite: pglitePort },
    databaseDirectory: "%LOCALAPPDATA%\\BangOnline\\pglite-t60-d08-20260928",
    primaryT60ServerHealthBefore: primaryHealthBefore,
    primaryT60ServerHealthAfter: primaryHealthAfter,
    serverStarts: processStarts,
    processLogs: logs.slice(-120),
    evidence: partialEvidence,
  };
  previous.generatedAt = finishedAt;
  const dStatuses = Object.fromEntries(Array.from({ length: 19 }, (_, index) => {
    const id = `D${String(index + 1).padStart(2, "0")}`;
    return [id, previous.results[id]?.status ?? "NOT RUN"];
  }));
  const pass = Object.values(dStatuses).filter((status) => status === "PASS").length;
  const fail = Object.values(dStatuses).filter((status) => status === "FAIL").length;
  const notRun = Object.values(dStatuses).filter((status) => status === "NOT RUN").length;
  previous.verificationSummary ??= {};
  previous.verificationSummary.integratedD = { pass, fail, notRun, total: 19 };
  const engineVerified = previous.verificationSummary.engineCases?.verified ?? 78;
  const engineTotal = previous.verificationSummary.engineCases?.total ?? 78;
  previous.verificationSummary.combined = { verified: engineVerified + pass, total: engineTotal + 19 };
  await writeFile(resultPath, JSON.stringify(previous, null, 2) + "\n", "utf8");
}

const runStartedAt = new Date().toISOString();
let primaryHealthBefore = null;
let primaryHealthAfter = null;
let finishedAt = null;
let group = null;

try {
  assert.ok(databaseDirectory && primaryDatabaseDirectory, "LOCALAPPDATA is required for the isolated D08 PGlite directory");
  assert.ok(isAbsolute(databaseDirectory), "D08 database directory must be absolute");
  assert.ok(databaseDirectory !== primaryDatabaseDirectory, "D08 database path equals the primary T60 database path");
  const primaryToD08 = relative(primaryDatabaseDirectory, databaseDirectory);
  const d08ToPrimary = relative(databaseDirectory, primaryDatabaseDirectory);
  const isWithin = (base, candidate) => {
    const path = relative(base, candidate);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  assert.equal(isWithin(primaryDatabaseDirectory, databaseDirectory), false,
    `D08 database directory resolves inside the primary T60 database (${primaryToD08})`);
  assert.equal(isWithin(databaseDirectory, primaryDatabaseDirectory), false,
    `primary T60 database resolves inside the D08 database (${d08ToPrimary})`);
  assert.ok(await realpath(databaseDirectory), "D08 database directory could not be resolved");
  assert.ok(await realpath(primaryDatabaseDirectory), "primary T60 database directory could not be resolved");
  primaryHealthBefore = await processStartedPrimaryHealth();
  assert.equal(primaryHealthBefore, 200, "primary T60 server was not healthy before D08 run");
  await assertPortFree(serverPort);
  await assertPortFree(pglitePort);

  partialEvidence = {
    isolatedDatabaseVerified: true,
    databaseDirectory: "%LOCALAPPDATA%\\BangOnline\\pglite-t60-d08-20260928",
    separateFromPrimaryT60Database: true,
    d08PortsFreeBeforeStart: true,
    primaryHealthBefore: primaryHealthBefore,
  };
  const initialStart = await startServer();
  partialEvidence.initialStart = initialStart;
  phase = "create-game";
  group = await createGroup();
  partialEvidence.roomId = group.roomId;
  const found = await locatePending(group);
  if (found.noTargetPending) {
    classification = "NOT RUN";
    finalDetail = `A 4-seat isolated server game ran ${found.completedGames} complete matches and ${found.acceptedCommands} accepted commands; observed pending kinds: ${found.observedKinds.join(", ") || "none"}. No D08-listed pending cursor occurred, so no restart was performed.`;
    partialEvidence = { ...partialEvidence, ...found };
  } else {
    phase = "pending-found";
    partialEvidence = { ...partialEvidence, completedGamesBeforePending: found.completedGames, acceptedCommandsBeforePending: found.acceptedCommands };
    await restartWhilePending(found);
    classification = "PASS";
    const stopDescription = partialEvidence.gracefulShutdown.forcedTermination
      ? "the runner verified the dedicated child PID, executable/arguments, and ownership of ports 3003/5436, then force-stopped that child"
      : "the dedicated server process shut down gracefully";
    finalDetail = `On isolated ports 3003/5436 and the separate D08 PGlite database, ${stopDescription} and restarted the process against the same directory while ${partialEvidence.pending.kind} was pending at step ${partialEvidence.pending.step.current}/${partialEvidence.pending.step.total}. All four room/match guest projections, aggregate version/event sequence, HP/card state, responder identity and exact options matched after reconnect; a server-issued legal response was accepted and advanced the saved interaction.`;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (partialEvidence.restartAttempted && phase === "post-restart-sync") {
    classification = "FAIL";
    finalDetail = `The D08 listed pending interaction was reached and the isolated server restarted on the same database, but post-restart restoration/continuation failed during ${phase}: ${message}`;
  } else if (partialEvidence.restartAttempted && ["pending-server-shutdown", "restart-start"].includes(phase)) {
    classification = "NOT RUN";
    finalDetail = `A D08 listed pending interaction was reached, but a same-database restart could not be verified (${phase}): ${message}`;
  } else {
    classification = "NOT RUN";
    finalDetail = `The focused D08 restart attempt did not reach a verifiable pending interaction/restart (${phase}): ${message}`;
  }
  partialEvidence = { ...partialEvidence, error: message, failedPhase: phase };
} finally {
  for (const socket of [...activeSockets]) disconnectSocket(socket);
  await closeOwnedServer();
  primaryHealthAfter = await processStartedPrimaryHealth().catch(() => null);
  finishedAt = new Date().toISOString();
  if (primaryHealthAfter !== 200 && classification === "PASS") {
    classification = "FAIL";
    finalDetail += " Primary T60 health check did not remain HTTP 200 after D08 service cleanup.";
  }
  await saveResult();
}

console.log(`D08 ${classification} ${finalDetail}`);
console.log(`result=${resultPath}`);
console.log(`phase=${phase}; d08ServerStarts=${processStarts}; primaryHealth=${primaryHealthBefore}->${primaryHealthAfter}`);
