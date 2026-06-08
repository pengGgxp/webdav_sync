import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await copyFile("main.js", "dist/main.js");
await copyFile("manifest.json", "dist/manifest.json");

console.log("发布附件已生成到 dist/。");
