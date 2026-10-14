import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("public/assets", { recursive: true });
await build({
  entryPoints: ["web/app.js"],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "public/assets",
  entryNames: "[name]",
  chunkNames: "[name]-[hash]",
  minify: true,
  target: "es2022",
  legalComments: "eof",
  metafile: true,
}).then(async (result) => {
  if (
    Object.keys(result.metafile.inputs).some(
      (p) => p.startsWith("src/") || p.includes("fixtures"),
    )
  )
    throw new Error("Server or fixture code in browser bundle");
});
await copyFile("web/style.css", "public/assets/style.css");
await copyFile("web/index.html", "public/index.html");
console.info("Life RPG web assets built. No credentials or game data bundled.");
