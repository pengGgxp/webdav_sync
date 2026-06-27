import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { DataWriteOptions } from "obsidian";
import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  RequestUrlParam,
  Setting,
  normalizePath
} from "obsidian";

const DEFAULT_REMOTE_ROOT = "webdav-sync-simple";
const METADATA_DIR = "metadata";
const SNAPSHOTS_DIR = "snapshots";
const BACKUPS_DIR = "backups";
const BEFORE_DOWNLOAD_DIR = "backups/before-download";
const MANUAL_BACKUP_DIR = "backups/manual";
const ARCHIVE_METADATA_PATH = "__webdav_snapshot_sync_metadata__.json";
const DEFAULT_CHUNK_SIZE_MB = 20;

const DEFAULT_IGNORE_RULES = [
  ".git/**",
  ".trash/**"
];

type PackageKind = "snapshot" | "backup";
type BackupReason = "before-download" | "manual";
type RemoteStateSection = "overview" | "snapshot" | "backup" | "sync";

interface SnapshotSyncSettings {
  webdavUrl: string;
  username: string;
  password: string;
  remoteRoot: string;
  deviceId: string;
  deviceName: string;
  customIgnoreRules: string;
  includeObsidianConfig: boolean;
  retentionCount: number;
  chunkSizeMb: number;
  maxFileSizeMb: number;
  ignoredExtensions: string;
  lastOperationAt: string;
  lastOperationType: string;
}

interface RemotePackageMetadata {
  id: string;
  kind: PackageKind;
  backupReason?: BackupReason;
  filename: string;
  path: string;
  timestamp: string;
  deviceId: string;
  deviceName: string;
  pluginVersion: string;
  vaultName: string;
  fileCount: number;
  sizeBytes: number;
  storage?: "single" | "chunked";
  manifestPath?: string;
  chunkSizeBytes?: number;
  chunks?: RemotePackageChunk[];
}

interface RemotePackageChunk {
  index: number;
  path: string;
  sizeBytes: number;
}

interface RemoteChunkManifest {
  version: 1;
  createdAt: string;
  metadata: RemotePackageMetadata;
  chunks: RemotePackageChunk[];
}

interface RemoteIndex {
  version: 1;
  updatedAt: string;
  snapshots: RemotePackageMetadata[];
  backups: RemotePackageMetadata[];
}

interface LatestMetadata {
  version: 1;
  updatedAt: string;
  latest: RemotePackageMetadata | null;
}

interface RemoteState {
  snapshots: RemotePackageMetadata[];
  backups: RemotePackageMetadata[];
  latestSnapshot: RemotePackageMetadata | null;
}

interface RemoteEntry {
  filename: string;
  path: string;
  sizeBytes: number;
  lastModified?: string;
}

interface PackageBuildResult {
  bytes: ArrayBuffer;
  fileCount: number;
}

interface ZipRestoreEntry {
  path: string;
  data: ArrayBuffer;
  ctime?: number;
  mtime?: number;
}

interface ArchiveFileMetadata {
  ctime?: number;
  mtime?: number;
  size?: number;
}

interface ArchiveMetadata {
  version: 1;
  createdAt: string;
  pluginVersion: string;
  vaultName: string;
  files: Record<string, ArchiveFileMetadata>;
}

const DEFAULT_SETTINGS: SnapshotSyncSettings = {
  webdavUrl: "",
  username: "",
  password: "",
  remoteRoot: DEFAULT_REMOTE_ROOT,
  deviceId: "",
  deviceName: "",
  customIgnoreRules: "",
  includeObsidianConfig: false,
  retentionCount: 10,
  chunkSizeMb: DEFAULT_CHUNK_SIZE_MB,
  maxFileSizeMb: 0,
  ignoredExtensions: "",
  lastOperationAt: "",
  lastOperationType: ""
};

export default class WebdavSnapshotSyncPlugin extends Plugin {
  settings: SnapshotSyncSettings;

  async onload() {
    await this.loadSettings();
    await this.ensureDeviceIdentity();

    this.addRibbonIcon("upload-cloud", "上传 WebDAV 快照", () => {
      void this.runAction(() => this.uploadCurrentSnapshot());
    });

    this.addCommand({
      id: "upload-current-snapshot",
      name: "上传当前工作区快照",
      callback: () => void this.runAction(() => this.uploadCurrentSnapshot())
    });

    this.addCommand({
      id: "view-remote-state",
      name: "查看远端状态",
      callback: () => void this.runAction(() => this.openRemoteStateModal())
    });

    this.addCommand({
      id: "backup-local-vault",
      name: "只备份本地工作区",
      callback: () => void this.runAction(() => this.createAndUploadBackup("manual"))
    });

    this.addSettingTab(new SnapshotSyncSettingTab(this.app, this));
  }

  onunload() {
    // Obsidian disposes registered commands and setting tabs automatically.
  }

  async runAction(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      new Notice(errorMessage(error), 12000);
    }
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<SnapshotSyncSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureDeviceIdentity() {
    let changed = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = createDeviceId();
      changed = true;
    }

    if (!this.settings.deviceName) {
      this.settings.deviceName = `设备 ${this.settings.deviceId.slice(0, 8)}`;
      changed = true;
    }

