import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseCommandAck, parseMatchSyncResponse } from "../../../packages/contracts/src/validation.ts";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = new URL(process.env.SITES_BASE_URL ?? "http://127.0.0.1:8799");
const baseOrigin = baseUrl.origin;
const checks = [];

function check(id, operation) {
  return Promise.resolve().then(operation).then(
    (detail) => {
      checks.push({ id, status: "PASS", detail });
      console.log(`PASS ${id}: ${detail}`);
    },
    (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({ id, status: "FAIL", detail });
      console.error(`FAIL ${id}: ${detail}`);
    },
  );
}

function expect(condition, message) {
  assert.ok(condition, message);
}

async function get(pathname, init = {}) {
  return fetch(new URL(pathname, baseUrl), init);
}

async function postJson(pathname, value, cookie) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: baseOrigin,
  });
  if (cookie) headers.set("Cookie", cookie);
  return get(pathname, { method: "POST", headers, body: JSON.stringify(value) });
}

function command(type, aggregateId, expectedVersion, payload) {
  return {
    protocolVersion: 1,
    commandId: randomUUID(),
    ...(type === "CREATE_ROOM" ? {} : { roomId: aggregateId }),
    expectedVersion,
    type,
    payload,
  };
}

async function createGuest(displayName) {
  const response = await postJson("/api/guest-sessions", { protocolVersion: 1, displayName });
  expect(response.status === 201, `guest session create returned HTTP ${response.status}`);
  const raw = await response.text();
  const body = JSON.parse(raw);
  const setCookie = response.headers.get("Set-Cookie");
  expect(setCookie, "guest session response did not set a cookie");
  const cookie = setCookie.split(";", 1)[0];
  const credential = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  expect(!raw.includes(credential), "raw session credential appeared in guest JSON");
  expect(body.player?.displayName === displayName, "guest response did not retain displayName");
  return { playerId: body.player.playerId, displayName, cookie, credential };
}

async function responseJson(response, expectedStatus = 200) {
  const raw = await response.text();
  expect(response.status === expectedStatus, `expected HTTP ${expectedStatus}; received ${response.status} (${raw.slice(0, 160)})`);
  return raw === "" ? null : JSON.parse(raw);
}

async function readSseRecords(reader, count, timeoutMs = 5_000) {
  const decoder = new TextDecoder();
  const records = [];
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (records.length < count) {
    const remaining = deadline - Date.now();
    expect(remaining > 0, `SSE stream did not yield ${count} invalidations in time`);
    let timer;
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SSE read timed out")), remaining); }),
    ]).finally(() => clearTimeout(timer));
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    const frames = buffered.split(/\r?\n\r?\n/u);
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const id = frame.match(/^id: (\d+)$/mu)?.[1];
      const data = frame.match(/^data: (.+)$/mu)?.[1];
      if (id && data) records.push({ id: Number(id), data: JSON.parse(data) });
      if (records.length === count) break;
    }
  }
  return records;
}

function assertSseAllowlist(records, roomId, matchId) {
  expect(records.length > 0, "SSE stream did not return invalidation records");
  let previous = 0;
  for (const record of records) {
    expect(Number.isSafeInteger(record.id) && record.id > previous, "SSE cursor did not increase");
    previous = record.id;
    const data = record.data;
    if (data.kind === "room") {
      expect(Object.keys(data).sort().join(",") === "aggregateId,kind,version", "room SSE payload included non-allowlisted fields");
      expect(data.aggregateId === roomId, "room SSE leaked a nonmember aggregate");
    } else {
      expect(data.kind === "match", "SSE kind was not an allowed room/match invalidation");
      expect(Object.keys(data).sort().join(",") === "aggregateId,eventSeq,kind,version", "match SSE payload included non-allowlisted fields");
      expect(data.aggregateId === matchId, "match SSE leaked a nonmember aggregate");
    }
  }
}

