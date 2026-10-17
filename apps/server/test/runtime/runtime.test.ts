import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { randomUUID } from "node:crypto";
import { BASE_PHYSICAL_CARDS } from "../../../../packages/catalog/src/cards/index.ts";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { parseCommandAck, parseMatchCommand } from "../../../../packages/contracts/src/validation.ts";
import { createRuntimeServer, startServer } from "../../src/main.ts";
import { readPGliteDevConfig, readServerConfig, ServerConfigurationError } from "../../src/config.ts";
import { withClient } from "../../src/storage/database-runtime.js";
import { StorageRepository } from "../../src/storage/repository.js";
import type { GameState } from "../../../../packages/engine/src/state/types.ts";
import { createDatabase } from "../storage/pglite-pool.ts";

function testConfig(databaseUrl = "postgresql://postgres:postgres@localhost:5432/bang_test") {
  return readServerConfig({
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    PORT: "0",
    SESSION_COOKIE_NAME: "bang_session_test",
    WEB_ORIGIN: "http://localhost:5173",
  });
}

test("room exit and owner deletion are atomic, idempotent, and revoke every live access path", async () => {
  const {database,pool}=await createDatabase();
  const runtime=await createRuntimeServer(testConfig(),pool,{logger:{info(){},error(){}}});
  const origin=`http://${runtime.host}:${runtime.port}`,webOrigin="http://localhost:5173";
  const storage=new StorageRepository(pool), sockets:Socket[]=[];
  const emit=(socket:Socket,event:string,payload:unknown):Promise<any>=>new Promise((resolve,reject)=>socket.timeout(10000).emit(event,payload,(error:unknown,reply:unknown)=>error?reject(error):resolve(reply)));
  const command=(type:string,roomId:string,version:number,payload={})=>({protocolVersion:1,commandId:randomUUID(),type,roomId,expectedVersion:version,payload});
  const players:{id:string;cookie:string;socket:Socket}[]=[];
  try {
    for(let index=0;index<6;index++){
      const response=await fetch(origin+"/api/guest-sessions",{method:"POST",headers:{Origin:webOrigin,"Content-Type":"application/json"},body:JSON.stringify({protocolVersion:1,displayName:`exit-test-${index}`})});
      const body=await response.json() as any;const cookie=response.headers.get("set-cookie")!.split(";")[0]!;
      const socket=createSocketClient(origin,{transports:["websocket"],extraHeaders:{Cookie:cookie,Origin:webOrigin},reconnection:false});sockets.push(socket);
      await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("connect_error",reject);});players.push({id:body.player.playerId,cookie,socket});
    }
    const owner=players[0]!,guest=players[1]!,outsider=players[5]!;
    const create=async()=>emit(owner.socket,"room:create",{protocolVersion:1,commandId:randomUUID(),expectedVersion:0,type:"CREATE_ROOM",payload:{capacity:5,rulesetVersion:"base4-ko-online-1.0",displayName:"exit-test-0"}});
    const lobby=await create();
    await emit(guest.socket,"room:command",command("JOIN",lobby.roomId,0,{inviteCode:lobby.inviteCode}));
    const leaveOwner=command("LEAVE_ROOM",lobby.roomId,1);
    assert.equal((await emit(owner.socket,"room:command",leaveOwner)).status,"accepted");
    const inherited=await emit(guest.socket,"room:sync",{protocolVersion:1,requestId:randomUUID(),roomId:lobby.roomId,knownVersion:0});
    assert.equal(inherited.room.viewer.isOwner,true);assert.equal(inherited.room.ownerPlayerId,guest.id);
    assert.equal((await emit(owner.socket,"room:command",leaveOwner)).duplicate,true);
    const last=await emit(guest.socket,"room:command",command("LEAVE_ROOM",lobby.roomId,2));assert.equal(last.status,"accepted");assert.equal((await storage.getRoom(lobby.roomId))?.status,"closed");

    const created=await create();let version=created.version;
    for(const player of players.slice(1,5)){const joined=await emit(player.socket,"room:command",command("JOIN",created.roomId,version,{inviteCode:created.inviteCode}));version=joined.version;}
    const started=await emit(owner.socket,"room:command",command("START_MATCH",created.roomId,version));version=started.version;
    // A Sheriff with Kit Carlson or Jesse Jones can start with a private draw prompt.
    for(let step=0;step<12;step++){
      const stored=(await storage.getMatch(started.activeMatchId))!;
      const prompt=stored.state.resolution.pendingInteraction;if(!prompt)break;
      const responder=players.find(player=>player.id===prompt.actorPlayerIds[0])!,option=prompt.options[0]!;
      const ack=await emit(responder.socket,"match:command",{protocolVersion:1,commandId:randomUUID(),type:"RESPOND",matchId:started.activeMatchId,expectedVersion:stored.version,payload:{...option.payload,interactionId:prompt.interactionId,choice:option.choice}});
      assert.equal(ack.status,"accepted");
    }
    let before=(await storage.getMatch(started.activeMatchId))!;assert.equal(before.state.resolution.pendingInteraction,null);
    const leavingId=before.state.seats.find(seat=>seat.public.playerId!==owner.id&&seat.private.roleId==="outlaw")!.public.playerId;
    const leaving=players.find(player=>player.id===leavingId)!;
    const retained=players.find(player=>player.id!==owner.id&&player.id!==leavingId)!;
    for(const player of players.slice(0,5)){
      await emit(player.socket,"room:sync",{protocolVersion:1,requestId:randomUUID(),roomId:created.roomId,knownVersion:0});
      const synced=await emit(player.socket,"match:sync",{protocolVersion:1,requestId:randomUUID(),matchId:started.activeMatchId,knownVersion:0,afterEventSeq:0});assert.ok(synced.snapshot);
    }
    const denied=await emit(outsider.socket,"room:command",command("CLOSE_ROOM",created.roomId,version));assert.equal(denied.status,"rejected");
    assert.equal((await storage.getRoom(created.roomId))?.players.length,5);
    // Seed a real General Store fixture so departure spans another player's saved choice.
    const fixture=structuredClone(before.state),actor=fixture.seats.find(seat=>seat.public.playerId===fixture.turn.currentPlayerId)!;
    const storeDefinition=BASE_PHYSICAL_CARDS.find(card=>card.typeId==="general_store")!.definitionId;
    const storeCard=Object.values(fixture.zones.cardsByInstanceId).find(card=>card.cardDefinitionId===storeDefinition)!.cardInstanceId;
    fixture.zones.drawPileCardInstanceIds=fixture.zones.drawPileCardInstanceIds.filter(id=>id!==storeCard);fixture.zones.discardPileCardInstanceIds=fixture.zones.discardPileCardInstanceIds.filter(id=>id!==storeCard);
    fixture.seats.forEach(seat=>{seat.private.handCardInstanceIds=seat.private.handCardInstanceIds.filter(id=>id!==storeCard);});actor.private.handCardInstanceIds.push(storeCard);
    await withClient(pool,client=>client.query("UPDATE matches SET state_json=$2::jsonb WHERE id=$1",[started.activeMatchId,JSON.stringify(fixture)]));
    const storeActor=players.find(player=>player.id===actor.public.playerId)!;
    const played=await emit(storeActor.socket,"match:command",{protocolVersion:1,commandId:randomUUID(),expectedVersion:before.version,matchId:started.activeMatchId,type:"PLAY_CARD",payload:{cardInstanceId:storeCard}});assert.equal(played.status,"accepted");
    before=(await storage.getMatch(started.activeMatchId))!;
    const exit=command("LEAVE_ROOM",created.roomId,version);
    const left=await emit(leaving.socket,"room:command",exit);assert.equal(left.status,"accepted");assert.equal((await emit(leaving.socket,"room:command",exit)).duplicate,true);
    version=left.aggregateVersion;
    let after=(await storage.getMatch(started.activeMatchId))!;assert.equal(after.state.status,"playing");assert.equal(after.version,before.version+1);
    assert.equal(after.state.resolution.pendingInteraction?.interactionId,before.state.resolution.pendingInteraction?.interactionId,"another player's store choice must survive departure");
    for(let step=0;step<10&&after.state.resolution.pendingInteraction;step++){
      const prompt=after.state.resolution.pendingInteraction,option=prompt.options[0]!,responder=players.find(player=>player.id===prompt.actorPlayerIds[0])!;
      assert.notEqual(responder.id,leavingId,"server must resolve departed players without asking them");
      const ack=await emit(responder.socket,"match:command",{protocolVersion:1,commandId:randomUUID(),expectedVersion:after.version,matchId:started.activeMatchId,type:"RESPOND",payload:{...option.payload,interactionId:prompt.interactionId,choice:option.choice}});assert.equal(ack.status,"accepted");
      after=(await storage.getMatch(started.activeMatchId))!;
    }
    assert.equal(after.state.seats.find(seat=>seat.public.playerId===leavingId)?.public.eliminated,true);
    assert.equal(after.players.find(player=>player.playerId===leavingId)?.alive,false);
    const inaccessible=await emit(leaving.socket,"match:sync",{protocolVersion:1,requestId:randomUUID(),matchId:started.activeMatchId,knownVersion:0,afterEventSeq:0});assert.equal(inaccessible.status,"rejected");
    const recovered=await fetch(origin+"/api/guest-sessions/rooms",{headers:{Cookie:leaving.cookie}});assert.deepEqual(await recovered.json(),[]);
    const forbiddenPlay=await emit(leaving.socket,"match:command",{...command("END_TURN",created.roomId,after.version),roomId:undefined,matchId:started.activeMatchId});assert.equal(forbiddenPlay.status,"rejected");
    const notified=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("playing room never received close invalidation")),10000);retained.socket.on("room:changed",payload=>{if(payload.roomId===created.roomId&&payload.version>version){clearTimeout(timer);resolve();}});});
    const close=command("CLOSE_ROOM",created.roomId,version);
    const closed=await emit(owner.socket,"room:command",close);assert.equal(closed.status,"accepted");await notified;
    assert.equal((await emit(owner.socket,"room:command",close)).duplicate,true);
    const storedRoom=(await storage.getRoom(created.roomId))!;assert.equal(storedRoom.status,"closed");assert.equal(storedRoom.players.length,0);
    for(const player of players.slice(0,5)){
      const sync=await emit(player.socket,"match:sync",{protocolVersion:1,requestId:randomUUID(),matchId:started.activeMatchId,knownVersion:0,afterEventSeq:0});assert.equal(sync.status,"rejected");
      const rooms=await fetch(origin+"/api/guest-sessions/rooms",{headers:{Cookie:player.cookie}});assert.deepEqual(await rooms.json(),[]);
      assert.equal((await fetch(origin+"/api/guest-sessions",{headers:{Cookie:player.cookie}})).status,200);
    }
    const preview=await emit(outsider.socket,"room:preview",{protocolVersion:1,requestId:randomUUID(),inviteCode:created.inviteCode});
    assert.ok(preview.status==="rejected" || preview.room?.status==="closed" || preview.status==="closed");
    const rejoin=await emit(outsider.socket,"room:command",command("JOIN",created.roomId,closed.aggregateVersion,{inviteCode:created.inviteCode}));assert.equal(rejoin.status,"rejected");
  } finally { for(const socket of sockets)socket.disconnect();await runtime.close();await database.close(); }
});

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
  });
}

