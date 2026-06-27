# WebDAV Snapshot Sync

WebDAV Snapshot Sync is a manual snapshot backup and restore plugin for Obsidian. It uploads full-vault zip snapshots to a user-configured WebDAV server and always creates a safety backup before restoring remote content.

## Overview

This plugin is intentionally simple. It does not perform incremental synchronization, file-level conflict resolution, automatic merging, or automatic direction decisions. The user chooses whether to upload local content, download a remote snapshot, restore a backup, or do nothing.

Before restoring any remote snapshot or backup, the plugin first packages the current local vault and uploads that package to the configured WebDAV server under `backups/before-download/`. Local files are only deleted after the backup succeeds and the selected remote zip has been downloaded and parsed.

## Features

- Configure WebDAV URL, username, password or token, remote root directory, device name, and device ID.
- Generate a device ID on first startup.
- Manually upload the current vault as a zip snapshot to `snapshots/`.
- Update `metadata/latest.json` and `metadata/index.json` after successful uploads.
- View remote status, remote snapshots, and remote backups in one panel.
- Restore a user-selected remote snapshot or backup.
- Always create and upload a local safety backup before restoring remote content.
- Split large snapshot archives into smaller WebDAV objects to avoid HTTP 413 upload limits.
- Preserve `ctime` and `mtime` when the Obsidian vault adapter supports these metadata fields.
- Ignore Git data, trash, workspace layout files, this plugin's own directory, large files, selected extensions, and custom glob-like rules.
- Automatically clean up old snapshots after snapshot uploads according to the configured retention count.

## Remote Layout

```text
webdav-sync-simple/
  snapshots/
    2026-06-05T12-30-00Z-device-a.zip
    2026-06-05T12-30-00Z-device-b.zip.parts.json
    2026-06-05T12-30-00Z-device-b.zip.parts/
      part-00001.bin
      part-00002.bin
  metadata/
    latest.json
    index.json
  backups/
    before-download/
      before-download-2026-06-05T14-00-00Z-device-a.zip
    manual/
      manual-2026-06-05T14-10-00Z-device-a.zip
```

## Safety Model

Restoring remote content is always a manual action. The plugin can show local and remote device information, but it does not decide which side is newer and does not automatically choose an overwrite direction.

When restoring a remote snapshot or backup, the plugin runs this sequence:

1. Package the current local vault.
2. Upload that package to `backups/before-download/`.
3. Download and parse the selected remote zip.
4. Delete local files that are inside the sync scope.
5. Write the remote zip contents into the local vault.

If downloading or parsing the remote zip fails, local content is not deleted.

## Large Uploads

Some WebDAV servers or reverse proxies reject large single-request uploads with HTTP 413. To avoid that, the plugin can split a large zip archive into smaller part files. The setting is named "上传分片大小" in the plugin settings. The default is 20 MB, and setting it to `0` disables chunked uploads.

Chunked snapshots still behave like normal snapshots in the plugin. The plugin records a small `*.zip.parts.json` manifest and restores by downloading all parts and joining them in order before reading the zip.

## Privacy

The plugin only connects to the WebDAV endpoint configured by the user. It reads local vault files, packages them into zip archives, and uploads those archives to the configured WebDAV storage.

By default, Obsidian's configuration folder is excluded from snapshots. If configuration backup is enabled, Obsidian settings and third-party plugin files may be included. This plugin's own directory is still ignored to avoid uploading WebDAV credentials and to avoid overwriting itself while running.

Passwords or tokens are stored in Obsidian's plugin settings data. Do not enable configuration backup unless you understand which private configuration files may be included.

## Development

```bash
npm install
npm run build
```

For manual installation, place the generated `main.js` and `manifest.json` into:

```text
<your-vault>/.obsidian/plugins/webdav-snapshot-sync/
```

## Chinese

WebDAV 快照同步是一个用于 Obsidian 的手动快照备份和恢复插件。

它不做增量同步，不做冲突合并，不自动判断覆盖方向。插件只负责把当前库打包成快照，上传或下载快照包，记录元数据，并在恢复远端内容前强制上传本地安全备份。

## 功能

- 配置 WebDAV 地址、用户名、密码或令牌、远端根目录、设备名称和设备 ID。
- 首次启动时自动生成设备 ID。
- 手动把当前库打包为 zip 快照并上传到 `snapshots/`。
- 大快照包会按设置分片上传，以绕过部分 WebDAV 服务的 HTTP 413 限制。
- 上传成功后更新 `metadata/latest.json` 和 `metadata/index.json`。
- 在一个远端状态面板里查看快照、备份和同步判断。
- 手动选择某个远端快照或备份进行恢复。
- 恢复远端内容前，始终先上传本地 `before-download` 备份。
- 写入远端快照内容前，会先删除本地纳入同步范围的文件。
- 在 Obsidian 适配器支持时，恢复文件的 `ctime` 和 `mtime`。
- 支持忽略 `.git`、`.trash`、工作区布局文件、本插件目录、大文件、指定扩展名和自定义匹配规则。
- 上传快照后会按设置的保留数量自动清理旧快照。

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

## 安全模型

恢复远端内容必须由用户手动选择。插件会显示本地和远端设备信息，但不会判断哪一端更新，也不会自动决定上传或下载。

恢复远端快照或备份时，插件会按下面的顺序执行：

1. 打包当前本地库。
2. 上传这个包到 `backups/before-download/`。
3. 下载并解析用户选择的远端 zip。
4. 删除本地纳入同步范围的文件。
5. 把远端 zip 内容写入本地库。

如果远端 zip 下载失败或解析失败，本地内容不会被删除。

## 隐私和凭据

插件只会连接用户自己配置的 WebDAV 地址。它会读取本地库文件，把这些文件压缩成 zip 包，并上传到用户配置的 WebDAV 存储。

默认情况下，`.obsidian/` 不会被包含在快照中。如果开启“包含 .obsidian 配置”，大部分 Obsidian 设置和第三方插件文件都可能被包含。本插件自己的目录仍会默认忽略，以避免把 WebDAV 密码或令牌打包上传，也避免在插件运行时覆盖自身文件。

密码或令牌会保存在 Obsidian 管理的插件设置数据中。除非你清楚哪些私密配置可能进入快照，否则不要轻易开启配置备份。

## 开发

```bash
npm install
npm run build
```

手动安装时，把生成的 `main.js` 和 `manifest.json` 放到：

```text
<你的库>/.obsidian/plugins/webdav-snapshot-sync/
```
