# WebDAV Snapshot Sync

一个极简 Obsidian WebDAV 快照同步插件：不做增量同步、不做冲突合并、不自动判断覆盖方向，只负责把当前 vault 打包上传、记录元数据，并在恢复远端包之前强制上传本地安全备份。

## 功能

- 设置 WebDAV 地址、用户名、密码/令牌、远端根目录、设备名称、设备 ID。
- 首次启动自动生成设备 ID，上传时记录设备 ID、设备名称、时间戳、插件版本和 vault 名称。
- 手动上传当前 vault 到 `snapshots/`，并更新 `metadata/latest.json` 和 `metadata/index.json`。
- 查看远端快照和远端备份，用户手动选择一个包恢复。
- 恢复任何远端包之前，都会先把当前本地 vault 打包上传到 `backups/before-download/`。
- 支持手动“只备份本地”。
- 支持默认忽略规则、自定义 glob、指定扩展名和大文件忽略。
- 支持按设置的保留数量手动清理旧快照。
- 快照包内包含文件元数据清单，恢复时会写回 `ctime` 和 `mtime`。

## 远端结构

```text
webdav-sync-simple/
  snapshots/
    2026-06-05T12-30-00Z-device-a.zip
  metadata/
    latest.json
    index.json
  backups/
    before-download/
      before-download-2026-06-05T14-00-00Z-device-a.zip
    manual/
      manual-2026-06-05T14-10-00Z-device-a.zip
```

## 开发

```bash
npm install
npm run build
```

构建后，把 `main.js`、`manifest.json` 复制到 vault 的 `.obsidian/plugins/webdav-snapshot-sync/` 下启用。

## 安全说明

恢复会先把本地 vault 打包并上传到 `backups/before-download/`，再完整下载并解析远端 zip。只有远端包下载和解析成功后，插件才会删除本地纳入同步范围的文件，并写入远端包内容。默认忽略项、本插件目录和当前忽略规则排除的内容会被保留。
