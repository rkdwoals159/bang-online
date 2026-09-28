import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly sessionCookieName: string;
  readonly webOrigin: string;
  readonly guestSessionTtlMs?: number;
  readonly roomRetentionMs?: number;
}

export interface PGliteDevConfig {
  readonly dataDir: string;
  readonly port: number;
}

export class ServerConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = "ServerConfigurationError";
    this.variable = variable;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_SESSION_COOKIE_NAME = "bang_session";
const DEFAULT_WEB_ORIGIN = "http://localhost:5173";
const DEFAULT_PGLITE_PORT = 5433;
const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function required(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new ServerConfigurationError(key, "is required.");
  return value;
}

function integer(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ServerConfigurationError(key, "must be a whole number.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ServerConfigurationError(key, `must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalDuration(environment: Environment, key: string): number | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ServerConfigurationError(key, "must be a positive whole number of milliseconds.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServerConfigurationError(key, "must be a positive whole number of milliseconds.");
  }
  return value;
}

function postgresUrl(environment: Environment): string {
  const value = required(environment, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServerConfigurationError("DATABASE_URL", "must be a valid PostgreSQL connection URL.");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname) {
    throw new ServerConfigurationError("DATABASE_URL", "must use postgres:// or postgresql:// and include a host.");
  }
  return value;
}

function webOrigin(environment: Environment): string {
  const value = environment.WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServerConfigurationError("WEB_ORIGIN", "must be an absolute HTTP or HTTPS origin.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== value || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ServerConfigurationError("WEB_ORIGIN", "must contain only an HTTP or HTTPS origin.");
  }
  return value;
}

/** Validate all startup settings before opening a database connection. */
export function readServerConfig(environment: Environment = process.env): ServerConfig {
  const sessionCookieName = environment.SESSION_COOKIE_NAME?.trim() || DEFAULT_SESSION_COOKIE_NAME;
  if (!COOKIE_TOKEN.test(sessionCookieName)) {
    throw new ServerConfigurationError("SESSION_COOKIE_NAME", "must be a valid cookie name.");
  }

  const guestSessionTtlMs = optionalDuration(environment, "GUEST_SESSION_TTL_MS");
  const roomRetentionMs = optionalDuration(environment, "ROOM_RETENTION_MS");
  return {
    databaseUrl: postgresUrl(environment),
    host: environment.HOST?.trim() || DEFAULT_HOST,
    port: integer(environment, "PORT", DEFAULT_PORT, 0, 65_535),
    sessionCookieName,
    webOrigin: webOrigin(environment),
    ...(guestSessionTtlMs === undefined ? {} : { guestSessionTtlMs }),
    ...(roomRetentionMs === undefined ? {} : { roomRetentionMs }),
  };
}

/** Resolve local-only PGlite Socket settings without changing the PostgreSQL startup contract. */
export function readPGliteDevConfig(environment: Environment = process.env): PGliteDevConfig {
  const configuredDataDir = environment.PGLITE_DATA_DIR;
  if (configuredDataDir !== undefined && configuredDataDir.trim() === "") {
    throw new ServerConfigurationError("PGLITE_DATA_DIR", "must not be empty when provided.");
  }

  return {
    dataDir: resolve(configuredDataDir?.trim() || join(homedir(), ".bang-online", "pglite")),
    port: integer(environment, "PGLITE_PORT", DEFAULT_PGLITE_PORT, 1, 65_535),
  };
}