    if (changed) {
      await this.saveSettings();
    }
  }

  async testConnection() {
    const client = this.createClient();
    await client.ensureBaseLayout();
    await client.propfind("", 0);
    new Notice("WebDAV 连接成功");
  }

  async uploadCurrentSnapshot() {
    const client = this.createClient();
    await client.ensureBaseLayout();

    const started = new Date();
    const filename = `${timestampForFile(started)}-${safeName(this.settings.deviceId)}.zip`;
    const remotePath = `${SNAPSHOTS_DIR}/${filename}`;

    new Notice("正在打包当前库...");
    const packageResult = await this.buildZipPackage();

    const metadata = this.createPackageMetadata({
      kind: "snapshot",
      filename,
      remotePath,
      timestamp: started.toISOString(),
      fileCount: packageResult.fileCount,
      sizeBytes: packageResult.bytes.byteLength
    });

    new Notice("正在上传快照...");
    await this.uploadPackageBytes(client, metadata, packageResult.bytes);
    await this.updateRemoteMetadata(client, metadata);
    await this.markOperation("upload");

    let cleanupNote = "自动清理: 无需处理";
    try {
      const cleanupResult = await this.cleanupOldSnapshots(client);
      if (cleanupResult.deletedCount > 0) {
        cleanupNote = `自动清理: 已清理 ${cleanupResult.deletedCount} 个旧快照`;
        if (cleanupResult.failedCount > 0) {
          cleanupNote += `，${cleanupResult.failedCount} 个删除失败`;
        }
      } else if (cleanupResult.failedCount > 0) {
        cleanupNote = `自动清理: 删除失败 ${cleanupResult.failedCount} 个`;
      } else {
        cleanupNote = "自动清理: 无需处理";
      }
    } catch (error) {
      cleanupNote = `自动清理: 失败（${errorMessage(error)}）`;
    }

    new Notice(
      [
        "快照上传成功",
        `时间: ${formatDateTime(metadata.timestamp)}`,
        `设备: ${metadata.deviceId}`,
        `文件: ${metadata.fileCount}`,
        `大小: ${formatBytes(metadata.sizeBytes)}`,
        cleanupNote
      ].join("\n"),
      10000
    );
  }

  async createAndUploadBackup(reason: BackupReason): Promise<RemotePackageMetadata> {
    const client = this.createClient();
    await client.ensureBaseLayout();

    const started = new Date();
    const prefix = reason === "before-download" ? "before-download" : "manual";
    const folder = reason === "before-download" ? BEFORE_DOWNLOAD_DIR : MANUAL_BACKUP_DIR;
    const filename = `${prefix}-${timestampForFile(started)}-${safeName(this.settings.deviceId)}.zip`;
    const remotePath = `${folder}/${filename}`;

    new Notice(reason === "before-download" ? "恢复前正在备份本地库..." : "正在备份本地库...");
    const packageResult = await this.buildZipPackage();
    const metadata = this.createPackageMetadata({
      kind: "backup",
      backupReason: reason,
      filename,
      remotePath,
      timestamp: started.toISOString(),
      fileCount: packageResult.fileCount,
      sizeBytes: packageResult.bytes.byteLength
    });

    await this.uploadPackageBytes(client, metadata, packageResult.bytes);
    await this.updateRemoteMetadata(client, metadata);
    await this.markOperation("backup");

    new Notice(
      [
        reason === "before-download" ? "恢复前备份上传成功" : "本地备份上传成功",
        `时间: ${formatDateTime(metadata.timestamp)}`,
        `设备: ${metadata.deviceId}`,
        `文件: ${metadata.fileCount}`,
        `大小: ${formatBytes(metadata.sizeBytes)}`
      ].join("\n"),
      10000
    );

    return metadata;
  }

  async restoreRemotePackage(remotePackage: RemotePackageMetadata) {
    const client = this.createClient();
    await client.ensureBaseLayout();

    await this.createAndUploadBackup("before-download");

    new Notice("正在下载远端包...");
    const bytes = await this.downloadPackageBytes(client, remotePackage);

    new Notice("正在解析远端包...");
    const entries = await this.readRestoreEntries(bytes);
    if (entries.length === 0) {
      throw new Error("远端包为空，未执行恢复。");
    }

    new Notice("正在删除本地可同步文件...");
    await this.clearLocalVaultForRestore();

    new Notice(`正在恢复 ${entries.length} 个文件...`);
    await this.writeRestoreEntries(entries);
    await this.markOperation(remotePackage.kind === "backup" ? "restore-backup" : "download");

    new Notice(
      [
        "恢复完成",
        `来源: ${remotePackage.filename}`,
        `设备: ${remotePackage.deviceId || "未知"}`,
        `文件: ${entries.length}`
      ].join("\n"),
      10000
    );
  }

  async getLatestRemoteSnapshot(state?: RemoteState): Promise<RemotePackageMetadata | null> {
    if (state) {
      return state.latestSnapshot;
    }

    const remoteState = await this.refreshRemoteState();
    return remoteState.latestSnapshot;
  }

  async refreshRemoteState(client?: WebdavClient): Promise<RemoteState> {
    const activeClient = client ?? this.createClient();
    const [index, latest] = await Promise.all([
      activeClient.getIndex(),
      activeClient.getJson<LatestMetadata>(`${METADATA_DIR}/latest.json`)
    ]);

    const [snapshots, backups] = await Promise.all([
      this.loadRemotePackagesFromIndex(activeClient, "snapshot", index.snapshots),
      this.loadRemotePackagesFromIndex(activeClient, "backup", index.backups)
    ]);

    const latestSnapshot = latest?.latest ? normalizeRemotePackageMetadata(latest.latest) : snapshots[0] ?? null;

    return {
      snapshots: latestSnapshot ? sortPackages(upsertPackage(snapshots, latestSnapshot)) : sortPackages(snapshots),
      backups: sortPackages(backups),
      latestSnapshot
    };
  }

  async refreshRemotePackages(kind: PackageKind, state?: RemoteState): Promise<RemotePackageMetadata[]> {
    const currentState = state ?? (await this.refreshRemoteState());
    return kind === "snapshot" ? currentState.snapshots : currentState.backups;
  }

  async listRemotePackages(kind: PackageKind, state?: RemoteState): Promise<RemotePackageMetadata[]> {
    return this.refreshRemotePackages(kind, state);
  }

  async resolveRemotePackage(
    kind: PackageKind,
    remotePath: string,
    state?: RemoteState
  ): Promise<RemotePackageMetadata | null> {
    const packages = await this.refreshRemotePackages(kind, state);
    return packages.find((item) => item.path === remotePath) ?? null;
  }

  async loadRemotePackagesFromIndex(
    client: WebdavClient,
    kind: PackageKind,
    packages: RemotePackageMetadata[]
  ): Promise<RemotePackageMetadata[]> {
    const hydrated = await this.hydratePackageSizes(client, packages);
    return hydrated.length > 0 ? hydrated : await this.fallbackListPackages(client, kind);
  }

  async cleanupOldSnapshots(client?: WebdavClient): Promise<{ deletedCount: number; failedCount: number; keptCount: number }> {
    const activeClient = client ?? this.createClient();
    await activeClient.ensureBaseLayout();

    const state = await this.refreshRemoteState(activeClient);
    const keepCount = Math.max(1, this.settings.retentionCount || 1);
    const sorted = sortPackages(state.snapshots);

    if (sorted.length === 0) {
      return { deletedCount: 0, failedCount: 0, keptCount: 0 };
    }

    const toDelete = sorted.slice(keepCount);
    if (toDelete.length === 0) {
      return { deletedCount: 0, failedCount: 0, keptCount: sorted.length };
    }

    const failed: RemotePackageMetadata[] = [];
    let deletedCount = 0;

    for (const item of toDelete) {
      try {
        await this.deleteRemotePackage(activeClient, item);
        deletedCount += 1;
      } catch {
        failed.push(item);
      }
    }

    const kept = sorted.slice(0, keepCount);
    const nextSnapshots = sortPackages([...kept, ...failed]);
    const updatedAt = new Date().toISOString();
    const index = await activeClient.getIndex();
    index.snapshots = nextSnapshots;
    index.updatedAt = updatedAt;
    await activeClient.putJson(`${METADATA_DIR}/index.json`, index);
    await activeClient.putJson(`${METADATA_DIR}/latest.json`, {
      version: 1,
      updatedAt,
      latest: index.snapshots[0] ?? null
    } satisfies LatestMetadata);

    return {
      deletedCount,
      failedCount: failed.length,
      keptCount: index.snapshots.length
    };
  }

  async openRemoteStateModal(section: RemoteStateSection = "overview") {
    new RemoteStateModal(this.app, this, section).open();
  }

  createClient(): WebdavClient {
    if (!this.settings.webdavUrl.trim()) {
      throw new Error("请先填写 WebDAV 地址。");
    }

    return new WebdavClient({
      baseUrl: this.settings.webdavUrl,
      username: this.settings.username,
      password: this.settings.password,
      root: this.settings.remoteRoot || DEFAULT_REMOTE_ROOT
    });
  }

  createPackageMetadata(input: {
    kind: PackageKind;
    backupReason?: BackupReason;
    filename: string;
    remotePath: string;
    timestamp: string;
    fileCount: number;
    sizeBytes: number;
  }): RemotePackageMetadata {
    const id = `${input.kind}:${input.remotePath}`;
    return {
      id,
      kind: input.kind,
      backupReason: input.backupReason,
      filename: input.filename,
      path: input.remotePath,
      timestamp: input.timestamp,
      deviceId: this.settings.deviceId,
      deviceName: this.settings.deviceName,
      pluginVersion: this.manifest.version,
      vaultName: this.app.vault.getName(),
      fileCount: input.fileCount,
      sizeBytes: input.sizeBytes
    };
  }

  async uploadPackageBytes(client: WebdavClient, metadata: RemotePackageMetadata, bytes: ArrayBuffer) {
    const chunkSizeBytes = this.uploadChunkSizeBytes();
    const shouldChunk = chunkSizeBytes > 0 && bytes.byteLength > chunkSizeBytes;

    if (!shouldChunk) {
      metadata.storage = "single";
      await client.putBytes(metadata.path, bytes, "application/zip");
      return;
    }

    const chunkFolder = `${metadata.path}.parts`;
    const manifestPath = `${metadata.path}.parts.json`;
    const chunks: RemotePackageChunk[] = [];
    const totalChunks = Math.ceil(bytes.byteLength / chunkSizeBytes);

    await client.ensureDir(chunkFolder);
    const source = new Uint8Array(bytes);

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSizeBytes;
      const end = Math.min(start + chunkSizeBytes, source.byteLength);
      const chunkBytes = toArrayBuffer(source.slice(start, end));
      const chunkPath = `${chunkFolder}/part-${String(index + 1).padStart(5, "0")}.bin`;
      new Notice(`正在上传分片 ${index + 1}/${totalChunks}...`);
      await client.putBytes(chunkPath, chunkBytes, "application/octet-stream");
      chunks.push({
        index,
        path: chunkPath,
        sizeBytes: chunkBytes.byteLength
      });
    }

    metadata.storage = "chunked";
    metadata.manifestPath = manifestPath;
    metadata.chunkSizeBytes = chunkSizeBytes;
    metadata.chunks = chunks;

    await client.putJson(manifestPath, {
      version: 1,
      createdAt: new Date().toISOString(),
      metadata,
      chunks
    } satisfies RemoteChunkManifest);
  }

  async downloadPackageBytes(client: WebdavClient, remotePackage: RemotePackageMetadata): Promise<ArrayBuffer> {
    if (remotePackage.storage !== "chunked") {
      return client.getBytes(remotePackage.path);
    }

    const manifestPath = remotePackage.manifestPath || `${remotePackage.path}.parts.json`;
    const manifest = await client.getJson<RemoteChunkManifest>(manifestPath);
    const chunks = manifest?.chunks ?? remotePackage.chunks ?? [];
    if (chunks.length === 0) {
      throw new Error(`远端分片清单为空: ${manifestPath}`);
    }

    const ordered = [...chunks].sort((a, b) => a.index - b.index);
    const buffers: Uint8Array[] = [];
    let totalBytes = 0;

    for (const chunk of ordered) {
      const bytes = await client.getBytes(chunk.path);
      const chunkBytes = new Uint8Array(bytes);
      buffers.push(chunkBytes);
      totalBytes += chunkBytes.byteLength;
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const buffer of buffers) {
      merged.set(buffer, offset);
      offset += buffer.byteLength;
    }

    return merged.buffer;
  }

  async deleteRemotePackage(client: WebdavClient, remotePackage: RemotePackageMetadata) {
    if (remotePackage.storage === "chunked") {
      for (const chunk of remotePackage.chunks ?? []) {
        await client.delete(chunk.path);
      }
      await client.delete(remotePackage.manifestPath || `${remotePackage.path}.parts.json`);
      await client.delete(`${remotePackage.path}.parts`);
      return;
    }

    await client.delete(remotePackage.path);
  }

  uploadChunkSizeBytes(): number {
    const chunkSizeMb = Number.isFinite(this.settings.chunkSizeMb) ? this.settings.chunkSizeMb : DEFAULT_CHUNK_SIZE_MB;
    return chunkSizeMb > 0 ? Math.floor(chunkSizeMb * 1024 * 1024) : 0;
  }

  async updateRemoteMetadata(client: WebdavClient, metadata: RemotePackageMetadata) {
    const index = await client.getIndex();

    if (metadata.kind === "snapshot") {
      index.snapshots = upsertPackage(index.snapshots, metadata);
      index.snapshots = sortPackages(index.snapshots);
      await client.putJson(`${METADATA_DIR}/latest.json`, {
        version: 1,
        updatedAt: new Date().toISOString(),
        latest: index.snapshots[0] ?? metadata
      } satisfies LatestMetadata);
    } else {
      index.backups = upsertPackage(index.backups, metadata);
      index.backups = sortPackages(index.backups);
    }

    index.updatedAt = new Date().toISOString();
    await client.putJson(`${METADATA_DIR}/index.json`, index);
  }

  async markOperation(operation: string) {
    this.settings.lastOperationAt = new Date().toISOString();
    this.settings.lastOperationType = operation;
    await this.saveSettings();
  }

  async buildZipPackage(): Promise<PackageBuildResult> {
    const zipEntries: Zippable = {};
    const files = await this.collectVaultFiles();
    const archiveMetadata: ArchiveMetadata = {
      version: 1,
      createdAt: new Date().toISOString(),
      pluginVersion: this.manifest.version,
      vaultName: this.app.vault.getName(),
      files: {}
    };

    let fileCount = 0;
    for (const filePath of files) {
      const data = await this.app.vault.adapter.readBinary(filePath);
      const stat = await this.app.vault.adapter.stat(filePath);
      const mtime = validTimestamp(stat?.mtime) ? stat.mtime : Date.now();

      zipEntries[filePath] = [new Uint8Array(data), { level: 6, mtime: new Date(mtime) }];
      archiveMetadata.files[filePath] = {
        ctime: validTimestamp(stat?.ctime) ? stat.ctime : undefined,
        mtime,
        size: stat?.size ?? data.byteLength
      };
      fileCount += 1;
    }

    zipEntries[ARCHIVE_METADATA_PATH] = [strToU8(JSON.stringify(archiveMetadata, null, 2)), { level: 6, mtime: new Date() }];
    const zipped: Uint8Array = zipSync(zipEntries, { level: 6 });

    return {
      bytes: toArrayBuffer(zipped),
      fileCount
    };
  }

  async collectVaultFiles(): Promise<string[]> {
    const files: string[] = [];
    const ignoredExtensions = parseExtensionList(this.settings.ignoredExtensions);

    const walk = async (folder: string) => {
      const listed = await this.app.vault.adapter.list(folder);

      for (const filePath of listed.files) {
        const normalized = normalizePath(filePath);
        const stat = await this.app.vault.adapter.stat(normalized);

        if (this.shouldIgnorePath(normalized, stat?.size ?? 0, ignoredExtensions)) {
          continue;
        }

        files.push(normalized);
      }

      for (const childFolder of listed.folders) {
        const normalized = normalizePath(childFolder);
        if (this.shouldIgnorePath(`${normalized}/`, 0, ignoredExtensions)) {
          continue;
        }

        await walk(normalized);
      }
    };

    await walk("");
    return files.sort((a, b) => a.localeCompare(b));
  }

  shouldIgnorePath(path: string, sizeBytes: number, ignoredExtensions: Set<string>): boolean {
    const normalized = normalizePath(path).replace(/\/$/, "");

    const configDir = this.app.vault.configDir;

    if (!this.settings.includeObsidianConfig && matchesGlob(`${configDir}/**`, normalized)) {
      return true;
    }

    const pluginDirRule = `${configDir}/plugins/${this.manifest.id}/**`;
    const rules = [
      ...DEFAULT_IGNORE_RULES,
      `${configDir}/workspace.json`,
      `${configDir}/workspace-mobile.json`,
      pluginDirRule,
      ...parseRuleLines(this.settings.customIgnoreRules)
    ];

    if (rules.some((rule) => matchesGlob(rule, normalized))) {
      return true;
    }

    if (this.settings.maxFileSizeMb > 0) {
      const maxBytes = this.settings.maxFileSizeMb * 1024 * 1024;
      if (sizeBytes > maxBytes) {
        return true;
      }
    }

    const ext = getExtension(normalized);
    return Boolean(ext && ignoredExtensions.has(ext));
  }

  async readRestoreEntries(bytes: ArrayBuffer): Promise<ZipRestoreEntry[]> {
    const zip = unzipSync(new Uint8Array(bytes));
    const archiveMetadata = this.readArchiveMetadata(zip);
    const entries: ZipRestoreEntry[] = [];

    for (const [rawPath, data] of Object.entries(zip)) {
      if (rawPath === ARCHIVE_METADATA_PATH || rawPath.endsWith("/")) {
        continue;
      }

      const safePath = normalizeRestorePath(rawPath);
      if (!safePath) {
        continue;
      }

      if (matchesGlob(`${this.app.vault.configDir}/plugins/${this.manifest.id}/**`, safePath)) {
        continue;
      }

      const metadata = archiveMetadata?.files[safePath];
      entries.push({
        path: safePath,
        data: toArrayBuffer(data),
        ctime: validTimestamp(metadata?.ctime) ? metadata.ctime : undefined,
        mtime: validTimestamp(metadata?.mtime) ? metadata.mtime : undefined
      });
    }

    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  readArchiveMetadata(zip: Record<string, Uint8Array>): ArchiveMetadata | null {
    const metadataFile = zip[ARCHIVE_METADATA_PATH];
    if (!metadataFile) {
      return null;
    }

    try {
      const text = strFromU8(metadataFile);
      const parsed = JSON.parse(text) as ArchiveMetadata;
      if (parsed.version !== 1 || !parsed.files) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  async writeRestoreEntries(entries: ZipRestoreEntry[]) {
    for (const entry of entries) {
      await this.ensureLocalFolder(parentPath(entry.path));
      await this.app.vault.adapter.writeBinary(entry.path, entry.data, writeOptionsForEntry(entry));
    }
  }

  async clearLocalVaultForRestore() {
    const files = await this.collectVaultFiles();

    for (const filePath of files.sort((a, b) => b.localeCompare(a))) {
      if (await this.app.vault.adapter.exists(filePath)) {
        await this.app.vault.adapter.remove(filePath);
      }
    }

    await this.removeEmptyLocalFolders("");
  }

  async removeEmptyLocalFolders(folder: string) {
    const ignoredExtensions = parseExtensionList(this.settings.ignoredExtensions);
    const listed = await this.app.vault.adapter.list(folder);

    for (const childFolder of listed.folders.sort((a, b) => b.localeCompare(a))) {
      const normalized = normalizePath(childFolder);
      if (this.shouldIgnorePath(`${normalized}/`, 0, ignoredExtensions)) {
        continue;
      }

      await this.removeEmptyLocalFolders(normalized);
    }

    if (!folder) {
      return;
    }

    const afterCleanup = await this.app.vault.adapter.list(folder);
    if (afterCleanup.files.length === 0 && afterCleanup.folders.length === 0) {
      await this.app.vault.adapter.rmdir(folder, false);
    }
  }

  async ensureLocalFolder(folder: string) {
    if (!folder) {
      return;
    }

    const parts = normalizePath(folder).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async hydratePackageSizes(
    client: WebdavClient,
    packages: RemotePackageMetadata[]
  ): Promise<RemotePackageMetadata[]> {
    if (packages.every((item) => item.sizeBytes > 0)) {
      return packages;
    }

    const directories = new Set<string>();
    for (const item of packages) {
      directories.add(parentPath(item.path));
    }

    const sizeByPath = new Map<string, number>();
    for (const directory of directories) {
      const entries = await client.propfind(directory, 1).catch(() => []);
      for (const entry of entries) {
        sizeByPath.set(entry.path, entry.sizeBytes);
      }
    }

    return packages.map((item) => ({
      ...item,
      sizeBytes: item.sizeBytes || sizeByPath.get(item.path) || 0
    }));
  }

  async fallbackListPackages(client: WebdavClient, kind: PackageKind): Promise<RemotePackageMetadata[]> {
    const directories = kind === "snapshot" ? [SNAPSHOTS_DIR] : [BEFORE_DOWNLOAD_DIR, MANUAL_BACKUP_DIR];
    const packages: RemotePackageMetadata[] = [];

    for (const directory of directories) {
      const entries = await client.propfind(directory, 1).catch(() => []);
      for (const entry of entries) {
        if (entry.filename.endsWith(".zip.parts.json")) {
          const manifest = await client.getJson<RemoteChunkManifest>(entry.path).catch(() => null);
          if (manifest?.metadata) {
            packages.push(normalizeRemotePackageMetadata(manifest.metadata));
          }
          continue;
        }

        if (!entry.filename.endsWith(".zip")) {
          continue;
        }

        packages.push({
          id: `${kind}:${entry.path}`,
          kind,
          backupReason: directory.includes("before-download") ? "before-download" : "manual",
          filename: entry.filename,
          path: entry.path,
          timestamp: parseTimestampFromFilename(entry.filename) ?? entry.lastModified ?? "",
          deviceId: parseDeviceIdFromFilename(entry.filename),
          deviceName: "",
          pluginVersion: "",
          vaultName: "",
          fileCount: 0,
          sizeBytes: entry.sizeBytes
        });
      }
    }

    return sortPackages(packages);
  }
}

class WebdavClient {
  private readonly baseUrl: string;
  private readonly root: string;
  private readonly username: string;
  private readonly password: string;

  constructor(options: { baseUrl: string; root: string; username: string; password: string }) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.root = trimSlashes(options.root || DEFAULT_REMOTE_ROOT);
    this.username = options.username;
    this.password = options.password;

    validateWebdavUrl(this.baseUrl);
  }

  async ensureBaseLayout() {
    await this.ensureDir("");
    await this.ensureDir(SNAPSHOTS_DIR);
    await this.ensureDir(METADATA_DIR);
    await this.ensureDir(BACKUPS_DIR);
    await this.ensureDir(BEFORE_DOWNLOAD_DIR);
    await this.ensureDir(MANUAL_BACKUP_DIR);
  }

  async ensureDir(path: string) {
    const segments = [this.root, ...trimSlashes(path).split("/").filter(Boolean)];
    let current = "";

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const response = await this.rawRequest("MKCOL", current);

      if (![200, 201, 405].includes(response.status)) {
        throw new Error(`无法创建远端目录 ${current}: HTTP ${response.status}`);
      }
    }
  }

  async putBytes(path: string, bytes: ArrayBuffer, contentType = "application/zip") {
    const response = await this.rawRequest("PUT", this.fullPath(path), bytes, {
      "Content-Type": contentType
    });

    if (![200, 201, 204].includes(response.status)) {
      if (response.status === 413) {
        throw new Error(`上传失败 ${path}: HTTP 413。服务器拒绝了这次上传大小，请在设置里调小“上传分片大小”。`);
      }
      throw new Error(`上传失败 ${path}: HTTP ${response.status}`);
    }
  }

  async putJson(path: string, data: unknown) {
    const response = await this.rawRequest("PUT", this.fullPath(path), JSON.stringify(data, null, 2), {
      "Content-Type": "application/json; charset=utf-8"
    });

    if (![200, 201, 204].includes(response.status)) {
      throw new Error(`上传元数据失败 ${path}: HTTP ${response.status}`);
    }
  }

  async getBytes(path: string): Promise<ArrayBuffer> {
    const response = await this.rawRequest("GET", this.fullPath(path));

    if (response.status !== 200) {
      throw new Error(`下载失败 ${path}: HTTP ${response.status}`);
    }

    return response.arrayBuffer;
  }

  async getText(path: string): Promise<string | null> {
    const response = await this.rawRequest("GET", this.fullPath(path));

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new Error(`读取远端文件失败 ${path}: HTTP ${response.status}`);
    }

    return response.text;
  }

  async getJson<T>(path: string): Promise<T | null> {
    const text = await this.getText(path);
    if (!text) {
      return null;
    }

    return JSON.parse(text) as T;
  }

  async getIndex(): Promise<RemoteIndex> {
    const index = await this.getJson<RemoteIndex>(`${METADATA_DIR}/index.json`);

    return {
      version: 1,
      updatedAt: index?.updatedAt ?? new Date().toISOString(),
      snapshots: (index?.snapshots ?? []).map(normalizeRemotePackageMetadata),
      backups: (index?.backups ?? []).map(normalizeRemotePackageMetadata)
    };
  }

  async delete(path: string) {
    const response = await this.rawRequest("DELETE", this.fullPath(path));

    if (![200, 202, 204, 404].includes(response.status)) {
      throw new Error(`删除失败 ${path}: HTTP ${response.status}`);
    }
  }

  async propfind(path: string, depth: 0 | 1): Promise<RemoteEntry[]> {
    const response = await this.rawRequest(
      "PROPFIND",
      this.fullPath(path),
      "<?xml version=\"1.0\" encoding=\"utf-8\"?><propfind xmlns=\"DAV:\"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>",
      {
        Depth: String(depth),
        "Content-Type": "application/xml; charset=utf-8"
      }
    );

    if (response.status === 404) {
      return [];
    }

    if (![207, 200].includes(response.status)) {
      throw new Error(`读取远端目录失败 ${path}: HTTP ${response.status}`);
    }

    return parsePropfind(response.text, this.root);
  }

  private async rawRequest(
    method: string,
    path: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {}
  ) {
    const request: RequestUrlParam = {
      url: this.urlFor(path),
      method,
      headers: {
        ...this.authHeaders(),
        ...headers
      },
      throw: false
    };

    if (body !== undefined) {
      request.body = body;
    }

    return requestUrl(request);
  }

  private fullPath(path: string): string {
    return trimSlashes([this.root, trimSlashes(path)].filter(Boolean).join("/"));
  }

  private urlFor(path: string): string {
    const encodedPath = trimSlashes(path)
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");

    return encodedPath ? `${this.baseUrl}/${encodedPath}` : this.baseUrl;
  }

  private authHeaders(): Record<string, string> {
    if (!this.username && !this.password) {
      return {};
    }

    return {
      Authorization: `Basic ${base64Utf8(`${this.username}:${this.password}`)}`
    };
  }
}

