import type { D1DatabaseLike } from "../../storage/d1-types.js";

export const MAX_JSON_BODY_BYTES = 8 * 1024;
export const DEFAULT_SESSION_COOKIE_NAME = "bang_session";

export interface SiteApiEnvironment {
  DB: D1DatabaseLike;
  SESSION_COOKIE_NAME?: string;
  GUEST_SESSION_TTL_MS?: string | number;
}

export interface HttpServiceOptions {
  now?: () => Date;
  guestSessionTtlMs?: number;
  crypto?: Crypto;
  sessionCookieName?: string;
}

export class HttpBoundaryError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "HttpBoundaryError";
  }
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("Cache-Control", "no-store");
  resultHeaders.set("Content-Type", "application/json; charset=utf-8");
  resultHeaders.set("X-Content-Type-Options", "nosniff");
  resultHeaders.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers: resultHeaders });
}

export function emptyResponse(status: number, headers?: HeadersInit): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("Cache-Control", "no-store");
  resultHeaders.set("X-Content-Type-Options", "nosniff");
  resultHeaders.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status, headers: resultHeaders });
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === new URL(request.url).origin && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export async function readJsonRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpBoundaryError(415, "BAD_REQUEST");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw new HttpBoundaryError(413, "BAD_REQUEST");
  }
  if (!request.body) throw new HttpBoundaryError(400, "BAD_REQUEST");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new HttpBoundaryError(413, "BAD_REQUEST");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    throw new HttpBoundaryError(400, "BAD_REQUEST");
  }
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpBoundaryError(400, "BAD_REQUEST");
  }
}

export function configuredCookieName(env: SiteApiEnvironment, options: HttpServiceOptions = {}): string {
  const value = options.sessionCookieName ?? env.SESSION_COOKIE_NAME?.trim() ?? DEFAULT_SESSION_COOKIE_NAME;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) throw new TypeError("Session cookie name is invalid.");
  return value;
}

export function configuredGuestTtl(env: SiteApiEnvironment, options: HttpServiceOptions = {}): number | undefined {
  if (options.guestSessionTtlMs !== undefined) return options.guestSessionTtlMs;
  const raw = env.GUEST_SESSION_TTL_MS;
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return undefined;
  const text = String(raw).trim();
  if (!/^\d+$/u.test(text)) throw new TypeError("Guest session TTL must be a positive safe integer.");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Guest session TTL must be a positive safe integer.");
  return value;
}

export function sessionCredential(request: Request, cookieName: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  const matches: string[] = [];
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== cookieName) continue;
    try {
      matches.push(decodeURIComponent(item.slice(separator + 1).trim()));
    } catch {
      return undefined;
    }
  }
  return matches.length === 1 && matches[0]!.length > 0 ? matches[0] : undefined;
}

export function serializeSessionCookie(cookieName: string, credential: string, expiresAt: string, hasTtl: boolean): string {
  const parts = [
    `${cookieName}=${encodeURIComponent(credential)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (hasTtl) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  return parts.join("; ");
}

