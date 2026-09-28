declare module "node:crypto" {
  export function randomBytes(size: number): {
    toString(encoding: "base64url"): string;
  };
}