async function createAndStart(capacity) {
  const guests = [];
  for (let index = 0; index < capacity; index += 1) {
    guests.push(await createGuest(`T106-${capacity}P-${index + 1}`));
  }
  const owner = guests[0];
  const createCommand = command("CREATE_ROOM", "", 0, {
    capacity,
    rulesetVersion: "base4-ko-online-1.0",
    displayName: `T106 ${capacity}P smoke`,
  });
  const created = await responseJson(await postJson("/api/rooms", createCommand, owner.cookie));
  expect(typeof created.roomId === "string" && typeof created.inviteCode === "string", "CREATE_ROOM did not return a room/invite");
  const roomId = created.roomId;
  const inviteCode = created.inviteCode;
  let roomVersion = created.version;

  for (const guest of guests.slice(1)) {
    const join = command("JOIN", roomId, roomVersion, { inviteCode });
    const response = await responseJson(await postJson(`/api/rooms/${encodeURIComponent(roomId)}/commands`, join, guest.cookie));
    expect(response.roomId === roomId && response.members?.length === guests.indexOf(guest) + 1,
      `JOIN did not return the expected member roster for ${capacity}P`);
    roomVersion += 1;
  }

  for (const guest of guests) {
    const ready = command("SET_READY", roomId, roomVersion, { ready: true });
    const response = await responseJson(await postJson(`/api/rooms/${encodeURIComponent(roomId)}/commands`, ready, guest.cookie));
    expect(response.roomId === roomId, "SET_READY did not return the room view");
    roomVersion += 1;
  }

  const start = command("START_MATCH", roomId, roomVersion, {});
  const startedRoom = await responseJson(await postJson(`/api/rooms/${encodeURIComponent(roomId)}/commands`, start, owner.cookie));
  expect(startedRoom.status === "in_game" && typeof startedRoom.activeMatchId === "string",
    `START_MATCH did not return an active match for ${capacity}P`);
  const matchId = startedRoom.activeMatchId;

  const views = new Map();
  for (const guest of guests) {
    const request = {
      protocolVersion: 1,
      requestId: randomUUID(),
      matchId,
      knownVersion: 0,
      afterEventSeq: 0,
    };
    const raw = await postJson(`/api/matches/${encodeURIComponent(matchId)}/sync`, request, guest.cookie);
    const body = await responseJson(raw);
    const parsed = parseMatchSyncResponse(body);
    expect(parsed.ok, `match sync did not pass canonical parser for ${capacity}P`);
    expect(parsed.value.snapshot.viewer.playerId === guest.playerId, "match sync returned a different viewer identity");
    expect(parsed.value.snapshot.selfPrivate !== null, "active member did not receive own private projection");
    views.set(guest.playerId, parsed.value);
  }

  const streamController = new AbortController();
  const streamResponse = await get(`/api/notifications/events?after=0`, {
    headers: { Cookie: guests[0].cookie },
    signal: streamController.signal,
  });
  expect(streamResponse.status === 200 && streamResponse.headers.get("content-type")?.includes("text/event-stream"),
    `member SSE stream returned HTTP ${streamResponse.status}`);
  expect(streamResponse.headers.get("cache-control") === "no-store", "SSE stream was cacheable");
  const streamReader = streamResponse.body.getReader();
  const priorEvents = await readSseRecords(streamReader, capacity * 2 + 2);
  assertSseAllowlist(priorEvents, roomId, matchId);
  await streamReader.cancel();

  const actorId = [...views.values()][0].snapshot.publicTable.turn.currentPlayerId;
  const actor = guests.find((guest) => guest.playerId === actorId);
  expect(actor, "turn actor was not in the locked room roster");
  const actorView = views.get(actorId);
  const endTurn = actorView.snapshot.legalActions?.find((action) => action.type === "END_TURN");
  expect(endTurn, `current actor did not receive legal END_TURN (status=${actorView.snapshot.status}, viewerMode=${actorView.snapshot.viewer.mode}, phase=${actorView.snapshot.publicTable.turn.phase}, pending=${actorView.snapshot.pendingInteraction?.kind ?? "none"}, actions=${(actorView.snapshot.legalActions ?? []).map((action) => action.type).join(",")})`);
  const matchCommand = {
    protocolVersion: 1,
    commandId: randomUUID(),
    matchId,
    expectedVersion: actorView.version,
    type: "END_TURN",
    payload: {},
  };
  const firstAckResponse = await postJson(`/api/matches/${encodeURIComponent(matchId)}/commands`, matchCommand, actor.cookie);
  const firstAckBody = await responseJson(firstAckResponse);
  const firstAck = parseCommandAck(firstAckBody);
  expect(firstAck.ok && firstAck.value.status === "accepted", "legal END_TURN was not accepted");
  const reconnectController = new AbortController();
  const reconnectResponse = await get(`/api/notifications/events?after=${priorEvents.at(-1).id}`, {
    headers: { Cookie: actor.cookie },
    signal: reconnectController.signal,
  });
  expect(reconnectResponse.status === 200 && reconnectResponse.headers.get("content-type")?.includes("text/event-stream"),
    "SSE reconnect did not accept the last cursor");
  const reconnectReader = reconnectResponse.body.getReader();
  const nextEvents = await readSseRecords(reconnectReader, 1);
  assertSseAllowlist(nextEvents, roomId, matchId);
  expect(nextEvents[0].id > priorEvents.at(-1).id && nextEvents[0].data.kind === "match" &&
    nextEvents[0].data.aggregateId === matchId, "reconnected SSE did not deliver the new member match invalidation");
  await reconnectReader.cancel();
  const replayAck = parseCommandAck(await responseJson(await postJson(
    `/api/matches/${encodeURIComponent(matchId)}/commands`, matchCommand, actor.cookie,
  )));
  expect(replayAck.ok && replayAck.value.status === "accepted" && replayAck.value.duplicate === true,
    "same match command replay did not return the original accepted receipt");

  const ownerRestored = await responseJson(await get("/api/guest-sessions", { headers: { Cookie: owner.cookie } }));
  expect(ownerRestored.player?.playerId === owner.playerId, "guest restore changed seat identity");
  const roomSync = await responseJson(await postJson(`/api/rooms/${encodeURIComponent(roomId)}/sync`, {
    protocolVersion: 1,
    requestId: randomUUID(),
    roomId,
    knownVersion: roomVersion,
  }, owner.cookie));
  expect(roomSync.room?.activeMatchId === matchId && roomSync.room?.members?.length === capacity,
    "room sync did not restore the started room membership");

  return { capacity, guests, owner, roomId, matchId, actor, actorView, inviteCode };
}

