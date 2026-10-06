const STORAGE_KEY = "bang.room-invites.v1";
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadRoomInvites(playerId: string, storage?: StorageLike): Readonly<Record<string, string>> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const record = saved as { playerId?: unknown; invites?: unknown };
    if (record.playerId !== playerId || !record.invites || typeof record.invites !== "object" || Array.isArray(record.invites)) return {};
    return Object.fromEntries(Object.entries(record.invites).filter(([id, code]) =>
      id.length > 0 && id.length <= 256 && typeof code === "string" && code.length > 0 && code.length <= 256));
  } catch { return {}; }
}

export function saveRoomInvites(playerId: string, invites: Readonly<Record<string, string>>, storage?: StorageLike): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify({ playerId, invites })); }
  catch { /* Private mode or full storage must not prevent joining or playing. */ }
}

export function browserInviteStorage(): StorageLike | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}
