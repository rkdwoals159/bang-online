import type { RandomSource } from "../../../../../packages/engine/src/random/shuffle.js";

export interface CryptoOptions {
  crypto?: Crypto;
}

function cryptoProvider(provider?: Crypto): Crypto {
  const value = provider ?? globalThis.crypto;
  if (!value?.getRandomValues || !value.subtle) throw new Error("Web Crypto is unavailable.");
  return value;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export function opaqueSecret(provider?: Crypto): string {
  return bytesToBase64Url(cryptoProvider(provider).getRandomValues(new Uint8Array(32)));
}

export function opaqueId(prefix: string, provider?: Crypto): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(prefix)) throw new TypeError("Opaque ID prefix is invalid.");
  return `${prefix}_${bytesToBase64Url(cryptoProvider(provider).getRandomValues(new Uint8Array(18)))}`;
}

export async function sha256Hex(value: string, provider?: Crypto): Promise<string> {
  const crypto = cryptoProvider(provider);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Worker-safe entropy source used only while initializing a new match. */
export function webCryptoRandomSource(provider?: Crypto): RandomSource {
  const crypto = cryptoProvider(provider);
  return {
    nextFloat: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      let value = 0;
      for (const byte of bytes) value = value * 256 + byte;
      return value / 0x1_0000_0000_0000;
    },
  };
}