class RemoteStateModal extends Modal {
  private state: RemoteState | null = null;
  private section: RemoteStateSection;

  constructor(
    app: App,
    private readonly plugin: WebdavSnapshotSyncPlugin,
    section: RemoteStateSection = "overview"
  ) {
    super(app);
    this.section = section;
  }

  onOpen() {
    this.renderLoading();
    void this.load();
  }

  async load() {
    try {
      this.state = await this.plugin.refreshRemoteState();
      this.render();
    } catch (error) {
      this.renderError(error);
    }
  }

  private renderLoading() {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("远端状态")
      .setHeading();
    contentEl.createEl("p", {
      text: "正在读取远端索引..."
    });
  }

  private render() {
    const { contentEl } = this;
    const state = this.state;
    if (!state) {
      this.renderLoading();
      return;
    }

    contentEl.empty();
    new Setting(contentEl)
      .setName("远端状态")
      .setHeading();

    const switchRow = new Setting(contentEl);
    switchRow
      .setName("视图切换")
      .setDesc("概览、快照、备份和同步判断都在这里。");

    this.addSectionButton(switchRow, "概览", "overview");
    this.addSectionButton(switchRow, "快照", "snapshot");
    this.addSectionButton(switchRow, "备份", "backup");
    this.addSectionButton(switchRow, "同步判断", "sync");
    this.addRefreshButton(switchRow);

    switch (this.section) {
      case "snapshot":
        this.renderSnapshotSection(contentEl, state);
        break;
      case "backup":
        this.renderBackupSection(contentEl, state);
        break;
      case "sync":
        this.renderSyncSection(contentEl, state);
        break;
      default:
        this.renderOverviewSection(contentEl, state);
        break;
    }
  }

