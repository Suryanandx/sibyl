/**
 * Call recordings — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createMemoryStore, type CallRecordingHost, type Principal } from "../../../packages/core/src";
import { EgressStatus, type EgressInfo } from "../../../apps/gateway/src/realtime/livekit";
import { presignGet } from "./s3";
import { RecordingService } from "./service";

const config = { url: "ws://livekit:7880", publicUrl: "ws://localhost:7880", apiUrl: "http://livekit:7880", apiKey: "k", apiSecret: "s", tokenTtlSeconds: 600 };
const admin: Principal = { kind: "user", orgId: "owner", userId: "u1", workspaceRoles: { default: "admin" } };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeEgress() {
  const calls: string[] = [];
  let status = EgressStatus.EGRESS_ACTIVE;
  const info = () => ({ egressId: "EG_1", status, fileResults: status === EgressStatus.EGRESS_COMPLETE ? [{ duration: 5_000_000_000n, size: 1234n }] : [], error: "" }) as unknown as EgressInfo;
  return {
    calls,
    finish: () => (status = EgressStatus.EGRESS_COMPLETE),
    client: {
      startRoomCompositeEgress: async (room: string, output: { filepath?: string }, options?: { audioOnly?: boolean; layout?: string }) => {
        calls.push(`start ${room} ${output.filepath} ${options?.layout ?? (options?.audioOnly ? "audio" : "")}`);
        return info();
      },
      stopEgress: async (id: string) => {
        calls.push(`stop ${id}`);
        status = EgressStatus.EGRESS_COMPLETE;
        return info();
      },
      listEgress: async () => [info()]
    }
  };
}

function service(now = () => Date.now(), host?: CallRecordingHost) {
  const data = mkdtempSync(join(tmpdir(), "sibyl-rec-"));
  dirs.push(data);
  const egress = fakeEgress();
  const recordings = new RecordingService({
    config,
    store: createMemoryStore(),
    ownerId: "owner",
    env: { SIBYL_DATA_DIR: data, SIBYL_RECORDINGS_EGRESS_DIR: "/recordings" },
    log: () => undefined,
    egress: egress.client as never,
    ...(host ? { host } : {}),
    now
  });
  return { recordings, egress, data };
}

describe("recordings (enterprise)", () => {
  test("start, stop, list and read a local recording; 30-day retention by default", async () => {
    const { recordings, egress, data } = service();
    expect(recordings.retentionDays).toBe(30);
    const started = await recordings.start(admin, "default", "sibyl.call.default.abc123");
    expect(started).toMatchObject({ status: "recording", kind: "call", room: "sibyl.call.default.abc123" });
    expect(egress.calls[0]).toMatch(/^start sibyl\.call\.default\.abc123 \/recordings\/default\/\d{4}-\d{2}-\d{2}-.+\.ogg audio$/);
    await expect(recordings.start(admin, "default", "sibyl.call.default.abc123")).rejects.toThrow(/already being recorded/);
    // Another workspace's room, or a stream: refused.
    await expect(recordings.start(admin, "default", "sibyl.call.other.abc123")).rejects.toThrow(/isn't in this workspace/);
    await expect(recordings.start(admin, "default", "sibyl.stream.default.x")).rejects.toThrow(/isn't in this workspace/);

    const stopped = await recordings.stop("default", started.id);
    expect(stopped).toMatchObject({ status: "ready", durationMs: 5_000, sizeBytes: 1234 });
    await expect(recordings.file("default", started.id)).rejects.toThrow(/missing/);
    // Egress wrote the file into the shared folder.
    const path = egress.calls[0]!.split(" ")[2]!.replace("/recordings/", "");
    mkdirSync(join(data, "recordings", "default"), { recursive: true });
    writeFileSync(join(data, "recordings", path), "OggS");
    expect(await recordings.file("default", started.id)).toMatchObject({ size: 4 });
    // Not visible from another workspace.
    expect(await recordings.list("other")).toEqual([]);
    expect((await recordings.list("default")).map((item) => item.id)).toEqual([started.id]);
  });

  test("the retention sweep deletes expired recordings and their files", async () => {
    let now = Date.now();
    const { recordings, egress, data } = service(() => now);
    const started = await recordings.start(admin, "default", "sibyl.phone.default.c1");
    egress.finish();
    await recordings.list("default");
    const path = egress.calls[0]!.split(" ")[2]!.replace("/recordings/", "");
    mkdirSync(join(data, "recordings", "default"), { recursive: true });
    writeFileSync(join(data, "recordings", path), "OggS");
    expect(await recordings.sweep()).toBe(0);
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await recordings.sweep()).toBe(1);
    expect(existsSync(join(data, "recordings", path))).toBe(false);
    expect(await recordings.list("default")).toEqual([]);
    await expect(recordings.remove("default", started.id)).resolves.toBe(false);
  });

  test("video recordings (MP4, speaker layout), links, announcements, search and legal hold", async () => {
    let now = Date.now();
    const said: string[] = [];
    const host: CallRecordingHost = {
      describe: async (room) =>
        room.startsWith("sibyl.call.default.")
          ? { kind: "call", workspaceId: "default", title: "Launch review", meetingId: room.split(".").at(-1)! }
          : room.startsWith("sibyl.phone.default.")
            ? { kind: "phone", workspaceId: "default", title: "Incoming call", callId: "call1" }
            : undefined,
      announce: async (room, state) => void said.push(`${state} ${room}`),
      linked: async (room, id) => void said.push(`linked ${room} ${id}`),
      useRecorder: () => undefined
    };
    const { recordings, egress } = service(() => now, host);
    const video = await recordings.start(admin, "default", "sibyl.call.default.meet01", { video: true });
    expect(video).toMatchObject({ type: "video", title: "Launch review", meetingId: "meet01", legalHold: false });
    expect(egress.calls[0]).toMatch(/\.mp4 speaker$/);
    expect(said).toEqual([`linked sibyl.call.default.meet01 ${video.id}`, "started sibyl.call.default.meet01"]);
    // A phone call has no video, whatever was asked.
    const phone = await recordings.start(undefined, "default", "sibyl.phone.default.p1", { video: true });
    expect(phone).toMatchObject({ type: "audio", kind: "phone", title: "Incoming call" });
    expect(egress.calls[1]).toMatch(/\.ogg audio$/);
    // The host decides what is in the workspace (not the room name alone).
    await expect(recordings.start(admin, "default", "sibyl.call.other.x")).rejects.toThrow(/isn't in this workspace/);
    await recordings.stop("default", video.id);
    expect(said).toContain("stopped sibyl.call.default.meet01");

    expect((await recordings.list("default", { q: "launch" })).map((item) => item.id)).toEqual([video.id]);
    expect((await recordings.list("default", { kind: "phone" })).map((item) => item.id)).toEqual([phone.id]);
    expect((await recordings.list("default", { type: "video" })).map((item) => item.id)).toEqual([video.id]);

    await recordings.setLegalHold("default", video.id, true);
    expect((await recordings.list("default", { held: true })).map((item) => item.id)).toEqual([video.id]);
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await recordings.sweep()).toBe(1);
    expect((await recordings.list("default")).map((item) => item.id)).toEqual([video.id]);
    await expect(recordings.setLegalHold("other", video.id, false)).rejects.toThrow(/not found/i);
  });

  test("S3 downloads are presigned (AWS SigV4 reference example)", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignGet(
      { bucket: "examplebucket", region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", endpoint: "https://s3.amazonaws.com", forcePathStyle: false },
      "test.txt",
      86_400,
      new Date("2013-05-24T00:00:00Z")
    );
    expect(url).toContain("https://examplebucket.s3.amazonaws.com/test.txt?");
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});
