import type { GuestSessionResponse } from "../../../../../packages/contracts/src/protocol.js";
import { D1StorageRepository, type D1DatabaseLike, type GuestSessionLookup } from "../../storage/index.js";
import { opaqueId, opaqueSecret, sha256Hex } from "./crypto.js";

const NO_SESSION_EXPIRY = new Date("9999-12-31T23:59:59.999Z");
const DISPLAY_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_DISPLAY_NAME_CODE_POINTS = 20;

export interface GuestSessionOptions {
  now?: () => Date;
  guestSessionTtlMs?: number;
  crypto?: Crypto;
}

export interface GuestSessionIssue {
  response: GuestSessionResponse;
  /** Credential is only suitable for Set-Cookie; it must never enter a response body or log. */
  credential: string;
}

export function normalizeGuestName(input: string): string {
  if (typeof input !== "string") throw new TypeError("Display name is required.");
  const name = input.trim();
  if (!name || DISPLAY_NAME_CONTROL_CHARACTERS.test(name) || Array.from(name).length > MAX_DISPLAY_NAME_CODE_POINTS)
    throw new RangeError("Invalid display name.");
  return name;
}

export class GuestSessionService {
  private readonly repository: D1StorageRepository;
  private readonly options: GuestSessionOptions;

  constructor(db: D1DatabaseLike, options: GuestSessionOptions = {}) {
    this.repository = new D1StorageRepository(db);
    this.options = options;
    const ttl = options.guestSessionTtlMs;
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl <= 0)) {
      throw new RangeError("Guest session TTL must be a positive safe integer.");
    }
  }

  async create(displayNameInput: string): Promise<GuestSessionIssue> {
    if (typeof displayNameInput !== "string") throw new TypeError("Display name is required.");
    const displayName = displayNameInput.trim();
    if (!displayName) throw new RangeError("Display name is required.");
    if (DISPLAY_NAME_CONTROL_CHARACTERS.test(displayName)) {
      throw new RangeError("Display name must not contain control characters.");
    }
    if (Array.from(displayName).length > MAX_DISPLAY_NAME_CODE_POINTS) {
      throw new RangeError("Display name must contain no more than 20 Unicode code points.");
    }

    const credential = opaqueSecret(this.options.crypto);
    const playerId = opaqueId("p", this.options.crypto);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + (this.options.guestSessionTtlMs ?? NO_SESSION_EXPIRY.getTime() - now.getTime()));
    await this.repository.createGuestSession({
      id: playerId,
      tokenHash: await sha256Hex(credential, this.options.crypto),
      displayName,
      expiresAt,
    });
    return {
      response: {
        protocolVersion: 1,
        player: { playerId, displayName },
        sessionExpiresAt: expiresAt.toISOString(),
      },
      credential,
    };
  }

  async authenticate(credential: string | undefined, at = this.now()): Promise<GuestSessionLookup | null> {
    if (typeof credential !== "string" || credential.length === 0) return null;
    return this.repository.findActiveGuestSessionByTokenHash(await sha256Hex(credential, this.options.crypto), at);
  }

  async rename(credential: string | undefined, displayNameInput: string): Promise<GuestSessionResponse | null> {
    const displayName = normalizeGuestName(displayNameInput);
    const guest = await this.authenticate(credential);
    if (!guest) return null;
    await this.repository.renameGuest(guest.playerId, displayName, opaqueId("profile", this.options.crypto), this.now());
    const current = await this.authenticate(credential);
    return current ? { protocolVersion: 1, player: { playerId: current.playerId, displayName: current.displayName },
      sessionExpiresAt: current.expiresAt.toISOString() } : null;
  }

  private now(): Date {
    const result = this.options.now?.() ?? new Date();
    if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new TypeError("Guest session clock must return a valid Date.");
    return new Date(result.getTime());
  }
}
