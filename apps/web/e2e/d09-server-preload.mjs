import { createRequire } from "node:module";
import { resolve } from "node:path";

const serverPackageDirectory = process.env.T60_D09_SERVER_PACKAGE_DIR;
if (!serverPackageDirectory) throw new Error("T60_D09_SERVER_PACKAGE_DIR is required for the D09-only preload.");

const require = createRequire(resolve(serverPackageDirectory, "package.json"));
const { Server } = require("socket.io");
const { Pool } = require("pg");
let armedOutboxDrop = null;
let armedPrecommitFault = null;
let serverPool = null;

const transactionEvidence = new WeakMap();

function queryText(config) {
  return typeof config === "string" ? config : config?.text ?? "";
}

function queryValues(config, values) {
  if (Array.isArray(config)) return values ?? [];
  return Array.isArray(values) ? values : config?.values ?? [];
}

function signal(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

const originalPoolConnect = Pool.prototype.connect;
Pool.prototype.connect = function (...args) {
  const pool = this;
  const result = originalPoolConnect.apply(this, args);
  if (!result || typeof result.then !== "function") return result;
  return result.then((client) => {
    if (!serverPool) {
      serverPool = pool;
      signal({ type: "T60_D09_POOL_READY" });
    }
    if (!transactionEvidence.has(client)) {
      transactionEvidence.set(client, {
        matchId: null,
        version: null,
        matchUpdated: false,
        eventInsertCount: 0,
        receiptInserted: false,
        outboxInserted: false,
        savepointReleased: false,
      });
      const originalQuery = client.query;
      client.query = function (config, values, callback) {
        const text = queryText(config);
        const normalized = text.replace(/\s+/gu, " ").trim().toLowerCase();
        const parameters = queryValues(config, values);
        if (normalized === "begin") {
          transactionEvidence.set(client, {
            matchId: null,
            version: null,
            matchUpdated: false,
            eventInsertCount: 0,
            receiptInserted: false,
            outboxInserted: false,
            savepointReleased: false,
          });
        }
        const current = transactionEvidence.get(client);
        if (normalized.startsWith("commit") && armedPrecommitFault &&
            current?.matchId === armedPrecommitFault.matchId &&
            current?.version === armedPrecommitFault.version &&
            current.matchUpdated && current.eventInsertCount > 0 && current.receiptInserted &&
            current.outboxInserted && current.savepointReleased) {
          const fault = armedPrecommitFault;
          armedPrecommitFault = null;
          current.commitFaultInjected = true;
          signal({
            type: "T60_D09_PRECOMMIT_FAULT_INJECTED",
            ...fault,
            transactionEvidence: { ...current },
          });
          return Promise.reject(new Error("T60_D09 injected failure immediately before PostgreSQL COMMIT."));
        }
        if (normalized === "rollback" && current?.commitFaultInjected) {
          current.rollbackObserved = true;
          signal({
            type: "T60_D09_ROLLBACK_OBSERVED",
            matchId: current.matchId,
            version: current.version,
            transactionEvidence: { ...current },
          });
        }

        const result = originalQuery.apply(this, [config, values, callback]);
        const mark = () => {
          const state = transactionEvidence.get(client);
          if (normalized.startsWith("update matches")) {
            state.matchId = String(parameters[0] ?? "");
            state.version = Number(parameters[2]);
            state.matchUpdated = true;
          } else if (normalized.startsWith("insert into match_events")) {
            state.eventInsertCount += 1;
          } else if (normalized.startsWith("insert into command_receipts")) {
            state.receiptInserted = true;
          } else if (normalized.startsWith("insert into outbox")) {
            state.matchId = String(parameters[1] ?? "");
            state.version = Number(parameters[2]);
            state.outboxInserted = true;
          } else if (normalized.startsWith("release savepoint match_commit_writes")) {
            state.savepointReleased = true;
          }
        };
        if (result && typeof result.then === "function") return result.then((value) => { mark(); return value; });
        mark();
        return result;
      };
    }
    return client;
  });
};

const originalTo = Server.prototype.to;
Server.prototype.to = function (...rooms) {
  const broadcast = originalTo.apply(this, rooms);
  const originalEmit = broadcast.emit;
  broadcast.emit = function (eventName, ...args) {
    const payload = args[0];
    if (armedOutboxDrop && eventName === "match:changed" &&
        payload?.matchId === armedOutboxDrop.matchId &&
        payload?.version === armedOutboxDrop.version) {
      const dropped = armedOutboxDrop;
      armedOutboxDrop = null;
      if (typeof process.send === "function" && process.connected) {
        process.send({
          type: "T60_D09_OUTBOX_NOTIFICATION_DROPPED",
          matchId: dropped.matchId,
          version: dropped.version,
          eventSeq: payload.eventSeq,
        });
      }
      return true;
    }
    return originalEmit.call(this, eventName, ...args);
  };
  return broadcast;
};

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "T60_D09_ARM_OUTBOX_DROP" &&
      typeof message.matchId === "string" &&
      Number.isSafeInteger(message.version) && message.version >= 0 &&
      armedOutboxDrop === null) {
    armedOutboxDrop = { matchId: message.matchId, version: message.version };
    if (typeof process.send === "function" && process.connected) {
      process.send({
        type: "T60_D09_OUTBOX_DROP_ARMED",
        matchId: armedOutboxDrop.matchId,
        version: armedOutboxDrop.version,
      });
    }
    return;
  }
  if (message.type === "T60_D09_ARM_PRECOMMIT_FAIL" &&
      typeof message.matchId === "string" &&
      Number.isSafeInteger(message.version) && message.version >= 0 &&
      armedPrecommitFault === null) {
    armedPrecommitFault = { matchId: message.matchId, version: message.version };
    signal({ type: "T60_D09_PRECOMMIT_FAULT_ARMED", ...armedPrecommitFault });
    return;
  }
  if (message.type === "T60_D09_DB_QUERY" &&
      typeof message.requestId === "string" && typeof message.sql === "string" &&
      (message.parameters === undefined || Array.isArray(message.parameters))) {
    if (!serverPool) {
      signal({ type: "T60_D09_DB_QUERY_RESULT", requestId: message.requestId, error: "server database pool is not ready" });
      return;
    }
    void serverPool.query(message.sql, message.parameters ?? []).then((result) => {
      signal({ type: "T60_D09_DB_QUERY_RESULT", requestId: message.requestId, rows: result.rows });
    }, (error) => {
      signal({
        type: "T60_D09_DB_QUERY_RESULT",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  if (message.type === "T60_D09_SHUTDOWN") {
    process.emit("SIGINT");
    if (typeof process.disconnect === "function" && process.connected) process.disconnect();
  }
});

if (typeof process.send === "function" && process.connected) {
  process.send({ type: "T60_D09_PRELOAD_READY" });
}