  private addSectionButton(setting: Setting, label: string, section: RemoteStateSection) {
    setting.addButton((button) => {
      button.setButtonText(label);
      if (this.section === section) {
        button.setCta();
        button.setDisabled(true);
        return;
      }

      button.onClick(() => {
        this.section = section;
        this.render();
      });
    });
  }

  private addRefreshButton(setting: Setting) {
    setting.addButton((button) => {
      button.setButtonText("刷新").onClick(async () => {
        button.setDisabled(true);
        try {
          this.state = await this.plugin.refreshRemoteState();
          this.render();
        } catch (error) {
          new Notice(errorMessage(error), 12000);
          button.setDisabled(false);
        }
      });
    });
  }

  private renderOverviewSection(contentEl: HTMLElement, state: RemoteState) {
    new Setting(contentEl)
      .setName("概览")
      .setHeading();

    contentEl.createEl("p", {
      text: "这里看整体情况，再跳去快照、备份或同步判断。"
    });

    const summary = contentEl.createEl("pre");
    summary.setText(
      [
        `远端快照数量: ${state.snapshots.length}`,
        `远端备份数量: ${state.backups.length}`,
        `远端最新设备 ID: ${state.latestSnapshot?.deviceId ?? "无"}`,
        `远端最新时间戳: ${state.latestSnapshot ? formatDateTime(state.latestSnapshot.timestamp) : "无"}`,
        `本地设备 ID: ${this.plugin.settings.deviceId}`,
        `本地上次操作时间: ${this.plugin.settings.lastOperationAt ? formatDateTime(this.plugin.settings.lastOperationAt) : "无"}`
      ].join("\n")
    );

    const actions = new Setting(contentEl);
    actions
      .setName("快捷操作")
      .setDesc("先看概览，再决定是看快照、看备份，还是走同步判断。");

    actions.addButton((button) => {
      button.setButtonText("同步判断").setCta().onClick(() => {
        this.section = "sync";
        this.render();
      });
    });

    actions.addButton((button) => {
      button.setButtonText("快照").onClick(() => {
        this.section = "snapshot";
        this.render();
      });
    });

    actions.addButton((button) => {
      button.setButtonText("备份").onClick(() => {
        this.section = "backup";
        this.render();
      });
    });
  }

