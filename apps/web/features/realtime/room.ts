"use client";

/**
 * Browser side of a LiveKit room: join with the token the gateway minted,
 * publish the microphone (echo cancellation, noise suppression, gain
 * control) and, in meetings, the camera and a shared screen; play every
 * remote voice; read live captions (text streams on "lk.transcription",
 * written by Sibyl's room agent) and small data messages (raised hands, the
 * gateway's "notes changed" nudges).
 *
 * livekit-client is loaded on demand, so the zero-setup WebSocket path never
 * downloads it.
 */
import type { LocalAudioTrack, LocalVideoTrack, Participant, RemoteTrack, Room } from "livekit-client";

export const CAPTION_TOPIC = "lk.transcription";

export interface Caption {
  id: string;
  /** Identity of who said it (user:…, agent:…, guest:…, phone:…). */
  speaker: string;
  speakerName?: string;
  text: string;
  final: boolean;
  at: number;
}

export interface RoomCallbacks {
  onCaption?(caption: Caption): void;
  /** Participants, speaking state, tracks or recording state changed. */
  onChange?(): void;
  onDisconnected?(reason: string): void;
  /** A data message (topic, parsed JSON, sender identity). */
  onData?(topic: string, payload: unknown, from: string | undefined): void;
}

export interface JoinOptions {
  /** Start with the microphone on (default true). */
  microphone?: boolean;
  /** Start with the camera on (meetings). */
  camera?: boolean;
  /** Devices picked on the pre-join screen. */
  audioDeviceId?: string;
  videoDeviceId?: string;
}

export interface JoinedRoom {
  room: Room;
  /** The microphone is published (false: blocked or missing; listening only). */
  microphone: boolean;
  setMuted(muted: boolean): Promise<void>;
  setCamera(on: boolean): Promise<boolean>;
  setScreenShare(on: boolean): Promise<boolean>;
  /** Send a small JSON message to everyone (or some identities) on a topic. */
  send(topic: string, payload: unknown, to?: string[]): Promise<void>;
  leave(): Promise<void>;
}

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export async function joinRoom(url: string, token: string, callbacks: RoomCallbacks = {}, options: JoinOptions = {}): Promise<JoinedRoom> {
  const { Room, RoomEvent, Track } = await import("livekit-client");
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const audio = new Map<string, HTMLMediaElement>();
  const changed = () => callbacks.onChange?.();
  const audioOptions = { ...AUDIO, ...(options.audioDeviceId ? { deviceId: options.audioDeviceId } : {}) };

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    // Video is attached by the tile that shows it; audio plays here.
    if (track.kind !== Track.Kind.Audio) return changed();
    const element = track.attach();
    element.style.display = "none";
    document.body.appendChild(element);
    audio.set(track.sid ?? String(audio.size), element);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Audio) {
      for (const element of track.detach()) element.remove();
      if (track.sid) audio.delete(track.sid);
    }
    changed();
  });
  for (const event of [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.TrackPublished,
    RoomEvent.TrackUnpublished,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.RecordingStatusChanged,
    RoomEvent.ParticipantAttributesChanged
  ]) {
    room.on(event, changed);
  }
  room.on(RoomEvent.Disconnected, (reason?: unknown) => {
    for (const element of audio.values()) element.remove();
    audio.clear();
    callbacks.onDisconnected?.(String(reason ?? "disconnected"));
  });
  room.on(RoomEvent.DataReceived, (data: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
    if (!topic || !callbacks.onData) return;
    try {
      callbacks.onData(topic, JSON.parse(new TextDecoder().decode(data)), participant?.identity);
    } catch {
      // not ours
    }
  });
  room.registerTextStreamHandler(CAPTION_TOPIC, async (reader, participant) => {
    const text = await reader.readAll();
    const attributes = reader.info.attributes ?? {};
    callbacks.onCaption?.({
      id: attributes["lk.segment_id"] ?? reader.info.id,
      speaker: attributes["sibyl.speaker"] ?? participant.identity,
      ...(attributes["sibyl.speaker_name"] ? { speakerName: attributes["sibyl.speaker_name"] } : {}),
      text,
      final: attributes["lk.transcription_final"] !== "false",
      at: Date.now()
    });
  });

  await room.connect(url, token, { autoSubscribe: true });
  // No microphone (blocked or missing): stay in the room and listen.
  const microphone = await room.localParticipant
    .setMicrophoneEnabled(options.microphone !== false, audioOptions)
    .then(() => true)
    .catch(() => false);
  if (options.camera) {
    await room.localParticipant.setCameraEnabled(true, options.videoDeviceId ? { deviceId: options.videoDeviceId } : undefined).catch(() => undefined);
  }
  // Called right after a click, so the browser lets remote audio play.
  await room.startAudio().catch(() => undefined);
  changed();
  return {
    room,
    microphone,
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted, audioOptions);
      changed();
    },
    setCamera: async (on) => {
      const ok = await room.localParticipant
        .setCameraEnabled(on, on && options.videoDeviceId ? { deviceId: options.videoDeviceId } : undefined)
        .then(() => true)
        .catch(() => false);
      changed();
      return ok;
    },
    setScreenShare: async (on) => {
      const ok = await room.localParticipant
        .setScreenShareEnabled(on, { audio: true })
        .then(() => true)
        .catch(() => false);
      changed();
      return ok;
    },
    send: async (topic, payload, to) => {
      await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), { reliable: true, topic, ...(to ? { destinationIdentities: to } : {}) });
    },
    leave: async () => {
      await room.disconnect();
    }
  };
}

/** What a participant is: a person, a guest, one of our agents (with avatar), a phone line or a stream. */
export function participantKind(participant: Participant): "person" | "guest" | "agent" | "phone" | "stream" {
  const identity = participant.identity;
  if (identity.startsWith("agent:")) return "agent";
  if (identity.startsWith("guest:")) return "guest";
  if (identity.startsWith("phone:")) return "phone";
  if (identity.startsWith("stream:")) return "stream";
  return "person";
}

/** A local preview for the pre-join screen: camera and microphone level, released on stop(). */
export interface DevicePreview {
  video?: LocalVideoTrack;
  audio?: LocalAudioTrack;
  /** 0…1, the microphone's current level. */
  level(): number;
  stop(): void;
}

export async function previewDevices(options: { camera: boolean; microphone: boolean; audioDeviceId?: string; videoDeviceId?: string }): Promise<DevicePreview> {
  const { createLocalTracks, Track } = await import("livekit-client");
  const tracks = await createLocalTracks({
    audio: options.microphone ? { ...AUDIO, ...(options.audioDeviceId ? { deviceId: options.audioDeviceId } : {}) } : false,
    video: options.camera ? (options.videoDeviceId ? { deviceId: options.videoDeviceId } : true) : false
  }).catch(() => []);
  const video = tracks.find((track) => track.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
  const audio = tracks.find((track) => track.kind === Track.Kind.Audio) as LocalAudioTrack | undefined;
  let level = () => 0;
  let context: AudioContext | undefined;
  if (audio?.mediaStreamTrack) {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(new MediaStream([audio.mediaStreamTrack])).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    level = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    };
  }
  return {
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    level: () => level(),
    stop: () => {
      for (const track of tracks) track.stop();
      void context?.close().catch(() => undefined);
    }
  };
}

/** Cameras and microphones (labels appear once the person allowed access). */
export async function listDevices(): Promise<{ cameras: MediaDeviceInfo[]; microphones: MediaDeviceInfo[] }> {
  const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
  return { cameras: devices.filter((device) => device.kind === "videoinput"), microphones: devices.filter((device) => device.kind === "audioinput") };
}
