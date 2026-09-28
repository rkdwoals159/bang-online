import type { ServerEvent } from "../../../../packages/contracts/src/protocol.js";
import type { OutboxRecord } from "../storage/repository.js";

/**
 * Converts a durable outbox row to the protocol's cache-invalidation signal.
 * The row's JSON payload is intentionally ignored so persisted state can never
 * be copied into a Socket.IO notification.
 */
export function projectOutboxNotification(record: OutboxRecord): ServerEvent {
  if (record.aggregateId.trim().length === 0 ||
      !Number.isSafeInteger(record.aggregateVersion) || record.aggregateVersion < 0 ||
      !Number.isSafeInteger(record.eventSeq) || record.eventSeq < 0) {
    throw new TypeError("Outbox aggregate identity and cursors must be valid non-negative values.");
  }

  if (record.kind === "room:changed") {
    return {
      event: "room:changed",
      payload: {
        roomId: record.aggregateId,
        version: record.aggregateVersion,
      },
    };
  }

  return {
    event: "match:changed",
    payload: {
      matchId: record.aggregateId,
      version: record.aggregateVersion,
      eventSeq: record.eventSeq,
    },
  };
}