  private renderSnapshotSection(contentEl: HTMLElement, state: RemoteState) {
    new Setting(contentEl)
      .setName("远端快照")
      .setHeading();

    contentEl.createEl("p", {
      text: `快照用于日常恢复点，只保留最近 ${this.plugin.settings.retentionCount} 个。`
    });

    this.renderPackageList(contentEl, state.snapshots, "snapshot", "没有找到远端快照。", "恢复此快照");
  }

  private renderBackupSection(contentEl: HTMLElement, state: RemoteState) {
    new Setting(contentEl)
      .setName("远端备份")
      .setHeading();

    contentEl.createEl("p", {
      text: "备份是恢复前安全包和手动备份，不参与自动清理。"
    });

    this.renderPackageList(contentEl, state.backups, "backup", "没有找到远端备份。", "恢复此备份");
  }

  private renderSyncSection(contentEl: HTMLElement, state: RemoteState) {
    new Setting(contentEl)
      .setName("同步判断")
      .setHeading();

    contentEl.createEl("pre", {
      text: [
        `本地设备 ID: ${this.plugin.settings.deviceId}`,
        `远端最新设备 ID: ${state.latestSnapshot?.deviceId ?? "无"}`,
        `远端最新时间戳: ${state.latestSnapshot ? formatDateTime(state.latestSnapshot.timestamp) : "无"}`,
        `本地上次操作时间: ${this.plugin.settings.lastOperationAt ? formatDateTime(this.plugin.settings.lastOperationAt) : "无"}`,
        `本地上次操作类型: ${this.plugin.settings.lastOperationType || "无"}`
      ].join("\n")
    });

    contentEl.createEl("p", {
      text: "插件不会自动判断谁新谁旧，这里只给你决策信息。"
    });

    const actions = new Setting(contentEl);
    actions.addButton((button) => {
      button
        .setButtonText("上传本地")
        .setCta()
        .onClick(async () => {
          await this.runModalAction(button, async () => {
            await this.plugin.uploadCurrentSnapshot();
          }, true);
        });
    });

    actions.addButton((button) => {
      button.setButtonText("下载远端").onClick(async () => {
        await this.runModalAction(button, async () => {
          const latest = await this.plugin.getLatestRemoteSnapshot();
          if (!latest) {
            throw new Error("远端没有可下载的快照。");
          }

          await this.plugin.restoreRemotePackage(latest);
        }, true);
      });
    });

    actions.addButton((button) => {
      button.setButtonText("只备份本地").onClick(async () => {
        await this.runModalAction(button, async () => {
          await this.plugin.createAndUploadBackup("manual");
        }, true);
      });
    });

    actions.addButton((button) => {
      button.setButtonText("关闭").onClick(() => this.close());
    });
  }