function acknowledged(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement.`)), 2_000);
    socket.emit(event, payload, (response: unknown) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function serverEvent(socket: Socket, event: string, predicate: (payload: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 2_000);
    const listener = (payload: unknown) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function availableTcpPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP test port was not assigned.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

test("startup config reports missing PostgreSQL settings before opening the listener", () => {
  assert.throws(
    () => readServerConfig({}),
    (error: unknown) => error instanceof ServerConfigurationError &&
      error.variable === "DATABASE_URL" && error.message.includes("DATABASE_URL: is required"),
  );
  assert.throws(
    () => readServerConfig({ DATABASE_URL: "https://example.test/db" }),
    (error: unknown) => error instanceof ServerConfigurationError && error.variable === "DATABASE_URL",
  );
  assert.equal(testConfig().port, 0, "port 0 is supported for ephemeral local runtime tests");
  assert.equal(readPGliteDevConfig({}).port, 5433);
  assert.throws(
    () => readPGliteDevConfig({ PGLITE_DATA_DIR: "  " }),
    (error: unknown) => error instanceof ServerConfigurationError && error.variable === "PGLITE_DATA_DIR",
  );
  assert.throws(
    () => readPGliteDevConfig({ PGLITE_PORT: "0" }),
    (error: unknown) => error instanceof ServerConfigurationError && error.variable === "PGLITE_PORT",
  );
});

test("runtime applies migrations, serves guest sessions, authenticates Socket.IO cookies, and shuts down", async () => {
  const { database, pool } = await createDatabase();
  const messages: string[] = [];
  const sockets: Socket[] = [];
  let runtime: Awaited<ReturnType<typeof createRuntimeServer>> | undefined;
  let closePoolCalled = false;

  try {
    runtime = await createRuntimeServer(testConfig(), pool, {
      logger: {
        info: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
      closePool: async () => { closePoolCalled = true; },
    });
    assert.ok(runtime.port > 0);

    const schema = await withClient(pool, async (client) =>
      client.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version"),
    );
    assert.deepEqual(schema.rows.map(({ version }) => version), [1]);

    const baseUrl = `http://${runtime.host}:${runtime.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const created = await fetch(`${baseUrl}/api/guest-sessions`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, displayName: "런타임 확인" }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as {
      protocolVersion: number;
      player: { playerId: string; displayName: string };
      sessionExpiresAt: string;
    };
    assert.equal(session.protocolVersion, 1);
    assert.equal(session.player.displayName, "런타임 확인");
    assert.ok(session.player.playerId.startsWith("p_"));

    const setCookie = created.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Expires=Fri, 31 Dec 9999 23:59:59 GMT(?:;|$)/i,
      "a non-expiring guest needs a persistent cookie to survive browser shutdown");
    const cookiePair = setCookie.split(";", 1)[0]!;
    const rawCredential = cookiePair.slice(cookiePair.indexOf("=") + 1);
    const bodyText = JSON.stringify(session);
    assert.equal(bodyText.includes(rawCredential), false, "session credential must not be returned in JSON");
    assert.equal(messages.some((message) => message.includes(rawCredential)), false, "session credential must not be logged");

    const noSession = await fetch(`${baseUrl}/api/guest-sessions`);
    assert.equal(noSession.status, 204);
    assert.equal(await noSession.text(), "");
    assert.equal(noSession.headers.get("cache-control"), "no-store");
    const invalidSession = await fetch(`${baseUrl}/api/guest-sessions`, {
      headers: { Cookie: "bang_session_test=invalid" },
    });
    assert.equal(invalidSession.status, 204);
    const duplicateSessionCookie = await fetch(`${baseUrl}/api/guest-sessions`, {
      headers: { Cookie: "bang_session_test=invalid; bang_session_test=invalid" },
    });
    assert.equal(duplicateSessionCookie.status, 204, "ambiguous duplicate credentials do not restore a guest");

    const restoredResponse = await fetch(`${baseUrl}/api/guest-sessions`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(restoredResponse.status, 200);
    assert.equal(restoredResponse.headers.get("cache-control"), "no-store");
    assert.equal(restoredResponse.headers.get("set-cookie"), setCookie,
      "restoring an old session cookie upgrades persistence without rotating the credential");
    const restoredSession = await restoredResponse.json();
    assert.deepEqual(restoredSession, session);
    assert.equal(JSON.stringify(restoredSession).includes(decodeURIComponent(rawCredential)), false);

    const noSessionRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`);
    assert.equal(noSessionRooms.status, 401);
    assert.deepEqual(await noSessionRooms.json(), { error: { code: "SESSION_EXPIRED" } });
    const invalidSessionRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: "bang_session_test=invalid" },
    });
    assert.equal(invalidSessionRooms.status, 401);
    assert.deepEqual(await invalidSessionRooms.json(), { error: { code: "SESSION_EXPIRED" } });
    const emptyAssignedRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(emptyAssignedRooms.status, 200);
    assert.equal(emptyAssignedRooms.headers.get("cache-control"), "no-store");
    assert.deepEqual(await emptyAssignedRooms.json(), []);

    const authenticated = createSocketClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Origin: "http://localhost:5173", Cookie: cookiePair },
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(authenticated);
    await connected(authenticated);

    const previewReply = await acknowledged(authenticated, "room:preview", {
      protocolVersion: 1,
      requestId: "runtime-preview",
      inviteCode: "not-a-real-invite",
    });
    assert.deepEqual(previewReply, {
      protocolVersion: 1,
      requestId: "runtime-preview",
      status: "rejected",
      error: { code: "INVITE_INVALID" },
    });

    const createdRoom = await acknowledged(authenticated, "room:create", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-123456789abc",
      expectedVersion: 0,
      type: "CREATE_ROOM",
      payload: {
        capacity: 4,
        rulesetVersion: "base4-ko-online-1.0",
        displayName: "런타임 확인",
      },
    }) as { roomId: string; version: number; inviteCode: string | null; duplicate: boolean };
    assert.equal(createdRoom.version, 0, JSON.stringify(createdRoom));
    assert.equal(createdRoom.duplicate, false);
    assert.equal(typeof createdRoom.roomId, "string");
    assert.equal(typeof createdRoom.inviteCode, "string");

    const ownerAssignedRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(ownerAssignedRooms.status, 200);
    assert.equal(ownerAssignedRooms.headers.get("cache-control"), "no-store");
    const ownerRoomViews = await ownerAssignedRooms.json() as Array<{
      roomId: string;
      viewer: { playerId: string; isOwner: boolean };
      members: readonly { playerId: string }[];
    }>;
    assert.equal(ownerRoomViews.length, 1);
    assert.equal(ownerRoomViews[0]?.roomId, createdRoom.roomId);
    assert.deepEqual(ownerRoomViews[0]?.viewer, { playerId: session.player.playerId, isOwner: true });
    assert.deepEqual(ownerRoomViews[0]?.members.map(({ playerId }) => playerId), [session.player.playerId]);
    assert.equal(JSON.stringify(ownerRoomViews).includes(createdRoom.inviteCode!), false, "recovery never returns the invite secret");
    assert.equal(JSON.stringify(ownerRoomViews).includes(decodeURIComponent(rawCredential)), false, "recovery never returns the session secret");

    const secondGuestResponse = await fetch(`${baseUrl}/api/guest-sessions`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, displayName: "다른 게스트" }),
    });
    assert.equal(secondGuestResponse.status, 201);
    const secondGuestCookie = secondGuestResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(secondGuestCookie);
    const secondGuestRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: secondGuestCookie },
    });
    assert.equal(secondGuestRooms.status, 200);
    assert.deepEqual(await secondGuestRooms.json(), [], "a different authenticated player cannot recover the owner's room");

    const roomSync = await acknowledged(authenticated, "room:sync", {
      protocolVersion: 1,
      requestId: "runtime-room-sync",
      roomId: createdRoom.roomId,
      knownVersion: 0,
    }) as { room?: { viewer: { playerId: string } } };
    assert.equal(roomSync.room?.viewer.playerId, session.player.playerId);

    authenticated.disconnect();
    const reopened = createSocketClient(baseUrl, {
      transports: ["websocket"], extraHeaders: { Origin: "http://localhost:5173", Cookie: cookiePair }, reconnection: false, timeout: 2_000,
    });
    sockets.push(reopened);
    await connected(reopened);
    const reopenedRoom = await acknowledged(reopened, "room:sync", {
      protocolVersion: 1, requestId: "runtime-reopened-owner", roomId: createdRoom.roomId, knownVersion: 0,
    }) as { room?: { viewer: { playerId: string; isOwner: boolean } } };
    assert.deepEqual(reopenedRoom.room?.viewer, { playerId: session.player.playerId, isOwner: true },
      "a fresh connection using the persisted cookie retains the original owner seat");
    authenticated.connect();
    await connected(authenticated);

    const unexpectedChanges: unknown[] = [];
    const observeReadyChange = (payload: unknown) => {
      if (typeof payload === "object" && payload !== null && "version" in payload && typeof payload.version === "number" && payload.version > 0) {
        unexpectedChanges.push(payload);
      }
    };
    authenticated.on("room:changed", observeReadyChange);
    const readyRoom = await acknowledged(authenticated, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-123456789abd",
      expectedVersion: 0,
      roomId: createdRoom.roomId,
      type: "SET_READY",
      payload: { ready: true },
    }) as { version: number; members?: readonly { playerId: string; ready: boolean }[] };
    assert.equal(readyRoom.members?.[0]?.ready, true);
    const readyVersion = await withClient(pool, client => client.query<{ version: string }>(
      "SELECT version::text AS version FROM rooms WHERE id = $1", [createdRoom.roomId]));
    assert.equal(readyVersion.rows[0]?.version, "0", "automatic arrival makes SET_READY(true) a no-op");
    await new Promise(resolve => setTimeout(resolve, 100));
    authenticated.off("room:changed", observeReadyChange);
    assert.deepEqual(unexpectedChanges, [], "no-op readiness must not publish a room mutation");

    const pendingOutbox = await withClient(pool, async (client) =>
      client.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL"),
    );
    assert.equal(pendingOutbox.rows[0]?.count, "0");

    const inviteEndpoint = `${baseUrl}/api/rooms/${createdRoom.roomId}/invite`;
    const rotateHeaders = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', Cookie: cookiePair };
    const rotateBody = JSON.stringify({protocolVersion:1, expectedVersion:0});
    assert.equal((await fetch(inviteEndpoint,{method:'POST',headers:{...rotateHeaders,Cookie:secondGuestCookie},body:rotateBody})).status,403);
    assert.equal((await fetch(inviteEndpoint,{method:'POST',headers:{...rotateHeaders,Origin:'https://other.test'},body:rotateBody})).status,403);
    const rotatedResponse = await fetch(inviteEndpoint,{method:'POST',headers:rotateHeaders,body:rotateBody});
    assert.equal(rotatedResponse.status,200);
    const rotated = await rotatedResponse.json() as {roomId:string; version:number; inviteCode:string};
    assert.equal(rotated.roomId,createdRoom.roomId);
    assert.equal(rotated.version,1);
    assert.notEqual(rotated.inviteCode,createdRoom.inviteCode);
    const staleRotation = await fetch(inviteEndpoint,{method:'POST',headers:rotateHeaders,body:rotateBody});
    assert.equal(staleRotation.status,409,'a stale retry must not rotate the successful invite again');
    const oldInvite = await acknowledged(authenticated,'room:preview',{protocolVersion:1,requestId:'old-rotated-invite',inviteCode:createdRoom.inviteCode}) as {status?:string};
    assert.equal(oldInvite.status,'rejected');
    const newInvite = await acknowledged(authenticated,'room:preview',{protocolVersion:1,requestId:'new-rotated-invite',inviteCode:rotated.inviteCode}) as {roomId?:string};
    assert.equal(newInvite.roomId,createdRoom.roomId);
    const roomsAfterRotation = await fetch(`${baseUrl}/api/guest-sessions/rooms`,{headers:{Cookie:cookiePair}});
    const [ownerAfterRotation] = await roomsAfterRotation.json() as Array<{viewer:{isOwner:boolean};members:unknown[]}>;
    assert.equal(ownerAfterRotation?.viewer.isOwner,true);
    assert.equal(ownerAfterRotation?.members.length,1,'invite rotation preserves the roster');

    const memberSocket = createSocketClient(baseUrl, {
      transports: ["websocket"], extraHeaders: { Origin: "http://localhost:5173", Cookie: secondGuestCookie }, reconnection: false, timeout: 2_000,
    });
    sockets.push(memberSocket);
    await connected(memberSocket);
    const joinPayload = { protocolVersion: 1, commandId: "018f8e3d-7b11-7c82-8a7b-123456789a01", roomId: createdRoom.roomId,
      expectedVersion: 1, type: "JOIN", payload: { inviteCode: rotated.inviteCode } };
    const joined = await acknowledged(memberSocket, "room:command", joinPayload) as { version: number; viewer: { playerId: string }; members: unknown[] };
    assert.equal(joined.version, 2, JSON.stringify(joined));
    assert.equal(joined.members.length, 2);
    await acknowledged(authenticated, "room:sync", { protocolVersion: 1, requestId: "owner-before-kick", roomId: createdRoom.roomId, knownVersion: 2 });
    await acknowledged(memberSocket, "room:sync", { protocolVersion: 1, requestId: "member-before-kick", roomId: createdRoom.roomId, knownVersion: 2 });
    const removedHint = serverEvent(memberSocket, "room:changed", payload => (payload as { version?: number }).version === 3);
    const ownerHint = serverEvent(authenticated, "room:changed", payload => (payload as { version?: number }).version === 3);
    const kickPayload = { protocolVersion: 1, commandId: "018f8e3d-7b11-7c82-8a7b-123456789a02", roomId: createdRoom.roomId,
      expectedVersion: 2, type: "KICK_MEMBER", payload: { targetPlayerId: joined.viewer.playerId } };
    const kicked = await acknowledged(authenticated, "room:command", kickPayload) as { version: number; members: unknown[] };
    assert.equal(kicked.version, 3, JSON.stringify(kicked));
    assert.equal(kicked.members.length, 1);
    await Promise.all([removedHint, ownerHint]);
    const forbidden = await acknowledged(memberSocket, "room:sync", { protocolVersion: 1, requestId: "member-after-kick", roomId: createdRoom.roomId, knownVersion: 2 }) as { error: { code: string } };
    assert.equal(forbidden.error.code, "NOT_FOUND_OR_FORBIDDEN");
    const removedCommand = await acknowledged(memberSocket, "room:command", { ...kickPayload, commandId: "018f8e3d-7b11-7c82-8a7b-123456789a03", expectedVersion: 3 }) as { error: { code: string } };
    assert.equal(removedCommand.error.code, "NOT_FOUND_OR_FORBIDDEN");
    const replay = await acknowledged(authenticated, "room:command", kickPayload) as { version: number; members: unknown[] };
    assert.equal(replay.version, 3);
    assert.equal(replay.members.length, 1);
    const leakedPresence: unknown[] = [];
    memberSocket.on("room:presence", payload => leakedPresence.push(payload));
    reopened.disconnect();
    authenticated.disconnect();
    let ownerDisconnected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(`${baseUrl}/api/guest-sessions/rooms`, { headers: { Cookie: cookiePair } });
      const rooms = await response.json() as Array<{ members: { playerId: string; connectionState: string }[] }>;
      ownerDisconnected = rooms[0]?.members.some(member => member.playerId === session.player.playerId && member.connectionState === "disconnected") === true;
      if (ownerDisconnected) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ownerDisconnected, true);
    const ownerOnline = serverEvent(authenticated, "room:presence", payload =>
      (payload as { members?: { playerId: string; connectionState: string }[] }).members?.some(member => member.playerId === session.player.playerId && member.connectionState === "connected") === true);
    const ownerReconnected = connected(authenticated); authenticated.connect(); await ownerReconnected; await ownerOnline;
    assert.deepEqual(leakedPresence, [], "removed members in stale lobby channels cannot receive presence");
    const rejoined = await acknowledged(memberSocket, "room:command", { ...joinPayload, commandId: "018f8e3d-7b11-7c82-8a7b-123456789a04", expectedVersion: 3 }) as { version: number; members: unknown[] };
    assert.equal(rejoined.version, 4);
    assert.equal(rejoined.members.length, 2);

    const presenceState = (reply: unknown, playerId: string) =>
      (reply as { members?: { playerId: string; connectionState: string }[] }).members?.find(member => member.playerId === playerId)?.connectionState;
    const currentRoom = await acknowledged(authenticated, "room:sync", { protocolVersion: 1, requestId: "presence-initial", roomId: createdRoom.roomId, knownVersion: 4 }) as { version: number; room: unknown };
    assert.equal(presenceState(currentRoom.room, joined.viewer.playerId), "connected");
    const offline = serverEvent(authenticated, "room:presence", payload => presenceState(payload, joined.viewer.playerId) === "disconnected");
    memberSocket.disconnect();
    await offline;
    const disconnectedRoom = await acknowledged(authenticated, "room:sync", { protocolVersion: 1, requestId: "presence-offline", roomId: createdRoom.roomId, knownVersion: 4 }) as { version: number; room: unknown };
    assert.equal(disconnectedRoom.version, 4, "presence must not mutate the room version");
    assert.equal(presenceState(disconnectedRoom.room, joined.viewer.playerId), "disconnected");
    const online = serverEvent(authenticated, "room:presence", payload => presenceState(payload, joined.viewer.playerId) === "connected");
    const reconnected = connected(memberSocket); memberSocket.connect(); await reconnected; await online;
    const secondTab = createSocketClient(baseUrl, { transports: ["websocket"], extraHeaders: { Origin: "http://localhost:5173", Cookie: secondGuestCookie }, reconnection: false });
    sockets.push(secondTab); await connected(secondTab);
    memberSocket.disconnect();
    const multiTabRoom = await acknowledged(authenticated, "room:sync", { protocolVersion: 1, requestId: "presence-multi-tab", roomId: createdRoom.roomId, knownVersion: 4 }) as { version: number; room: unknown };
    assert.equal(presenceState(multiTabRoom.room, joined.viewer.playerId), "connected", "one remaining tab keeps a guest connected");
    const finalOffline = serverEvent(authenticated, "room:presence", payload => presenceState(payload, joined.viewer.playerId) === "disconnected");
    secondTab.disconnect(); await finalOffline;
    const finalRoom = await acknowledged(authenticated, "room:sync", { protocolVersion: 1, requestId: "presence-final", roomId: createdRoom.roomId, knownVersion: 4 }) as { version: number; room: { members: unknown[] } };
    assert.equal(finalRoom.version, 4);
    assert.equal(finalRoom.room.members.length, 2, "disconnecting does not remove a seat");

    const anonymous = createSocketClient(baseUrl, {
      extraHeaders: { Origin: "http://localhost:5173" },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(anonymous);
    await assert.rejects(connected(anonymous), /UNAUTHENTICATED/);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await runtime?.close();
    await database.close();
  }
  assert.ok(messages.some((message) => message.includes("Database schema ready")));
  assert.equal(closePoolCalled, true, "shutdown closes the pool owned by the runtime");
});

test("START_MATCH enforces owner and minimum roster, automatically prepares arrivals, and persists once", async () => {
  const { database, pool } = await createDatabase();
  const sockets: Socket[] = [];
  let runtime: Awaited<ReturnType<typeof createRuntimeServer>> | undefined;

  try {
    runtime = await createRuntimeServer(testConfig(), pool, {
      logger: { info: () => undefined, error: () => undefined },
      closePool: async () => undefined,
    });
    const baseUrl = `http://${runtime.host}:${runtime.port}`;

    const guests: Array<{
      playerId: string;
      cookiePair: string;
      socket: Socket;
    }> = [];
    for (const displayName of ["Start Owner", "Start Member 1", "Start Member 2", "Start Member 3", "Not Seated"]) {
      const response = await fetch(`${baseUrl}/api/guest-sessions`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, displayName }),
      });
      assert.equal(response.status, 201);
      const session = await response.json() as { player: { playerId: string } };
      const cookiePair = response.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookiePair);
      const socket = createSocketClient(baseUrl, {
        transports: ["websocket"],
        extraHeaders: { Origin: "http://localhost:5173", Cookie: cookiePair },
        reconnection: false,
        timeout: 2_000,
      });
      sockets.push(socket);
      await connected(socket);
      guests.push({ playerId: session.player.playerId, cookiePair, socket });
    }

    const owner = guests[0]!;
    const created = await acknowledged(owner.socket, "room:create", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-223456789abc",
      expectedVersion: 0,
      type: "CREATE_ROOM",
      payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "Start Owner" },
    }) as { roomId: string; version: number; inviteCode: string };
    assert.equal(created.version, 0);
    assert.ok(created.inviteCode);

    const lobbySync = await acknowledged(owner.socket, "room:sync", {
      protocolVersion: 1,
      requestId: "start-lobby-before-join",
      roomId: created.roomId,
      knownVersion: 0,
    }) as { room?: { activeMatchId: string | null } };
    assert.equal(lobbySync.room?.activeMatchId, null);

    const incomplete = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1, commandId: "018f8e3d-7b11-7c82-8a7b-323456789abc",
      expectedVersion: 0, roomId: created.roomId, type: "START_MATCH", payload: {},
    }) as { status: string; error?: { code: string } };
    assert.equal(incomplete.status, "rejected");
    assert.equal(incomplete.error?.code, "ROOM_NOT_READY");

    let roomVersion = created.version;
    for (let index = 1; index < 4; index += 1) {
      const joined = await acknowledged(guests[index]!.socket, "room:command", {
        protocolVersion: 1,
        commandId: `018f8e3d-7b11-7c82-8a7b-223456789ab${index}`,
        expectedVersion: roomVersion,
        roomId: created.roomId,
        type: "JOIN",
        payload: { inviteCode: created.inviteCode },
      }) as { members?: readonly { playerId: string }[] };
      assert.equal(joined.members?.length, index + 1);
      roomVersion += 1;
    }

    const rejectedStart = async (socket: Socket, commandId: string, expectedVersion: number) =>
      await acknowledged(socket, "room:command", {
        protocolVersion: 1,
        commandId,
        expectedVersion,
        roomId: created.roomId,
        type: "START_MATCH",
        payload: {},
      }) as { status?: string; error?: { code: string; currentVersion?: number } };

    const notOwner = await rejectedStart(guests[1]!.socket, "018f8e3d-7b11-7c82-8a7b-423456789abc", roomVersion);
    assert.equal(notOwner.status, "rejected");
    assert.equal(notOwner.error?.code, "ROOM_FORBIDDEN");
    const notMember = await rejectedStart(guests[4]!.socket, "018f8e3d-7b11-7c82-8a7b-523456789abc", roomVersion);
    assert.equal(notMember.status, "rejected");
    assert.equal(notMember.error?.code, "NOT_FOUND_OR_FORBIDDEN");
    const stale = await rejectedStart(owner.socket, "018f8e3d-7b11-7c82-8a7b-623456789abc", roomVersion - 1);
    assert.equal(stale.status, "rejected");
    assert.equal(stale.error?.code, "STALE_VERSION");
    assert.equal(stale.error?.currentVersion, roomVersion);

    const rejectedReceipts = await withClient(pool, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM command_receipts WHERE command_id = ANY($1::text[])",
        [[
          "018f8e3d-7b11-7c82-8a7b-323456789abc",
          "018f8e3d-7b11-7c82-8a7b-423456789abc",
          "018f8e3d-7b11-7c82-8a7b-523456789abc",
          "018f8e3d-7b11-7c82-8a7b-623456789abc",
        ]],
      ),
    );
    assert.equal(rejectedReceipts.rows[0]?.count, "0");

    const startCommandId = "018f8e3d-7b11-7c82-8a7b-823456789abc";
    const startPayload = {
      protocolVersion: 1,
      commandId: startCommandId,
      expectedVersion: roomVersion,
      roomId: created.roomId,
      type: "START_MATCH",
      payload: {},
    };
    const started = await acknowledged(owner.socket, "room:command", startPayload) as {
      roomId: string;
      status: string;
      activeMatchId: string | null;
      members: readonly { playerId: string; ready: boolean }[];
    };
    assert.equal(started.roomId, created.roomId);
    assert.equal(started.status, "in_game");
    assert.ok(started.activeMatchId);
    const matchId = started.activeMatchId;
    assert.ok(started.members.every(({ ready }) => ready));
    const startedRoomVersion = roomVersion + 1;

    const inGameKick = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1, commandId: "018f8e3d-7b11-7c82-8a7b-223456789a05", roomId: created.roomId,
      expectedVersion: startedRoomVersion, type: "KICK_MEMBER", payload: { targetPlayerId: guests[1]!.playerId },
    }) as { error: { code: string } };
    assert.equal(inGameKick.error.code, "ROOM_LOCKED");

    const duplicate = await acknowledged(owner.socket, "room:command", startPayload) as {
      status: string;
      activeMatchId: string | null;
    };
    assert.equal(duplicate.status, "in_game");
    assert.equal(duplicate.activeMatchId, matchId);

    const locked = await rejectedStart(owner.socket, "018f8e3d-7b11-7c82-8a7b-923456789abc", roomVersion + 1);
    assert.equal(locked.status, "rejected");
    assert.equal(locked.error?.code, "ROOM_LOCKED");
    const lockedReceiptCount = await withClient(pool, async (client) => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [owner.playerId, "018f8e3d-7b11-7c82-8a7b-923456789abc"],
    ));
    assert.equal(lockedReceiptCount.rows[0]?.count, "0");

    const synchronized = await acknowledged(guests[2]!.socket, "room:sync", {
      protocolVersion: 1,
      requestId: "start-room-sync-after-start",
      roomId: created.roomId,
      knownVersion: roomVersion,
    }) as { version: number; room: { activeMatchId: string | null } };
    assert.equal(synchronized.version, roomVersion + 1);
    assert.equal(synchronized.room.activeMatchId, matchId);

    const restoredRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: owner.cookiePair },
    });
    assert.equal(restoredRooms.status, 200);
    const restored = await restoredRooms.json() as Array<{ roomId: string; activeMatchId: string | null }>;
    assert.equal(restored.find(({ roomId }) => roomId === created.roomId)?.activeMatchId, matchId);

    // Kit/Jesse/Pedro can legitimately pause the initial draw. Complete their
    // canonical private prompt before expecting the play phase.
    for (let attempt = 0; attempt < 4; attempt++) {
      const initial = await withClient(pool, client => client.query<{ state_json: GameState }>(
        "SELECT state_json FROM matches WHERE id = $1", [matchId]));
      const state = initial.rows[0]!.state_json;
      if (state.turn.phase === "play") break;
      const responder = guests.find(guest => guest.playerId === state.resolution.pendingInteraction?.actorPlayerIds[0]);
      assert.ok(responder);
      const sync = await acknowledged(responder.socket, "match:sync", {
        protocolVersion: 1, requestId: `initial-draw-${attempt}`, matchId, knownVersion: 0, afterEventSeq: 0,
      }) as { snapshot: { pendingInteraction: { responseOptions: readonly Record<string, unknown>[] } } };
      const option = sync.snapshot.pendingInteraction.responseOptions[0];
      assert.ok(option);
      const ack = await acknowledged(responder.socket, "match:command", {
        protocolVersion: 1, commandId: globalThis.crypto.randomUUID(), matchId, expectedVersion: state.version,
        type: "RESPOND", payload: option,
      }) as { status: string };
      assert.equal(ack.status, "accepted");
    }

    const stored = await withClient(pool, async (client) => client.query<{ id: string; state_json: { turn: { phase: string } } }>(
      "SELECT id, state_json FROM matches WHERE room_id = $1",
      [created.roomId],
    ));
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]?.id, matchId);
    assert.equal(stored.rows[0]?.state_json.turn.phase, "play");
    const startReceiptCount = await withClient(pool, async (client) => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [owner.playerId, startCommandId],
    ));
    assert.equal(startReceiptCount.rows[0]?.count, "1");

    const matchStorage = new StorageRepository(pool);
    const beforeTurn = await matchStorage.getMatch(matchId);
    assert.ok(beforeTurn);
    assert.equal(beforeTurn.state.turn.phase, "play");
    const orderedSeats = [...beforeTurn.state.seats].sort((left, right) => left.public.seatIndex - right.public.seatIndex);
    const actingSeatIndex = orderedSeats.findIndex((seat) => seat.public.playerId === beforeTurn.state.turn.currentPlayerId);
    const nextActor = orderedSeats[(actingSeatIndex + 1) % orderedSeats.length]!;
    const actorSocket = guests.find(({ playerId }) => playerId === beforeTurn.state.turn.currentPlayerId)?.socket;
    assert.ok(actorSocket, "the current turn actor has an authenticated socket");
    const nextActorHandCount = nextActor.private.handCardInstanceIds.length;
    const endTurnId = "018f8e3d-7b11-7c82-8a7b-a00000000001";
    const endTurnAck = await acknowledged(actorSocket, "match:command", {
      protocolVersion: 1,
      commandId: endTurnId,
      matchId,
      expectedVersion: beforeTurn.version,
      type: "END_TURN",
      payload: {},
    }) as { status?: string; aggregateVersion?: number; error?: { code: string } };
    assert.equal(endTurnAck.status, "accepted", JSON.stringify(endTurnAck));
    assert.equal(endTurnAck.aggregateVersion, beforeTurn.version + 1);
    const canonicalAck = parseCommandAck(endTurnAck);
    assert.ok(canonicalAck.ok && canonicalAck.value.status === "accepted");
    assert.equal(canonicalAck.value.matchProjection?.baseEventSeq, beforeTurn.eventSeq);
    assert.equal(canonicalAck.value.matchProjection?.snapshot.viewer.playerId, beforeTurn.state.turn.currentPlayerId);

    let afterTurn = await matchStorage.getMatch(matchId);
    assert.ok(afterTurn);
    let responseSequence = 0;
    while (afterTurn.state.resolution.pendingInteraction !== null) {
      const pending = afterTurn.state.resolution.pendingInteraction;
      const option = pending.options[0];
      assert.ok(option, `pending ${pending.kind} has a continuation choice`);
      const responderId = pending.actorPlayerIds[0];
      assert.ok(responderId);
      const responderSocket = guests.find(({ playerId }) => playerId === responderId)?.socket;
      assert.ok(responderSocket, "the pending interaction responder has an authenticated socket");
      const responseId = `018f8e3d-7b11-7c82-8a7b-a1000000000${++responseSequence}`;
      let payload: Record<string, unknown> = { interactionId: pending.interactionId, choice: option.choice, ...option.payload };
      if (pending.kind === "DISCARDS_ORDER") {
        const spec = pending.context.discardOrder;
        assert.ok(typeof spec === "object" && spec !== null && !Array.isArray(spec));
        const order = spec as { allowedCardInstanceIds?: unknown; requiredCount?: unknown };
        assert.ok(Array.isArray(order.allowedCardInstanceIds));
        assert.ok(typeof order.requiredCount === "number");
        payload = {
          interactionId: pending.interactionId,
          choice: "ORDER_CARDS",
          orderedCardInstanceIds: order.allowedCardInstanceIds.slice(0, order.requiredCount),
        };
      }
      const responseCommand = {
        protocolVersion: 1,
        commandId: responseId,
        matchId,
        expectedVersion: afterTurn.version,
        type: "RESPOND",
        payload,
      };
      const parsedResponse = parseMatchCommand(responseCommand);
      assert.equal(parsedResponse.ok, true, JSON.stringify({
        pendingKind: pending.kind,
        option,
        responseCommand,
        parseFailure: parsedResponse.ok ? null : parsedResponse.path,
      }));
      const responseAck = await acknowledged(responderSocket, "match:command", responseCommand) as { status?: string; aggregateVersion?: number; error?: { code: string } };
      assert.equal(responseAck.status, "accepted", JSON.stringify({ pendingKind: pending.kind, option, responseCommand, responseAck }));
      assert.equal(responseAck.aggregateVersion, afterTurn.version + 1);
      afterTurn = await matchStorage.getMatch(matchId);
      assert.ok(afterTurn);
      assert.ok(responseSequence < 5, "turn-start and draw prompts resume without an unbounded interaction loop");
    }
    assert.equal(afterTurn.state.status, "playing");
    assert.equal(afterTurn.state.turn.currentPlayerId, nextActor.public.playerId);
    assert.equal(afterTurn.state.turn.phase, "play");
    assert.equal(afterTurn.state.seats.find((seat) => seat.public.playerId === nextActor.public.playerId)?.private.handCardInstanceIds.length, nextActorHandCount + 2);
    assert.equal(afterTurn.version, beforeTurn.version + 1 + responseSequence);

    const readReturnBoundary = async () => withClient(pool, async (client) => {
      const room = await client.query<{ status: string; version: string; owner_player_id: string }>(
        "SELECT status, version::text, owner_player_id FROM rooms WHERE id = $1",
        [created.roomId],
      );
      const roomSeats = await client.query<{ player_id: string; seat_index: number; ready: boolean }>(
        "SELECT player_id, seat_index, ready FROM room_players WHERE room_id = $1 ORDER BY seat_index",
        [created.roomId],
      );
      const match = await client.query<{ id: string; status: string; version: string; state_json: Record<string, unknown> }>(
        "SELECT id, status, version::text, state_json FROM matches WHERE id = $1",
        [matchId],
      );
      const events = await client.query(
        "SELECT event_seq, event_id, version, type, actor_player_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
        [matchId],
      );
      const receipts = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM command_receipts WHERE room_id = $1",
        [created.roomId],
      );
      const outbox = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = $1",
        [created.roomId],
      );
      return {
        room: room.rows[0],
        roomSeats: roomSeats.rows,
        match: match.rows[0],
        events: events.rows,
        receiptCount: receipts.rows[0]?.count,
        roomOutboxCount: outbox.rows[0]?.count,
      };
    });

    const beforeReturn = await readReturnBoundary();
    const rejectReturn = async (socket: Socket, commandId: string, expectedVersion: number) =>
      await acknowledged(socket, "room:command", {
        protocolVersion: 1,
        commandId,
        expectedVersion,
        roomId: created.roomId,
        type: "RETURN_TO_LOBBY",
        payload: {},
      }) as { status?: string; error?: { code: string; currentVersion?: number } };
    const whilePlaying = await rejectReturn(owner.socket, "018f8e3d-7b11-7c82-8a7b-b10000000001", startedRoomVersion);
    assert.equal(whilePlaying.status, "rejected");
    assert.equal(whilePlaying.error?.code, "ROOM_LOCKED");
    const outsiderReturn = await rejectReturn(guests[4]!.socket, "018f8e3d-7b11-7c82-8a7b-b20000000001", startedRoomVersion);
    assert.equal(outsiderReturn.status, "rejected");
    assert.equal(outsiderReturn.error?.code, "NOT_FOUND_OR_FORBIDDEN");
    assert.deepEqual(await readReturnBoundary(), beforeReturn, "playing and non-member denials do not write room or match data");
    const playingKick = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-b70000000001",
      expectedVersion: startedRoomVersion,
      roomId: created.roomId,
      type: "KICK_MEMBER",
      payload: { targetPlayerId: guests[3]!.playerId },
    }) as { status?: string; error?: { code: string } };
    assert.equal(playingKick.status, "rejected");
    assert.equal(playingKick.error?.code, "ROOM_LOCKED");
    assert.deepEqual(await readReturnBoundary(), beforeReturn, "in-game kick remains locked before returning to the lobby");

    await withClient(pool, (client) => client.query(
      `UPDATE matches
       SET status = 'completed', state_json = jsonb_set(state_json, '{status}', '"completed"'::jsonb), ended_at = now()
       WHERE id = $1`,
      [matchId],
    ));
    const completedMatch = await matchStorage.getMatch(matchId);
    assert.ok(completedMatch);
    const beforeCompletedReturn = await readReturnBoundary();
    const nonOwnerReturn = await rejectReturn(guests[1]!.socket, "018f8e3d-7b11-7c82-8a7b-b30000000001", startedRoomVersion);
    assert.equal(nonOwnerReturn.status, "rejected");
    assert.equal(nonOwnerReturn.error?.code, "NOT_ROOM_OWNER");
    const staleReturn = await rejectReturn(owner.socket, "018f8e3d-7b11-7c82-8a7b-b40000000001", startedRoomVersion - 1);
    assert.equal(staleReturn.status, "rejected");
    assert.equal(staleReturn.error?.code, "STALE_VERSION");
    assert.equal(staleReturn.error?.currentVersion, startedRoomVersion);
    assert.deepEqual(await readReturnBoundary(), beforeCompletedReturn, "authorization and stale denials do not write room or match data");

    const returnCommand = {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-b50000000001",
      expectedVersion: startedRoomVersion,
      roomId: created.roomId,
      type: "RETURN_TO_LOBBY",
      payload: {},
    };
    const returned = await acknowledged(owner.socket, "room:command", returnCommand) as {
      roomId: string;
      status: string;
      activeMatchId: string | null;
      ownerPlayerId: string;
      members: readonly { playerId: string; seatIndex: number; ready: boolean }[];
      viewer: { playerId: string; isOwner: boolean };
    };
    assert.equal(returned.roomId, created.roomId);
    assert.equal(returned.status, "waiting");
    assert.equal(returned.activeMatchId, null);
    assert.equal(returned.ownerPlayerId, owner.playerId);
    assert.equal(returned.viewer.isOwner, true);
    assert.deepEqual(returned.members.map(({ playerId, seatIndex, ready }) => ({ playerId, seatIndex, ready })),
      beforeCompletedReturn.roomSeats.map(({ player_id, seat_index }) => ({ playerId: player_id, seatIndex: seat_index, ready: true })));

    const duplicateReturn = await acknowledged(owner.socket, "room:command", returnCommand) as typeof returned;
    assert.deepEqual(duplicateReturn, returned);
    const synchronizedAfterReturn = await acknowledged(owner.socket, "room:sync", {
      protocolVersion: 1,
      requestId: "return-lobby-sync",
      roomId: created.roomId,
      knownVersion: startedRoomVersion + 1,
    }) as { version: number; requiresFullSnapshot: boolean; room: typeof returned };
    assert.equal(synchronizedAfterReturn.version, startedRoomVersion + 1);
    assert.equal(synchronizedAfterReturn.requiresFullSnapshot, false);
    assert.equal(synchronizedAfterReturn.room.status, "waiting");
    assert.equal(synchronizedAfterReturn.room.activeMatchId, null);
    assert.ok(synchronizedAfterReturn.room.members.every(({ ready }) => ready));
    assert.deepEqual(await matchStorage.getMatch(matchId), completedMatch, "return preserves completed match snapshot");
    const afterReturn = await readReturnBoundary();
    assert.equal(afterReturn.room?.status, "waiting");
    assert.equal(afterReturn.room?.version, String(startedRoomVersion + 1));
    assert.deepEqual(afterReturn.events, beforeCompletedReturn.events, "return preserves completed match events");
    assert.equal(afterReturn.roomOutboxCount, String(Number(beforeCompletedReturn.roomOutboxCount) + 1));
    const returnedOutbox = await withClient(pool, (client) => client.query<{ kind: string; payload_json: Record<string, unknown> }>(
      "SELECT kind, payload_json FROM outbox WHERE aggregate_id = $1 AND aggregate_version = $2",
      [created.roomId, startedRoomVersion + 1],
    ));
    assert.deepEqual(returnedOutbox.rows, [{ kind: "room:changed", payload_json: { roomId: created.roomId, version: startedRoomVersion + 1 } }]);
    const startAfterReturn = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-b60000000001",
      expectedVersion: startedRoomVersion + 1,
      roomId: created.roomId,
      type: "START_MATCH",
      payload: {},
    }) as { status?: string; activeMatchId?: string; error?: { code: string } };
    assert.equal(startAfterReturn.status, "in_game", "automatic readiness allows an immediate rematch");
    assert.ok(startAfterReturn.activeMatchId && startAfterReturn.activeMatchId !== matchId);

    const readKickBoundary = async () => withClient(pool, async (client) => {
      const room = await client.query<{ version: string }>("SELECT version::text AS version FROM rooms WHERE id = $1", [created.roomId]);
      const match = await client.query<{ version: string }>("SELECT version::text AS version FROM matches WHERE id = $1", [matchId]);
      const roomSeats = await client.query<{ player_id: string; seat_index: number }>(
        "SELECT player_id, seat_index FROM room_players WHERE room_id = $1 ORDER BY seat_index", [created.roomId],
      );
      const matchSeats = await client.query<{ player_id: string; seat_index: number }>(
        "SELECT player_id, seat_index FROM match_players WHERE match_id = $1 ORDER BY seat_index", [matchId],
      );
      return { roomVersion: room.rows[0]?.version, matchVersion: match.rows[0]?.version, roomSeats: roomSeats.rows, matchSeats: matchSeats.rows };
    });
    const beforeKick = await readKickBoundary();
    const outsiderKick = await acknowledged(guests[4]!.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-a20000000001",
      expectedVersion: Number(beforeKick.roomVersion),
      roomId: created.roomId,
      type: "KICK_MEMBER",
      payload: { targetPlayerId: guests[3]!.playerId },
    }) as { status?: string; error?: { code: string } };
    assert.equal(outsiderKick.status, "rejected");
    assert.equal(outsiderKick.error?.code, "NOT_FOUND_OR_FORBIDDEN");
    const ownerKick = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-a20000000002",
      expectedVersion: Number(beforeKick.roomVersion),
      roomId: created.roomId,
      type: "KICK_MEMBER",
      payload: { targetPlayerId: guests[3]!.playerId },
    }) as { status?: string; error?: { code: string } };
    assert.equal(ownerKick.status, "rejected");
    assert.equal(ownerKick.error?.code, "ROOM_LOCKED");
    assert.deepEqual(await readKickBoundary(), beforeKick, "in-game KICK_MEMBER stays locked and preserves versions and seats");
  } finally {
    for (const socket of sockets) socket.disconnect();
    await runtime?.close();
    await database.close();
  }
});

