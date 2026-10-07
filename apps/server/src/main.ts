import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { Server as SocketIoServer } from "socket.io";
import type { GuestSessionRequest, GuestSessionResponse, CommandRejected } from "../../../packages/contracts/src/protocol.js";
import { createMatchCommandHandler } from "./commands/index.js";
import { advanceTurnPhases, createTurnAwareCommandHandlers } from "./commands/turn-runtime.js";
import { createEffectCommandHandlers } from "../../../packages/engine/src/effects/runtime/index.js";
import { createEffectRegistry } from "../../../packages/engine/src/effects/registry.js";
import { withTurnStartEffects } from "../../../packages/engine/src/turn/draw.js";
import {
  readPGliteDevConfig,
  readServerConfig,
  ServerConfigurationError,
  type ServerConfig,
} from "./config.js";
import { projectOutboxNotification } from "./projections/outbox.js";
import { createSyncProjectionHandlers } from "./projections/sync.js";
import { RecoveryService } from "./recovery/index.js";
import { RoomService, RoomServiceError } from "./rooms/service.js";
import { installSocketGateway, type GatewayHandlers, type GatewayIo } from "./socket/gateway.js";
import { withClient } from "./storage/database-runtime.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "./storage/database.js";
import { applyStorageMigrations } from "./storage/migrations.js";
import { RoomLifecycleError, RoomLifecycleRepository, RoomVersionConflictError } from "./storage/room-lifecycle.js";
import { StorageRepository } from "./storage/repository.js";

const MAX_HTTP_BODY_BYTES = 8 * 1024;

export interface ServerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface RuntimeServerOptions {
  readonly closePool?: () => Promise<void>;
  readonly logger?: ServerLogger;
}

export interface RunningServer {
  readonly httpServer: HttpServer;
  readonly io: SocketIoServer;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const consoleLogger: ServerLogger = {
  info: (message) => console.info(`[server] ${message}`),
  error: (message) => console.error(`[server] ${message}`),
};

class HttpInputError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpInputError(415, "Expected application/json.");

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > MAX_HTTP_BODY_BYTES) throw new HttpInputError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  if (byteLength === 0) throw new HttpInputError(400, "Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpInputError(400, "Request body must be valid JSON.");
  }
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(encoded);
}

function applyHttpCors(request: IncomingMessage, response: ServerResponse, config: ServerConfig): void {
  if (request.headers.origin !== config.webOrigin) return;
  response.setHeader("Access-Control-Allow-Origin", config.webOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
}

function guestSessionInput(value: unknown): GuestSessionRequest {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "protocolVersion") || !Object.hasOwn(value, "displayName") ||
      value.protocolVersion !== 1 || typeof value.displayName !== "string") {
    throw new HttpInputError(400, "Invalid guest session request.");
  }
  return { protocolVersion: 1, displayName: value.displayName };
}