  private renderPackageList(
    contentEl: HTMLElement,
    packages: RemotePackageMetadata[],
    kind: PackageKind,
    emptyText: string,
    actionText: string
  ) {
    const ordered = sortPackages(packages);

    if (ordered.length === 0) {
      contentEl.createEl("p", {
        text: emptyText
      });
      return;
    }

    contentEl.createEl("p", {
      text: `共 ${ordered.length} 个，已按时间从新到旧排序。`
    });

    ordered.forEach((item, index) => {
      this.renderPackageItem(contentEl, item, kind, index === 0, actionText);
    });
  }

  private renderPackageItem(
    parent: HTMLElement,
    item: RemotePackageMetadata,
    kind: PackageKind,
    featured: boolean,
    actionText: string
  ) {
    const block = parent.createDiv({
      cls: featured ? "webdav-snapshot-sync-item webdav-snapshot-sync-item-featured" : "webdav-snapshot-sync-item"
    });

    const title = featured ? (kind === "snapshot" ? "最新快照" : "最新备份") : item.filename;
    new Setting(block)
      .setName(title)
      .setHeading();

    block.createEl("p", {
      text: `文件: ${item.filename}`
    });
    block.createEl("p", {
      text: [
        `时间: ${formatDateTime(item.timestamp)}`,
        `设备 ID: ${item.deviceId || "未知"}`,
        `设备名称: ${item.deviceName || "未知"}`,
        `大小: ${formatBytes(item.sizeBytes)}`,
        `存储: ${item.storage === "chunked" ? `分片 ${item.chunks?.length ?? 0} 个` : "单文件"}`
      ].join(" | ")
    });
    if (item.backupReason) {
      block.createEl("p", {
        text: `备份类型: ${item.backupReason === "before-download" ? "恢复前备份" : "手动备份"}`
      });
    }

    new Setting(block).addButton((button) => {
      button
        .setButtonText(actionText)
        .setCta()
        .onClick(async () => {
          await this.runModalAction(button, async () => {
            const current = await this.plugin.resolveRemotePackage(kind, item.path);
            if (!current) {
              throw new Error("远端条目已变化，请重新打开列表后再试。");
            }

            await this.plugin.restoreRemotePackage(current);
          }, true);
        });
    });
  }