test("node-postgres runtime uses PGlite Socket and preserves sessions and migrations across database restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bang-server-pglite-runtime-"));
  const databasePort = await availableTcpPort();
  const databaseUrl = `postgresql://pglite:pglite@127.0.0.1:${databasePort}/postgres`;
  const config = testConfig(databaseUrl);
  const messages: string[] = [];
  const logger = {
    info: (message: string) => messages.push(message),
    error: (message: string) => messages.push(message),
  };
  const sockets: Socket[] = [];
  let database: PGlite | undefined;
  let databaseSocket: PGLiteSocketServer | undefined;
  let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
  let cookiePair: string | undefined;
  let rawCredential: string | undefined;

  const startDatabaseSocket = async () => {
    database = new PGlite(dataDir);
    await database.waitReady;
    databaseSocket = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: databasePort,
      maxConnections: 1,
    });
    await databaseSocket.start();
  };

  try {
    await startDatabaseSocket();
    runtime = await startServer(config, logger, 1);
    const baseUrl = `http://${runtime.host}:${runtime.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const created = await fetch(`${baseUrl}/api/guest-sessions`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, displayName: "소켓 저장 확인" }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as { player: { playerId: string; displayName: string } };
    assert.equal(session.player.displayName, "소켓 저장 확인");
    assert.ok(session.player.playerId.startsWith("p_"));

    const setCookie = created.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
    cookiePair = setCookie.split(";", 1)[0]!;
    rawCredential = decodeURIComponent(cookiePair.slice(cookiePair.indexOf("=") + 1));
    assert.equal(JSON.stringify(session).includes(rawCredential), false);
    assert.equal(messages.some((message) => message.includes(rawCredential)), false);

    const authenticated = createSocketClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Origin: "http://localhost:5173", Cookie: cookiePair },
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(authenticated);
    await connected(authenticated);
    assert.deepEqual(await acknowledged(authenticated, "room:preview", {
      protocolVersion: 1,
      requestId: "pglite-preview-before-restart",
      inviteCode: "not-a-real-invite",
    }), {
      protocolVersion: 1,
      requestId: "pglite-preview-before-restart",
      status: "rejected",
      error: { code: "INVITE_INVALID" },
    });

    const anonymous = createSocketClient(baseUrl, {
      extraHeaders: { Origin: "http://localhost:5173" },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(anonymous);
    await assert.rejects(connected(anonymous), /UNAUTHENTICATED/);

    await runtime.close();
    runtime = undefined;
    await databaseSocket.stop();
    databaseSocket = undefined;
    await database.close();
    database = undefined;

    // Reopen the same on-disk directory as a fresh PGlite instance and fresh PostgreSQL-wire listener.
    await startDatabaseSocket();
    runtime = await startServer(config, logger, 1);
    const restartedBaseUrl = `http://${runtime.host}:${runtime.port}`;
    const restartedHealth = await fetch(`${restartedBaseUrl}/healthz`);
    assert.equal(restartedHealth.status, 200);

    const restoredAfterRestart = await fetch(`${restartedBaseUrl}/api/guest-sessions`, {
      headers: { Cookie: cookiePair! },
    });
    assert.equal(restoredAfterRestart.status, 200);
    assert.equal(restoredAfterRestart.headers.get("cache-control"), "no-store");
    const restoredAfterRestartSession = await restoredAfterRestart.json() as {
      player: { playerId: string; displayName: string };
    };
    assert.deepEqual(restoredAfterRestartSession.player, session.player);
    const restoredAfterRestartRooms = await fetch(`${restartedBaseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: cookiePair! },
    });
    assert.equal(restoredAfterRestartRooms.status, 200);
    assert.deepEqual(await restoredAfterRestartRooms.json(), []);

    const restored = createSocketClient(restartedBaseUrl, {
      transports: ["websocket"],
      extraHeaders: { Origin: "http://localhost:5173", Cookie: cookiePair! },
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(restored);
    await connected(restored);
    assert.deepEqual(await acknowledged(restored, "room:preview", {
      protocolVersion: 1,
      requestId: "pglite-preview-after-restart",
      inviteCode: "not-a-real-invite",
    }), {
      protocolVersion: 1,
      requestId: "pglite-preview-after-restart",
      status: "rejected",
      error: { code: "INVITE_INVALID" },
    });

    await runtime.close();
    runtime = undefined;
    const migrations = await database!.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(migrations.rows.map(({ version }) => version), [1]);
    const guests = await database!.query<{ token_hash: string }>(
      "SELECT token_hash FROM guest_sessions",
    );
    assert.equal(guests.rows.length, 1);
    assert.notEqual(guests.rows[0]?.token_hash, rawCredential);
    assert.equal(messages.some((message) => message.includes(rawCredential!)), false);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await runtime?.close();
    await databaseSocket?.stop().catch(() => undefined);
    await database?.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
