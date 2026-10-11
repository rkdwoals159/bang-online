import type { Server, Socket } from "socket.io";
import type { RoomConnectionState, RoomPresenceView } from "../../../../packages/contracts/src/protocol.js";
import type { PgPoolLike } from "../storage/database.js";
import { withClient } from "../storage/database-runtime.js";
import { playerIdFor } from "./gateway.js";

/** Socket lifetime is independent of seats, game versions, and persisted sessions. */
export class RoomPresence {
  private readonly sockets = new Map<string, Set<string>>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private observedAt = 0;

  stateForPlayer = (playerId: string): RoomConnectionState =>
    this.sockets.has(playerId) ? "connected" : "disconnected";

  install(io: Server, pool: PgPoolLike, onError: () => void): () => Promise<void> {
    const publish = async (playerId: string): Promise<void> => {
      const result = await withClient(pool, client => client.query<{ room_id: string; player_id: string }>(
        `SELECT members.room_id, members.player_id FROM room_players members
         JOIN rooms r ON r.id = members.room_id
         WHERE r.status IN ('waiting', 'starting') AND EXISTS (
           SELECT 1 FROM room_players subject WHERE subject.room_id = members.room_id AND subject.player_id = $1
         ) ORDER BY members.room_id, members.seat_index`, [playerId],
      ));
      if (this.stopped) return;
      const rooms = new Map<string, string[]>();
      for (const row of result.rows) {
        const members = rooms.get(row.room_id) ?? [];
        members.push(row.player_id);
        rooms.set(row.room_id, members);
      }
      for (const [roomId, members] of rooms) {
        this.observedAt = Math.max(Date.now(), this.observedAt + 1);
        const view: RoomPresenceView = {
          protocolVersion: 1, roomId, observedAt: new Date(this.observedAt).toISOString(),
          members: members.map(playerId => ({ playerId, connectionState: this.stateForPlayer(playerId) })),
        };
        // Fresh membership recipients exclude guests removed from an old lobby channel.
        io.to(members.map(id => `player:${id}`)).emit("room:presence", view);
      }
    };
    const enqueue = (playerId: string): void => {
      if (this.stopped) return;
      const task = publish(playerId).catch(onError);
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    };
    const connection = (socket: Socket): void => {
      if (this.stopped) return;
      const playerId = playerIdFor(socket);
      if (!playerId) return;
      const connections = this.sockets.get(playerId) ?? new Set<string>();
      const first = connections.size === 0;
      connections.add(socket.id);
      this.sockets.set(playerId, connections);
      if (first) enqueue(playerId);
      socket.once("disconnect", () => {
        connections.delete(socket.id);
        if (connections.size === 0) {
          this.sockets.delete(playerId);
          enqueue(playerId);
        }
      });
    };
    io.on("connection", connection);
    return async () => {
      this.stopped = true;
      io.off("connection", connection);
      await Promise.all(this.pending);
    };
  }
}
