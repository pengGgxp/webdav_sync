# WebDAV 快照同步

WebDAV Snapshot Sync is a manual snapshot backup and restore plugin for Obsidian. It uploads full-vault zip snapshots to a user-configured WebDAV server and always creates a safety backup before restoring remote content.

WebDAV 快照同步是一个用于 Obsidian 的手动快照备份和恢复插件。

它不做增量同步，不做冲突合并，不自动判断覆盖方向。插件只负责把当前库打包成快照，上传或下载快照包，记录元数据，并在恢复远端内容前强制上传本地安全备份。

## 功能

- 配置 WebDAV 地址、用户名、密码或令牌、远端根目录、设备名称和设备 ID。
- 首次启动时自动生成设备 ID。
- 手动把当前库打包为 zip 快照并上传到 `snapshots/`。
- 上传成功后更新 `metadata/latest.json` 和 `metadata/index.json`。
- 手动查看远端快照和远端备份。
- 手动选择某个远端快照或备份进行恢复。
- 恢复远端内容前，始终先上传本地 `before-download` 备份。
- 写入远端快照内容前，会先删除本地纳入同步范围的文件。
- 在 Obsidian 适配器支持时，恢复文件的 `ctime` 和 `mtime`。
- 支持忽略 `.git`、`.trash`、工作区布局文件、本插件目录、大文件、指定扩展名和自定义匹配规则。
- 支持按设置的保留数量手动清理旧快照。

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
