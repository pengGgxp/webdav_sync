import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await copyFile("main.js", "dist/main.js");
await copyFile("manifest.json", "dist/manifest.json");

console.log("Release assets written to dist/.");