  private async runModalAction(
    button: { setDisabled(value: boolean): unknown },
    action: () => Promise<unknown>,
    closeOnSuccess = false
  ) {
    button.setDisabled(true);
    try {
      await action();
      if (closeOnSuccess) {
        this.close();
      }
    } catch (error) {
      new Notice(errorMessage(error), 12000);
      button.setDisabled(false);
    }
  }

  renderError(error: unknown) {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("读取失败")
      .setHeading();
    contentEl.createEl("p", {
      text: errorMessage(error)
    });
  }
}

class SnapshotSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WebdavSnapshotSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("WebDAV 快照同步")
      .setHeading();

    new Setting(containerEl)
      .setName("插件版本")
      .setDesc(this.plugin.manifest.version);

    new Setting(containerEl)
      .setName("设备 ID")
      .setDesc(this.plugin.settings.deviceId);

    new Setting(containerEl)
      .setName("设备名称")
      .addText((text) =>
        text
          .setPlaceholder("笔记本电脑")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("WebDAV 地址")
      .addText((text) =>
        text
          .setPlaceholder("https://example.com/dav")
          .setValue(this.plugin.settings.webdavUrl)
          .onChange(async (value) => {
            this.plugin.settings.webdavUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("用户名")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("密码或令牌")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("远端根目录")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_REMOTE_ROOT)
          .setValue(this.plugin.settings.remoteRoot)
          .onChange(async (value) => {
            this.plugin.settings.remoteRoot = value.trim() || DEFAULT_REMOTE_ROOT;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(`包含 ${this.plugin.app.vault.configDir} 配置`)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeObsidianConfig)
          .onChange(async (value) => {
            this.plugin.settings.includeObsidianConfig = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("压缩包保留数量")
      .setDesc("上传快照后会自动清理旧快照，只保留最新这么多个。")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.retentionCount))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.retentionCount = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("上传分片大小")
      .setDesc("单位 MB。超过这个大小的快照包会分片上传，0 表示关闭分片。遇到 HTTP 413 时建议保持默认或调小。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_CHUNK_SIZE_MB))
          .setValue(String(this.plugin.settings.chunkSizeMb))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            this.plugin.settings.chunkSizeMb = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CHUNK_SIZE_MB;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("忽略大文件")
      .setDesc("单位 MB，0 表示不限制。")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.maxFileSizeMb))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            this.plugin.settings.maxFileSizeMb = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("忽略扩展名")
      .setDesc("逗号、空格或换行分隔，例如 mp4, psd。")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.ignoredExtensions)
          .onChange(async (value) => {
            this.plugin.settings.ignoredExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自定义忽略规则")
      .setDesc("每行一个匹配规则。默认会忽略 .git、.trash、工作区布局文件和本插件目录。")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text
          .setPlaceholder("assets/raw/**")
          .setValue(this.plugin.settings.customIgnoreRules)
          .onChange(async (value) => {
            this.plugin.settings.customIgnoreRules = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("快捷操作")
      .setHeading();

    new Setting(containerEl)
      .setName("测试 WebDAV 连接")
      .addButton((button) =>
        button.setButtonText("测试").onClick(async () => {
          await runWithNotice(button, () => this.plugin.testConnection());
        })
      );

    new Setting(containerEl)
      .setName("上传当前快照")
      .addButton((button) =>
        button.setButtonText("上传").setCta().onClick(async () => {
          await runWithNotice(button, () => this.plugin.uploadCurrentSnapshot());
        })
      );

    new Setting(containerEl)
      .setName("远端状态")
      .addButton((button) =>
        button.setButtonText("打开").onClick(() => {
          void this.plugin.openRemoteStateModal();
        })
      );

    new Setting(containerEl)
      .setName("只备份本地")
      .addButton((button) =>
        button.setButtonText("备份").onClick(async () => {
          await runWithNotice(button, () => this.plugin.createAndUploadBackup("manual"));
        })
      );
  }
}

async function runWithNotice(button: { setDisabled(value: boolean): unknown }, action: () => Promise<unknown>) {
  button.setDisabled(true);
  try {
    await action();
  } catch (error) {
    new Notice(errorMessage(error), 12000);
  } finally {
    button.setDisabled(false);
  }
}

function createDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function safeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "device";
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function validateWebdavUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WebDAV 地址无效，需要填写完整的 http:// 或 https:// 地址。");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WebDAV 地址只支持 http:// 或 https://。");
  }
}

function parseRuleLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseExtensionList(value: string): Set<string> {
  return new Set(
    value
      .split(/[\s,;]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((item) => (item.startsWith(".") ? item : `.${item}`))
  );
}

function getExtension(path: string): string {
  const filename = path.split("/").pop() ?? "";
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot).toLowerCase() : "";
}

function writeOptionsForEntry(entry: ZipRestoreEntry): DataWriteOptions | undefined {
  const options: DataWriteOptions = {};

  if (validTimestamp(entry.ctime)) {
    options.ctime = entry.ctime;
  }

  if (validTimestamp(entry.mtime)) {
    options.mtime = entry.mtime;
  }

  return options.ctime || options.mtime ? options : undefined;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function matchesGlob(pattern: string, path: string): boolean {
  const normalizedPattern = normalizePath(pattern.trim()).replace(/^\/+/, "").replace(/\/$/, "");
  const normalizedPath = normalizePath(path).replace(/^\/+/, "").replace(/\/$/, "");

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (!normalizedPattern.includes("*")) {
    return normalizedPath === normalizedPattern;
  }

  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedPath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }

  source += "$";
  return new RegExp(source);
}

function escapeRegExp(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function normalizeRestorePath(path: string): string | null {
  const raw = path.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) {
    return null;
  }

  const normalized = normalizePath(raw);
  if (!normalized || normalized === "." || normalized.includes("../") || normalized === "..") {
    return null;
  }

  return normalized;
}

function normalizeRemotePackageMetadata(item: RemotePackageMetadata): RemotePackageMetadata {
  const storage = item.storage ?? "single";
  return {
    ...item,
    storage,
    manifestPath: item.manifestPath ?? (storage === "chunked" ? `${item.path}.parts.json` : undefined),
    chunkSizeBytes: item.chunkSizeBytes,
    chunks: item.chunks ?? []
  };
}

function upsertPackage(items: RemotePackageMetadata[], item: RemotePackageMetadata): RemotePackageMetadata[] {
  const withoutExisting = items.filter((existing) => existing.path !== item.path);
  return [normalizeRemotePackageMetadata(item), ...withoutExisting];
}

function sortPackages(items: RemotePackageMetadata[]): RemotePackageMetadata[] {
  return [...items].sort((a, b) => {
    const bTime = Date.parse(b.timestamp) || 0;
    const aTime = Date.parse(a.timestamp) || 0;
    return bTime - aTime || b.filename.localeCompare(a.filename);
  });
}

function formatDateTime(value: string): string {
  if (!value) {
    return "未知";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "未知";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function parseTimestampFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?)/);
  if (!match) {
    return null;
  }

  const raw = match[1];
  const iso = raw.replace(/T(\d{2})-(\d{2})-(\d{2})Z?$/, "T$1:$2:$3Z");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function parseDeviceIdFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.zip$/i, "");
  const timestampMatch = withoutExtension.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?)-(.+)$/);
  if (!timestampMatch) {
    return "";
  }

  return timestampMatch[2].replace(/^before-download-/, "").replace(/^manual-/, "");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parsePropfind(xml: string, root: string): RemoteEntry[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const responses = Array.from(doc.getElementsByTagNameNS("*", "response"));
  const rootPrefix = `/${trimSlashes(root)}/`;
  const entries: RemoteEntry[] = [];

  for (const response of responses) {
    const href = getXmlText(response, "href");
    if (!href) {
      continue;
    }

    const decodedPath = decodeWebdavPath(href);
    const relative = relativeToRoot(decodedPath, rootPrefix);
    if (!relative) {
      continue;
    }

    const filename = relative.split("/").filter(Boolean).pop() ?? "";
    if (!filename) {
      continue;
    }

    if (hasXmlElement(response, "collection")) {
      continue;
    }

    entries.push({
      filename,
      path: relative,
      sizeBytes: Number.parseInt(getXmlText(response, "getcontentlength"), 10) || 0,
      lastModified: getXmlText(response, "getlastmodified")
    });
  }

  return entries;
}

function getXmlText(element: Element, localName: string): string {
  const found = element.getElementsByTagNameNS("*", localName)[0];
  return found?.textContent?.trim() ?? "";
}

function hasXmlElement(element: Element, localName: string): boolean {
  return element.getElementsByTagNameNS("*", localName).length > 0;
}

function decodeWebdavPath(href: string): string {
  try {
    const url = new URL(href, "http://placeholder.local");
    return decodeURIComponent(url.pathname);
  } catch {
    return decodeURIComponent(href.split("?")[0]);
  }
}

function relativeToRoot(path: string, rootPrefix: string): string {
  const normalized = normalizePath(path);
  const rootIndex = normalized.indexOf(rootPrefix);
  if (rootIndex === -1) {
    return "";
  }

  return trimSlashes(normalized.slice(rootIndex + rootPrefix.length));
}
