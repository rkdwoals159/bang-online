import { build } from "../apps/site/node_modules/esbuild/lib/main.js";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist/selfhost");
await mkdir(join(output, "server/storage"), { recursive: true });
execFileSync(process.execPath, [join(root, "apps/web/node_modules/vite/bin/vite.js"), "build"], {
  cwd: join(root, "apps/web"), stdio: "inherit",
});
await build({
  entryPoints: [join(root, "apps/server/src/main.ts")],
  outfile: join(output, "server/storage/main.mjs"),
  bundle: true, platform: "node", target: "node22", format: "esm",
  external: ["pg", "socket.io", "@electric-sql/pglite", "@electric-sql/pglite-socket"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await cp(join(root, "apps/server/migrations"), join(output, "migrations"), { recursive: true });
await cp(join(root, "apps/web/dist"), join(output, "web"), { recursive: true });
await writeFile(join(output, "package.json"), JSON.stringify({
  name: "bang-online-selfhost", private: true, type: "module",
  engines: { node: ">=22.12.0" },
  scripts: { start: "node server/storage/main.mjs" },
  dependencies: { pg: "8.16.0", "socket.io": "4.8.1" },
}, null, 2) + "\n");
await cp(join(root, "deploy/selfhost/package-lock.json"), join(output, "package-lock.json"));
console.log(`Self-host bundle: ${output}`);
