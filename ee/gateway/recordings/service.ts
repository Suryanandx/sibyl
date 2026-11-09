/**
 * Call recordings — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Start and stop audio recordings of a room (LiveKit egress, one mixed Ogg
 * file), keep them in the data volume or S3-compatible storage, delete them
 * after the retention period (30 days by default), list and download them.
 *
 * Storage:
 * - local (default): egress writes `<SIBYL_RECORDINGS_EGRESS_DIR>/<ws>/<id>.ogg`
 *   — the same folder the gateway sees as `<SIBYL_RECORDINGS_DIR>` (default
 *   `$SIBYL_DATA_DIR/recordings`); compose mounts one volume in both.
 * - S3 (SIBYL_RECORDINGS_S3_*): egress uploads; downloads are presigned links.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Principal, Store } from "../../../packages/core/src";
import { parseRoomName, type RealtimeConfig } from "../../../apps/gateway/src/realtime/index";
import { EgressClient, EgressStatus, EncodedFileOutput, EncodedFileType, S3Upload, type EgressInfo } from "../../../apps/gateway/src/realtime/livekit";
import { presignGet, s3Request, type S3Settings } from "./s3";

export interface RecordingRecord {
  id: string;
  egressId: string;
  workspaceId: string;
  room: string;
  kind: string;
  status: "recording" | "ready" | "failed";
  storage: "local" | "s3";
  /** Path below the recordings folder, or the S3 key. */
  file: string;
  startedBy?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  sizeBytes?: number;
  expiresAt: number;
  error?: string;
}

export type RecordingView = Omit<RecordingRecord, "egressId" | "file" | "storage">;

export class RecordingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface RecordingServiceOptions {
  config: RealtimeConfig;
  store: Store;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  s3?: S3Settings;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Tests: replace the egress client. */
  egress?: Pick<EgressClient, "startRoomCompositeEgress" | "stopEgress" | "listEgress">;
  now?: () => number;
}

