import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(pluginRoot, "dist");
const outputFiles = [
  join(outputDirectory, "gemini-web-cli.mjs"),
  join(outputDirectory, "mcp-server.mjs"),
];

await mkdir(outputDirectory, { recursive: true });

const result = await build({
  absWorkingDir: pluginRoot,
  bundle: true,
  entryNames: "[name]",
  entryPoints: {
    "gemini-web-cli": "scripts/cli.mjs",
    "mcp-server": "scripts/mcp-server.mjs",
  },
  format: "esm",
  legalComments: "external",
  metafile: true,
  outExtension: { ".js": ".mjs" },
  outdir: outputDirectory,
  platform: "node",
  target: "node22",
});

for (const outputFile of outputFiles) await chmod(outputFile, 0o755);

function packageRootForInput(input) {
  const normalized = input.split("/");
  const marker = normalized.lastIndexOf("node_modules");
  if (marker < 0 || normalized.length <= marker + 1) return null;
  const nameParts = normalized[marker + 1].startsWith("@")
    ? normalized.slice(marker + 1, marker + 3)
    : normalized.slice(marker + 1, marker + 2);
  return join(pluginRoot, "node_modules", ...nameParts);
}

const packageRoots = new Set(
  Object.keys(result.metafile.inputs)
    .map(packageRootForInput)
    .filter(Boolean),
);
const notices = [];

for (const packageRoot of [...packageRoots].sort()) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const licenseCandidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];
  let licenseText = null;
  for (const candidate of licenseCandidates) {
    try {
      licenseText = await readFile(join(packageRoot, candidate), "utf8");
      break;
    } catch {}
  }
  notices.push([
    "=".repeat(80),
    `${manifest.name}@${manifest.version}`,
    `Declared license: ${manifest.license ?? "Unknown"}`,
    `Bundled from: ${relative(pluginRoot, packageRoot).split(sep).join("/")}`,
    "=".repeat(80),
    licenseText?.trim() ?? "No standalone license file was included in the installed package.",
  ].join("\n"));
}

await writeFile(
  join(outputDirectory, "THIRD_PARTY_LICENSES.txt"),
  `${notices.join("\n\n")}\n`,
  "utf8",
);
