import { access, copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await copyFile("main.js", "dist/main.js");
await copyFile("manifest.json", "dist/manifest.json");

try {
  await access("styles.css");
  await copyFile("styles.css", "dist/styles.css");
} catch {
  // Optional release asset.
}

console.log("发布附件已生成到 dist/。");
