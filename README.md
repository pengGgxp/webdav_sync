# WebDAV Snapshot Sync

WebDAV Snapshot Sync is a simple Obsidian plugin for manual snapshot backup and restore over WebDAV.

It does not do incremental sync, automatic conflict resolution, automatic merge, or automatic direction decisions. The plugin only packages the current vault, uploads or downloads snapshot archives, records metadata, and creates a safety backup before restoring remote content.

## Features

- Configure WebDAV URL, username, password or token, remote root folder, device name, and device ID.
- Generate a device ID on first startup.
- Upload the current vault as a zip snapshot to `snapshots/`.
- Update `metadata/latest.json` and `metadata/index.json` after upload.
- Browse remote snapshots and backups manually.
- Restore a selected remote snapshot or backup.
- Always upload a local `before-download` backup before restoring remote content.
- Clear local syncable files before writing restored snapshot files.
- Preserve file `ctime` and `mtime` where supported by Obsidian's adapter.
- Ignore `.git`, `.trash`, workspace files, this plugin's own folder, large files, selected extensions, and custom glob rules.
- Manually clean up old snapshots according to the configured retention count.

## Remote Layout

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

## Safety Model

Restoring remote content is intentionally manual. The plugin shows local and remote device information, but it does not decide which side is newer or safer.

When restoring a remote snapshot or backup, the plugin follows this order:

1. Package the current local vault.
2. Upload that package to `backups/before-download/`.
3. Download and parse the selected remote zip.
4. Delete local files that are included in the sync scope.
5. Write the remote zip contents into the vault.

Local content is not deleted if the remote zip cannot be downloaded or parsed.

## Privacy And Credentials

This plugin connects only to the WebDAV endpoint configured by the user. It reads local vault files, compresses them into zip archives, and uploads those archives to the configured WebDAV storage.

By default, `.obsidian/` is not included in snapshots. If the setting to include Obsidian configuration is enabled, most Obsidian settings and third-party plugin files can be included. This plugin's own folder is still ignored by default to avoid uploading its WebDAV credentials and to avoid overwriting the plugin while it is running.

Passwords or tokens are stored in the plugin settings data managed by Obsidian. Do not enable configuration backup unless you understand what private configuration may be included in your snapshots.

## Development

```bash
npm install
npm run build
```

For local manual installation, copy the generated `main.js` and `manifest.json` into:

```text
<your-vault>/.obsidian/plugins/webdav-snapshot-sync/
```

## Community Plugin Release

For an Obsidian community plugin release, create a GitHub release whose tag exactly matches `manifest.json`'s `version`, for example `0.1.0`.

Build the release assets:

```bash
npm run package
```

Attach these files to the release:

- `dist/main.js`
- `dist/manifest.json`

`main.js` is a generated build artifact and is intentionally ignored in the repository source tree.
