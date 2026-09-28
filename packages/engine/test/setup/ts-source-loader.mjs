import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Resolve emitted-style .js imports to their TypeScript source while tests run uncompiled. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    try {
      await access(fileURLToPath(sourceUrl));
      return nextResolve(sourceUrl.href, context);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return nextResolve(specifier, context);
}
