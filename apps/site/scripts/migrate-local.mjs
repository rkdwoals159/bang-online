import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicitly local CLI preparation; this is never imported by the Worker.
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(siteRoot, "../..");
const directory = path.join(repoRoot, "drizzle");
const files = (await readdir(directory)).filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file)).sort();
if (!files.length) throw new Error("No generated migration files found.");
const sql = (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8"))))
  .join("\n")
  .replace(/--> statement-breakpoint\s*/g, "")
  .replace(/\b(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX))\s+(?!IF\s+NOT\s+EXISTS\b)/gi, "$1 IF NOT EXISTS ");
const output = path.join(siteRoot, ".wrangler", "local-schema.sql");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, sql);
const result = spawnSync(process.execPath, [
  "--import", new URL("./sites-env.mjs", import.meta.url).href,
  fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
  "d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json",
  "--persist-to", ".wrangler/state", "--file", output,
], { cwd: siteRoot, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