await check("S01.worker-default-fetch", async () => {
  const workerPath = path.join(siteRoot, "dist", "server", "index.js");
  const worker = await readFile(workerPath, "utf8");
  expect(/export\s*\{[^}]*\bas\s+default\s*\}/su.test(worker), "dist/server/index.js does not export a default Worker fetch object");
  return "dist/server/index.js exports the default fetch handler";
});

await check("S01.static-assets", async () => {
  const clientRoot = path.join(siteRoot, "dist", "client");
  const all = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else all.push(fullPath);
    }
  }
  await visit(clientRoot);
  const cards = all.filter((file) => /[\\/]assets[\\/]cards[\\/](?:playing|roles|characters)[\\/].+\.png$/u.test(file));
  expect(cards.length === 42, `expected 42 copied card/role/character images, found ${cards.length}`);
  expect(all.some((file) => file.endsWith(`${path.sep}favicon.svg`)), "dist/client/favicon.svg is missing");
  return `dist/client contains ${cards.length} Korean PNG assets and favicon.svg`;
});

await check("S01.worker-dependency-boundary", async () => {
  const roots = [path.join(siteRoot, "dist", "server"), path.join(siteRoot, "dist", "client")];
  const files = [];
  for (const root of roots) {
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else if (/\.(?:js|mjs|cjs)$/u.test(entry.name)) files.push(fullPath);
      }
    }
    await visit(root);
  }
  const forbidden = /(?:from|import\s*\(|require\s*\()\s*["'](?:pg|pg-native|postgres|postgres\.js|socket\.io|socket\.io-client|socket\.io-server)["']|socket\.io-client/iu;
  const hits = [];
  for (const file of files) {
    if (forbidden.test(await readFile(file, "utf8"))) hits.push(path.relative(siteRoot, file));
  }
  expect(hits.length === 0, `Worker/client bundles reference forbidden Node/Socket.IO dependencies: ${hits.join(", ")}`);
  return `${files.length} emitted JS bundles contain no pg or Socket.IO server/client dependency specifiers`;
});

await check("S01.local-html-and-static-http", async () => {
  const root = await get("/");
  const homeHtml = await root.text();
  expect(root.status === 200 && root.headers.get("content-type")?.includes("text/html"), "GET / did not return HTML 200");
  expect(homeHtml.includes("뱅!") || homeHtml.includes("BANG"), "home HTML lacks the Korean game title");
  const nested = await get("/rooms/t106-direct-route");
  const nestedHtml = await nested.text();
  expect(nested.status === 200 && nestedHtml.includes("<html"), "direct /rooms/t106-direct-route did not return app HTML 200");
  const png = await get("/assets/cards/playing/01_bang.png");
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  expect(png.status === 200 && png.headers.get("content-type")?.includes("image/png") && pngBytes.length > 1_000,
    "representative Korean BANG card image did not load");
  const favicon = await get("/favicon.svg");
  expect(favicon.status === 200 && favicon.headers.get("content-type")?.includes("image/svg+xml"), "favicon did not load");
  const notFound = await responseJson(await get("/api/t106-unknown-route"), 404);
  expect(notFound?.error?.code === "NOT_FOUND", "unknown API did not return a safe NOT_FOUND JSON body");
  return `GET /: ${root.status} HTML; GET /rooms/t106-direct-route: ${nested.status} HTML; GET /assets/cards/playing/01_bang.png: ${png.status} image/png (${pngBytes.length} bytes); GET /favicon.svg: ${favicon.status} image/svg+xml; GET /api/t106-unknown-route: ${notFound.error.code} HTTP 404 JSON`;
});

await check("S02.session-http", async () => {
  const missing = await get("/api/guest-sessions");
  expect(missing.status === 204 && (await missing.text()) === "", "session-less restore was not empty HTTP 204");
  expect(missing.headers.get("cache-control") === "no-store", "session-less restore was cacheable");
  const guest = await createGuest("T106 session smoke");
  const setCookie = (await postJson("/api/guest-sessions", { protocolVersion: 1, displayName: "T106 cookie flags" })).headers.get("Set-Cookie") ?? "";
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax"]) expect(setCookie.includes(flag), `Set-Cookie lacks ${flag}`);
  const restored = await responseJson(await get("/api/guest-sessions", { headers: { Cookie: guest.cookie } }));
  expect(restored.player?.playerId === guest.playerId, "valid cookie did not restore the same guest");
  const tampered = await get("/api/guest-sessions", { headers: { Cookie: "bang_session=tampered" } });
  expect(tampered.status === 204, "tampered session cookie did not take the empty-session path");
  const assignedWithoutCookie = await responseJson(await get("/api/guest-sessions/rooms"), 401);
  expect(assignedWithoutCookie?.error?.code === "SESSION_EXPIRED", "assigned-seat restore did not reject an unauthenticated caller");
  return "Worker GET/POST guest session shape, no-store, HttpOnly/Secure/SameSite=Lax, restore identity and tamper/missing-cookie behavior passed; raw credential absent from response JSON";
});

for (const capacity of [4, 7]) {
  await check(`S04-S07.worker-${capacity}p-http-flow`, async () => {
    const result = await createAndStart(capacity);
    expect(result.guests.length === capacity, `expected ${capacity} test guests`);
    return `${capacity} guests created, joined by private invite, readied, started and synced; member SSE allowed only room/match invalidations and reconnected after its last cursor; current actor completed legal END_TURN and identical command replay returned its prior accepted ACK; owner session/room sync restored`;
  });
}

const failed = checks.filter(({ status }) => status === "FAIL");
console.log(`SUMMARY ${checks.length - failed.length} PASS / ${failed.length} FAIL`);
if (failed.length > 0) process.exitCode = 1;