function sessionCookie(config: ServerConfig, credential: string, expiresAt: string): string {
  const parts = [
    `${config.sessionCookieName}=${encodeURIComponent(credential)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (config.guestSessionTtlMs !== undefined) {
    parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  }
  return parts.join("; ");
}

function sessionCredential(request: IncomingMessage, cookieName: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;

  const matches: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    try {
      matches.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return undefined;
    }
  }
  return matches.length === 1 && matches[0]!.length > 0 ? matches[0] : undefined;
}

function writeNoContent(response: ServerResponse): void {
  response.writeHead(204, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  rooms: RoomService,
  logger: ServerLogger,
): Promise<void> {
  applyHttpCors(request, response, config);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  if (request.method === "GET" && path === "/healthz") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && path === "/api/guest-sessions") {
    const credential = sessionCredential(request, config.sessionCookieName);
    if (!credential) {
      writeNoContent(response);
      return;
    }
    try {
      const guest = await rooms.authenticateGuestCredential(credential);
      if (!guest) {
        writeNoContent(response);
        return;
      }
      const restored: GuestSessionResponse = {
        protocolVersion: 1,
        player: { playerId: guest.playerId, displayName: guest.displayName },
        sessionExpiresAt: guest.expiresAt.toISOString(),
      };
      writeJson(response, 200, restored);
    } catch {
      logger.error("guest_session_restore_failed");
      writeJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
    }
    return;
  }

  if (request.method === "GET" && path === "/api/guest-sessions/rooms") {
    const credential = sessionCredential(request, config.sessionCookieName);
    if (!credential) {
      writeJson(response, 401, { error: { code: "SESSION_EXPIRED" } });
      return;
    }
    try {
      const assignedRooms = await rooms.recoverAssignedSeats(credential);
      if (assignedRooms === null) {
        writeJson(response, 401, { error: { code: "SESSION_EXPIRED" } });
        return;
      }
      writeJson(response, 200, assignedRooms);
    } catch {
      logger.error("assigned_room_restore_failed");
      writeJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
    }
    return;
  }

  if (request.method === "POST" && path === "/api/guest-sessions") {
    try {
      const input = guestSessionInput(await readJsonBody(request));
      const issue = await rooms.createGuestSession(input.displayName);
      response.setHeader("Set-Cookie", sessionCookie(config, issue.credential, issue.response.sessionExpiresAt));
      writeJson(response, 201, issue.response);
    } catch (error) {
      if (error instanceof HttpInputError) {
        writeJson(response, error.statusCode, { error: { code: "BAD_REQUEST" } });
        return;
      }
      if (error instanceof RangeError || error instanceof TypeError) {
        writeJson(response, 400, { error: { code: "BAD_REQUEST" } });
        return;
      }
      // Never log request data or the credential returned by RoomService.
      logger.error("guest_session_create_failed");
      writeJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
    }
    return;
  }

  if (path === "/api/guest-sessions/profile") {
    if (request.method !== "POST") { response.setHeader("Allow", "POST, OPTIONS"); writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } }); return; }
    try {
      const input = guestSessionInput(await readJsonBody(request));
      const credential = sessionCredential(request, config.sessionCookieName);
      const profile = credential ? await rooms.renameGuest(credential, input.displayName) : null;
      writeJson(response, profile ? 200 : 401, profile ?? { error: { code: "SESSION_EXPIRED" } });
    } catch (error) {
      const badInput = error instanceof HttpInputError || error instanceof RangeError || error instanceof TypeError;
      writeJson(response, badInput ? 400 : 500, { error: { code: badInput ? "BAD_REQUEST" : "INTERNAL_ERROR" } });
    }
    return;
  }

  if (path === "/api/guest-sessions") {
    response.setHeader("Allow", "GET, POST, OPTIONS");
    writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
    return;
  }

  if (path === "/api/guest-sessions/rooms") {
    response.setHeader("Allow", "GET, OPTIONS");
    writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
    return;
  }

  writeJson(response, 404, { error: { code: "NOT_FOUND" } });
}

function rejectedCommand(commandId: string, code: string, currentVersion?: number): CommandRejected {
  return {
    protocolVersion: 1,
    commandId,
    status: "rejected",
    error: {
      code,
      messageKey: code === "BAD_REQUEST" ? "protocol.badRequest" : `server.${code.toLowerCase()}`,
      retryable: code === "STALE_VERSION",
      ...(currentVersion === undefined ? {} : { currentVersion }),
    },
  };
}

function roomCommandError(commandId: string, error: unknown, logger: ServerLogger): CommandRejected {
  if (error instanceof RoomVersionConflictError) {
    return rejectedCommand(commandId, error.code, error.currentVersion);
  }
  if (error instanceof RoomLifecycleError || error instanceof RoomServiceError) {
    return rejectedCommand(commandId, error.code);
  }
  logger.error("room_command_failed");
  return rejectedCommand(commandId, "INTERNAL_ERROR");
}

function roomCommandHandler(
  rooms: RoomService,
  logger: ServerLogger,
): GatewayHandlers["roomCommand"] {
  return async (context, command, ack) => {
    try {
      switch (command.type) {
        case "JOIN": {
          const result = await rooms.joinPrivateRoom(context.playerId, {
            roomId: command.roomId,
            inviteCode: command.payload.inviteCode,
            expectedVersion: command.expectedVersion,
            commandId: command.commandId,
          });
          ack(result.room ?? rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
          return;
        }
        case "SET_READY": {
          const result = await rooms.setReady(context.playerId, {
            roomId: command.roomId,
            ready: command.payload.ready,
            expectedVersion: command.expectedVersion,
            commandId: command.commandId,
          });
          ack(result.room ?? rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
          return;
        }
        case "CLOSE_ROOM": {
          const result = await rooms.closeRoom(context.playerId, {
            roomId: command.roomId,
            expectedVersion: command.expectedVersion,
            commandId: command.commandId,
          });
          ack(result.room ?? rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
          return;
        }
        case "START_MATCH": {
          const result = await rooms.startMatch(context.playerId, {
            roomId: command.roomId,
            expectedVersion: command.expectedVersion,
            commandId: command.commandId,
          });
          // RoomView.activeMatchId is the protocol-owned route to the exact match.
          ack(result.room ?? rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
          return;
        }
        case "RETURN_TO_LOBBY": {
          const result = await rooms.returnToLobby(context.playerId, {
            roomId: command.roomId,
            expectedVersion: command.expectedVersion,
            commandId: command.commandId,
          });
          ack(result.room ?? rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
          return;
        }
        case "KICK_MEMBER": {
          const room = await rooms.roomViewForMember(command.roomId, context.playerId);
          if (!room) {
            ack(rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
            return;
          }
          if (!room.viewer.isOwner) {
            ack(rejectedCommand(command.commandId, "ROOM_FORBIDDEN"));
            return;
          }
          if (room.activeMatchId !== null) {
            ack(rejectedCommand(command.commandId, "ROOM_LOCKED"));
            return;
          }
          ack(rejectedCommand(command.commandId, "COMMAND_UNAVAILABLE"));
          return;
        }
        case "SET_RULESET":
          // These operations have no completed application adapter yet.
          ack(rejectedCommand(command.commandId, "COMMAND_UNAVAILABLE"));
          return;
      }
    } catch (error) {
      ack(roomCommandError(command.commandId, error, logger));
    }
  };
}

function gatewayHandlers(
  storage: StorageRepository,
  rooms: RoomService,
  logger: ServerLogger,
): GatewayHandlers {
  const syncHandlers = createSyncProjectionHandlers({ storage });
  const matchCommand = createMatchCommandHandler({
    storage,
    prepareEngineContext: ({ matchId }) => {
      const random = {
        nextFloat: () => {
          let value = 0;
          for (const byte of Buffer.from(randomBytes(6).toString("base64url"), "base64url")) {
            value = value * 256 + byte;
          }
          return value / 0x1_0000_0000_0000;
        },
      };
      const nextInteractionIdentity = () => ({
        interactionId: `interaction_${randomUUID()}`,
        createdAt: new Date().toISOString(),
      });
      const runtimeOptions = withTurnStartEffects({
        registry: createEffectRegistry(),
        nextInteractionIdentity,
      });
      const turnRuntime = { matchId, random, nextInteractionIdentity, runtimeOptions };
      return {
        random,
        interaction: nextInteractionIdentity(),
        handlers: createTurnAwareCommandHandlers(createEffectCommandHandlers(runtimeOptions), turnRuntime),
        continueTurnPhases: (state) => advanceTurnPhases(state, turnRuntime),
      };
    },
  });

  return {
    roomCreate: async (context, command, ack) => {
      try {
        const result = await rooms.createPrivateRoom(context.playerId, {
          capacity: command.payload.capacity,
          rulesetVersion: command.payload.rulesetVersion,
          commandId: command.commandId,
        });
        if (!result.room) {
          ack(rejectedCommand(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
          return;
        }
        // Matches the T50 room-entry transport DTO. Duplicate creation has no replayable invite code.
        ack({
          roomId: result.room.roomId,
          version: result.version,
          inviteCode: result.inviteCode,
          duplicate: result.duplicate,
        });
      } catch (error) {
        ack(roomCommandError(command.commandId, error, logger));
      }
    },
    roomCommand: roomCommandHandler(rooms, logger),
    matchCommand,
    roomSync: syncHandlers.roomSync,
    matchSync: syncHandlers.matchSync,
    matchHistory: syncHandlers.matchHistory,
  };
}

function listen(server: HttpServer, config: ServerConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(config.port, config.host);
  });
}

function boundPort(server: HttpServer): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP server has no TCP address.");
  return address.port;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function startOutboxPublisher(
  storage: StorageRepository,
  pool: PgPoolLike,
  io: SocketIoServer,
  logger: ServerLogger,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activePoll: Promise<void> | undefined;

  const poll = async (): Promise<void> => {
    try {
      const records = await storage.listPendingOutbox();
      for (const record of records) {
        if (stopped) return;
        const notification = projectOutboxNotification(record);
        const channel = record.kind === "room:changed"
          ? `lobby:${record.aggregateId}`
          : `match:${record.aggregateId}`;
        io.to(channel).emit(notification.event, notification.payload);
        await withClient(pool, (client) => client.query(
          `UPDATE outbox
           SET published_at = now()
           WHERE event_id = $1 AND published_at IS NULL`,
          [record.eventId],
        ));
      }
    } catch {
      // Leave unacknowledged rows pending. Repeated notifications are safe because clients sync by version.
      logger.error("outbox_publish_failed");
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      activePoll = poll().finally(() => {
        activePoll = undefined;
        schedule();
      });
    }, 250);
    timer.unref();
  };
  schedule();

  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await activePoll;
  };
}

function pgPoolAdapter(pool: Pool): PgPoolLike {
  return {
    async connect(): Promise<PgClientLike> {
      const client = await pool.connect();
      return {
        async query<Row = Record<string, unknown>>(
          sql: string,
          parameters: unknown[] = [],
        ): Promise<PgQueryResult<Row>> {
          const result = await client.query(sql, parameters);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
  };
}

/** Run migrations and recovery checks before exposing either HTTP or Socket.IO. */
export async function createRuntimeServer(
  config: ServerConfig,
  pool: PgPoolLike,
  options: RuntimeServerOptions = {},
): Promise<RunningServer> {
  const logger = options.logger ?? consoleLogger;
  await applyStorageMigrations(pool);
  await withClient(pool, async (client) => {
    await client.query("SELECT 1");
  });

  const storage = new StorageRepository(pool);
  const lifecycle = new RoomLifecycleRepository(pool);
  const rooms = new RoomService({
    storage,
    lifecycle,
    pool,
    options: {
      ...(config.guestSessionTtlMs === undefined ? {} : { guestSessionTtlMs: config.guestSessionTtlMs }),
      ...(config.roomRetentionMs === undefined ? {} : { roomRetentionMs: config.roomRetentionMs }),
    },
  });
  const recovery = new RecoveryService({ pool, rooms });
  const recoveryResults = await recovery.recoverPersistedMatches();
  if (recoveryResults.some(({ status }) => status === "recovery_required")) {
    logger.error("one_or_more_matches_require_recovery");
  }

  const httpServer = createHttpServer((request, response) => {
    void handleHttpRequest(request, response, config, rooms, logger).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
      else response.destroy();
    });
  });
  const io = new SocketIoServer(httpServer, {
    serveClient: false,
    maxHttpBufferSize: MAX_HTTP_BODY_BYTES,
    cors: {
      origin: config.webOrigin,
      credentials: true,
      methods: ["GET", "POST"],
    },
  });
  installSocketGateway(io as unknown as GatewayIo, {
    roomService: rooms,
    authorizeMatchMember: async (playerId, matchId) => {
      const match = await storage.getMatch(matchId);
      return match?.players.some((player) => player.playerId === playerId) ?? false;
    },
    handlers: gatewayHandlers(storage, rooms, logger),
    sessionCookieName: config.sessionCookieName,
  });

  try {
    await listen(httpServer, config);
  } catch (error) {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await closeHttpServer(httpServer).catch(() => undefined);
    throw error;
  }

  const stopOutboxPublisher = startOutboxPublisher(storage, pool, io, logger);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      await stopOutboxPublisher();
      await new Promise<void>((resolve, reject) => {
        io.close((error) => error ? reject(error) : resolve());
      });
      await closeHttpServer(httpServer);
      await options.closePool?.();
    })();
    return closing;
  };

  const port = boundPort(httpServer);
  logger.info(`Database schema ready; HTTP and Socket.IO listening at ${config.host}:${port}.`);
  return { httpServer, io, port, host: config.host, close };
}

/** Create the PostgreSQL pool from validated settings and start the local service. */
export async function startServer(
  config: ServerConfig = readServerConfig(),
  logger: ServerLogger = consoleLogger,
  poolMax = 10,
): Promise<RunningServer> {
  const driverPool = new Pool({ connectionString: config.databaseUrl, max: poolMax });
  try {
    return await createRuntimeServer(config, pgPoolAdapter(driverPool), {
      logger,
      closePool: () => driverPool.end(),
    });
  } catch (error) {
    await driverPool.end().catch(() => undefined);
    throw error;
  }
}

/** Start the PostgreSQL-wire-compatible PGlite adapter for local development only. */
async function startPGliteDevServer(logger: ServerLogger = consoleLogger): Promise<RunningServer> {
  const localConfig = readPGliteDevConfig();
  const config = readServerConfig({
    ...process.env,
    DATABASE_URL: `postgresql://pglite:pglite@127.0.0.1:${localConfig.port}/postgres`,
  });
  // These packages are development-only; keep them out of the normal PostgreSQL startup path.
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const database = new PGlite(localConfig.dataDir);
  let socketServer: InstanceType<typeof PGLiteSocketServer> | undefined;
  let socketStarted = false;
  let runtime: RunningServer | undefined;

  try {
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: localConfig.port,
      maxConnections: 1,
    });
    await socketServer.start();
    socketStarted = true;

    // PGlite Socket multiplexes queries over one connection; do not create a PostgreSQL-sized pool here.
    runtime = await startServer(config, logger, 1);
    logger.info(`Local PGlite Socket database ready at 127.0.0.1:${localConfig.port}.`);

    let closing: Promise<void> | undefined;
    return {
      httpServer: runtime.httpServer,
      io: runtime.io,
      port: runtime.port,
      host: runtime.host,
      close: () => {
        if (closing) return closing;
        closing = (async () => {
          const errors: unknown[] = [];
          try {
            await runtime!.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            await socketServer!.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            await database.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "Local PGlite shutdown failed.");
        })();
        return closing;
      },
    };
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    if (socketStarted) await socketServer?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

function registerShutdown(running: RunningServer): void {
  let shutdownRequested = false;
  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    void running.close().then(() => {
      consoleLogger.info("shutdown complete.");
    }).catch(() => {
      consoleLogger.error("shutdown failed.");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runCli(): Promise<void> {
  const running = process.argv.includes("--pglite-dev")
    ? await startPGliteDevServer()
    : await startServer();
  registerShutdown(running);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  void runCli().catch((error: unknown) => {
    if (error instanceof ServerConfigurationError) {
      consoleLogger.error(`invalid configuration: ${error.message}`);
    } else {
      // Do not print connection strings or request data in startup diagnostics.
      consoleLogger.error("startup failed; check database configuration, availability, and migrations.");
    }
    process.exitCode = 1;
  });
}

export { readServerConfig };
