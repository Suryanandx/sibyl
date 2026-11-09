/**
 * Call recordings — Sibyl Enterprise (feature `recordings`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Installs only with a licence that includes `recordings` AND a configured
 * LiveKit (LIVEKIT_*) with its egress service. Adds /api/recordings (gated by
 * calls.record) and an hourly retention sweep, and plugs into the realtime
 * layer (ctx.calls): announcements, links to meetings and call log entries,
 * and recording phone calls when the phone line asks for it. The open-source
 * edition has no recording at all.
 */
import type { EnterpriseModule } from "../../../packages/core/src/features";
import { parseAllowedOrigins } from "../../../apps/gateway/src/config";
import { realtimeConfigFromEnv } from "../../../apps/gateway/src/realtime/index";
import { recordingsRoute } from "./http";
import { s3SettingsFromEnv } from "./s3";
import { RecordingService } from "./service";

export const recordingsModule: EnterpriseModule = {
  id: "recordings",
  feature: "recordings",
  install(ctx) {
    const realtime = realtimeConfigFromEnv(ctx.env);
    if (!realtime.config) {
      ctx.log("recordings.unavailable", { reason: realtime.problem ?? "LiveKit is not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)" });
      return;
    }
    const s3 = s3SettingsFromEnv(ctx.env);
    const service = new RecordingService({
      config: realtime.config,
      store: ctx.store,
      ownerId: ctx.ownerId,
      env: ctx.env,
      ...(s3 ? { s3 } : {}),
      ...(ctx.calls ? { host: ctx.calls } : {}),
      log: ctx.log
    });
    ctx.calls?.useRecorder({ start: (input) => service.start(input.principal, input.workspaceId, input.room, { video: input.video }) });
    ctx.registerHttpRoute(recordingsRoute(service, parseAllowedOrigins(ctx.env.ALLOWED_ORIGINS), ctx.log));
    service.startRetention();
    ctx.log("recordings.installed", { storage: s3 ? "s3" : "local", retentionDays: service.retentionDays, ...(s3 ? {} : { dir: service.localDir }) });
    return {
      close: () => {
        ctx.calls?.useRecorder(undefined);
        service.close();
      }
    };
  }
};

export { RecordingService, RecordingError, type RecordingRecord, type RecordingView } from "./service";
