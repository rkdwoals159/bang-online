import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDist = path.resolve(repositoryRoot, "apps", "site", "dist");
const outputDirectory = path.resolve(repositoryRoot, "dist");
const rootManifestPath = path.resolve(repositoryRoot, ".openai", "hosting.json");
const siteManifestPath = path.resolve(repositoryRoot, "apps", "site", ".openai", "hosting.json");

if (path.dirname(outputDirectory) !== repositoryRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to write Sites output outside the repository dist directory.");
}

const [rootManifestText, siteManifestText] = await Promise.all([
  readFile(rootManifestPath, "utf8"),
  readFile(siteManifestPath, "utf8"),
]);
const rootManifest = JSON.parse(rootManifestText);
const siteManifest = JSON.parse(siteManifestText);

if (!rootManifest || typeof rootManifest !== "object" || Array.isArray(rootManifest)) {
  throw new Error("Root .openai/hosting.json must contain an object.");
}
if (rootManifest.d1 !== "DB" || siteManifest.d1 !== rootManifest.d1) {
  throw new Error("Root and app-local manifests must declare the same logical D1 binding DB.");
}
if (rootManifest.r2 !== null || siteManifest.r2 !== null) {
  throw new Error("This Site build does not configure an R2 binding.");
}

const workerEntry = path.join(siteDist, "server", "index.js");
const clientDirectory = path.join(siteDist, "client");
await Promise.all([stat(workerEntry), stat(clientDirectory)]);

try {
  const existingOutput = await lstat(outputDirectory);
  if (existingOutput.isSymbolicLink()) {
    throw new Error("Refusing to replace a symlink at the repository dist path.");
  }
  if (!existingOutput.isDirectory()) {
    throw new Error("Repository dist output path exists but is not a directory.");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(siteDist, outputDirectory, { recursive: true, force: true });
await mkdir(path.join(outputDirectory, ".openai"), { recursive: true });
await writeFile(path.join(outputDirectory, ".openai", "hosting.json"), rootManifestText, "utf8");

const stagedWorker = path.join(outputDirectory, "server", "index.js");
const stagedManifest = JSON.parse(await readFile(path.join(outputDirectory, ".openai", "hosting.json"), "utf8"));
const stagedWorkerText = await readFile(stagedWorker, "utf8");
await Promise.all([
  stat(stagedWorker),
  stat(path.join(outputDirectory, "client", "favicon.svg")),
  stat(path.join(outputDirectory, "client", "assets", "cards", "playing", "01_bang.png")),
]);

if (stagedManifest.d1 !== "DB") {
  throw new Error("Staged Sites manifest lost its logical D1 binding.");
}
if (!/export\s*\{\s*[\w$]+\s+as\s+default\s*\}/.test(stagedWorkerText)) {
  throw new Error("Staged Worker entry does not export its fetch handler as the default module.");
}
if (Object.keys(stagedManifest).some((key) => /token|secret|password|credential|api[_-]?key/i.test(key))) {
  throw new Error("Staged Sites manifest must not include credentials.");
}

console.log("Sites build staged:");
console.log(`- Worker: ${path.relative(repositoryRoot, stagedWorker)}`);
console.log(`- Client: ${path.relative(repositoryRoot, path.join(outputDirectory, "client"))}`);
console.log(`- D1 binding: ${stagedManifest.d1}`);
