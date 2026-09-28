/** Minimal Node built-in declarations used by the storage migration loader. */
declare module "node:crypto" {
  interface Hash {
    update(data: string, encoding?: string): this;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: string): Hash;
}

declare module "node:fs/promises" {
  export function readFile(path: URL, encoding: "utf8"): Promise<string>;
}