const KEY = "recordings";
const MAX_RECORDS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class RecordingService {
  readonly localDir: string;
  readonly egressDir: string;
  readonly retentionDays: number;
  private readonly egress: Pick<EgressClient, "startRoomCompositeEgress" | "stopEgress" | "listEgress">;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RecordingServiceOptions) {
    const env = options.env;
    this.localDir = resolve(env.SIBYL_RECORDINGS_DIR?.trim() || join(env.SIBYL_DATA_DIR?.trim() || "./data", "recordings"));
    this.egressDir = (env.SIBYL_RECORDINGS_EGRESS_DIR?.trim() || "/recordings").replace(/\/+$/, "");
    const days = Number(env.SIBYL_RECORDINGS_RETENTION_DAYS ?? "");
    this.retentionDays = Number.isFinite(days) && days >= 1 && days <= 3650 ? Math.floor(days) : 30;
    this.egress = options.egress ?? new EgressClient(options.config.apiUrl, options.config.apiKey, options.config.apiSecret);
    this.now = options.now ?? Date.now;
  }

  /** Start an audio recording of a room in the caller's workspace. */
  async start(principal: Principal, workspaceId: string, room: string): Promise<RecordingView> {
    const parsed = parseRoomName(room);
    if (!parsed || parsed.workspaceId !== workspaceId || parsed.kind === "stream") throw new RecordingError("That call isn't in this workspace.", 404);
    const records = await this.load();
    if (records.some((record) => record.room === room && record.status === "recording")) throw new RecordingError("This call is already being recorded.", 409);
    const id = randomBytes(9).toString("base64url");
    const file = `${workspaceId}/${new Date(this.now()).toISOString().slice(0, 10)}-${id}.ogg`;
    const s3 = this.options.s3;
    if (!s3) await mkdir(join(this.localDir, workspaceId), { recursive: true });
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.OGG,
      filepath: s3 ? file : `${this.egressDir}/${file}`,
      ...(s3
        ? {
            output: {
              case: "s3" as const,
              value: new S3Upload({
                accessKey: s3.accessKey,
                secret: s3.secretKey,
                region: s3.region,
                bucket: s3.bucket,
                forcePathStyle: s3.forcePathStyle,
                ...(s3.endpoint ? { endpoint: s3.endpoint } : {})
              })
            }
          }
        : {})
    });
    let info: EgressInfo;
    try {
      info = await this.egress.startRoomCompositeEgress(room, output, { audioOnly: true });
    } catch (error) {
      this.options.log("recordings.start_failed", { room, error: error instanceof Error ? error.message : String(error) });
      throw new RecordingError("The recorder (LiveKit egress) didn't start. Is the egress service running?", 502);
    }
    const record: RecordingRecord = {
      id,
      egressId: info.egressId,
      workspaceId,
      room,
      kind: parsed.kind,
      status: "recording",
      storage: s3 ? "s3" : "local",
      file,
      ...(principal.userId ? { startedBy: principal.userId } : {}),
      startedAt: this.now(),
      expiresAt: this.now() + this.retentionDays * DAY_MS
    };
    await this.update((all) => [record, ...all].slice(0, MAX_RECORDS));
    this.options.log("recordings.started", { id, room, storage: record.storage });
    return view(record);
  }

  async stop(workspaceId: string, id: string): Promise<RecordingView> {
    const record = (await this.load()).find((item) => item.id === id && item.workspaceId === workspaceId);
    if (!record) throw new RecordingError("Recording not found.", 404);
    if (record.status === "recording") {
      const info = await this.egress.stopEgress(record.egressId).catch(() => undefined);
      if (info) return view(await this.applyEgress(record, info));
    }
    return view((await this.refresh(workspaceId)).find((item) => item.id === id) ?? record);
  }

  /** Recordings of a workspace, newest first (status refreshed from egress). */
  async list(workspaceId: string): Promise<RecordingView[]> {
    return (await this.refresh(workspaceId)).map(view);
  }

  /** Where to read a finished recording: a local file or a presigned URL. */
  async file(workspaceId: string, id: string): Promise<{ path: string; size: number } | { url: string }> {
    const record = (await this.load()).find((item) => item.id === id && item.workspaceId === workspaceId);
    if (!record || record.status !== "ready") throw new RecordingError("Recording not found or not finished yet.", 404);
    if (record.storage === "s3") {
      if (!this.options.s3) throw new RecordingError("S3 storage is no longer configured.", 409);
      return { url: presignGet(this.options.s3, record.file, 300) };
    }
    const path = this.localPath(record.file);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new RecordingError("The recording file is missing.", 404);
    return { path, size: info.size };
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const record = (await this.load()).find((item) => item.id === id && item.workspaceId === workspaceId);
    if (!record) return false;
    if (record.status === "recording") await this.egress.stopEgress(record.egressId).catch(() => undefined);
    await this.deleteFile(record);
    await this.update((all) => all.filter((item) => item.id !== id));
    return true;
  }

  /** Delete recordings past their retention date. */
  async sweep(): Promise<number> {
    const now = this.now();
    const expired = (await this.load()).filter((record) => record.expiresAt <= now && record.status !== "recording");
    for (const record of expired) await this.deleteFile(record);
    if (expired.length) {
      const ids = new Set(expired.map((record) => record.id));
      await this.update((all) => all.filter((record) => !ids.has(record.id)));
      this.options.log("recordings.expired", { count: expired.length });
    }
    return expired.length;
  }

  startRetention(intervalMs = 60 * 60 * 1000): void {
    void this.sweep().catch(() => undefined);
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), intervalMs);
    this.sweepTimer.unref?.();
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async refresh(workspaceId: string): Promise<RecordingRecord[]> {
    const records = (await this.load()).filter((record) => record.workspaceId === workspaceId);
    for (const record of records.filter((item) => item.status === "recording")) {
      const [info] = await this.egress.listEgress({ egressId: record.egressId }).catch(() => [] as EgressInfo[]);
      if (info) await this.applyEgress(record, info);
    }
    return (await this.load()).filter((record) => record.workspaceId === workspaceId);
  }

  private async applyEgress(record: RecordingRecord, info: EgressInfo): Promise<RecordingRecord> {
    const done = info.status === EgressStatus.EGRESS_COMPLETE;
    const failed = info.status === EgressStatus.EGRESS_FAILED || info.status === EgressStatus.EGRESS_ABORTED || info.status === EgressStatus.EGRESS_LIMIT_REACHED;
    if (!done && !failed) return record;
    const result = info.fileResults[0];
    const next: RecordingRecord = {
      ...record,
      status: done ? "ready" : "failed",
      endedAt: this.now(),
      ...(result?.duration ? { durationMs: Number(result.duration / 1_000_000n) } : {}),
      ...(result?.size ? { sizeBytes: Number(result.size) } : {}),
      ...(failed && info.error ? { error: info.error.slice(0, 300) } : {})
    };
    await this.update((all) => all.map((item) => (item.id === record.id ? next : item)));
    return next;
  }

  private localPath(file: string): string {
    const path = resolve(this.localDir, file);
    if (!path.startsWith(this.localDir + "/")) throw new RecordingError("Invalid recording path.", 400);
    return path;
  }

  private async deleteFile(record: RecordingRecord): Promise<void> {
    try {
      if (record.storage === "s3") {
        if (this.options.s3) await s3Request(this.options.s3, "DELETE", record.file);
      } else {
        await rm(this.localPath(record.file), { force: true });
        // Egress leaves a manifest (<egress id>.json) next to the file.
        await rm(this.localPath(`${record.workspaceId}/${record.egressId}.json`), { force: true });
      }
    } catch (error) {
      this.options.log("recordings.delete_failed", { id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async load(): Promise<RecordingRecord[]> {
    await this.queue;
    return (await this.options.store.kv.get<RecordingRecord[]>(this.options.ownerId, KEY)) ?? [];
  }

  /** Read-modify-write, one at a time. */
  private update(change: (records: RecordingRecord[]) => RecordingRecord[]): Promise<void> {
    const next = this.queue.then(async () => {
      const current = (await this.options.store.kv.get<RecordingRecord[]>(this.options.ownerId, KEY)) ?? [];
      await this.options.store.kv.set(this.options.ownerId, KEY, change(current));
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function view(record: RecordingRecord): RecordingView {
  const { egressId: _egress, file: _file, storage: _storage, ...rest } = record;
  return rest;
}
