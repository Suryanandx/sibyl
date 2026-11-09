"use client";

/**
 * Before joining: check the camera and microphone (preview, level meter,
 * device choice), and for guests their name. Nothing is published until
 * "Join"; the preview tracks are released on the way in.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Button, Field, Input, Notice, Select } from "../../components/ui";
import { listDevices, previewDevices, type DevicePreview } from "../realtime/room";
import styles from "./meetings.module.css";

export interface JoinChoice {
  name: string;
  microphone: boolean;
  camera: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}

export function PreJoin({
  title,
  lead,
  askName = false,
  joinLabel = "Join now",
  busy = false,
  error,
  extra,
  onJoin
}: {
  title: string;
  lead?: ReactNode;
  askName?: boolean;
  joinLabel?: string;
  busy?: boolean;
  error?: string | null;
  extra?: ReactNode;
  onJoin(choice: JoinChoice): void;
}) {
  const [microphone, setMicrophone] = useState(true);
  const [camera, setCamera] = useState(true);
  const [name, setName] = useState("");
  const [devices, setDevices] = useState<{ cameras: MediaDeviceInfo[]; microphones: MediaDeviceInfo[] }>({ cameras: [], microphones: [] });
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [videoDeviceId, setVideoDeviceId] = useState("");
  const [level, setLevel] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<DevicePreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    void previewDevices({
      camera,
      microphone,
      ...(audioDeviceId ? { audioDeviceId } : {}),
      ...(videoDeviceId ? { videoDeviceId } : {})
    }).then(async (preview) => {
      if (cancelled) return preview.stop();
      previewRef.current = preview;
      setBlocked((camera && !preview.video) || (microphone && !preview.audio));
      if (preview.video && videoRef.current) preview.video.attach(videoRef.current);
      setDevices(await listDevices());
      const meter = () => {
        setLevel(preview.level());
        frame = requestAnimationFrame(meter);
      };
      if (preview.audio) frame = requestAnimationFrame(meter);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      previewRef.current?.stop();
      previewRef.current = null;
      setLevel(0);
    };
  }, [camera, microphone, audioDeviceId, videoDeviceId]);

  function join(): void {
    previewRef.current?.stop();
    previewRef.current = null;
    onJoin({ name: name.trim(), microphone, camera, ...(audioDeviceId ? { audioDeviceId } : {}), ...(videoDeviceId ? { videoDeviceId } : {}) });
  }

  return (
    <div className={styles.prejoin}>
      <div className={styles.prejoinCard}>
        <div className={styles.preview}>
          {camera ? <video ref={videoRef} autoPlay playsInline muted /> : <span className={styles.muted}>Camera is off</span>}
          <div className={styles.previewControls}>
            <button type="button" className={styles.ctl} data-off={!microphone} onClick={() => setMicrophone((value) => !value)} aria-label={microphone ? "Turn microphone off" : "Turn microphone on"}>
              <Icon name={microphone ? "mic" : "micOff"} size={18} />
            </button>
            <button type="button" className={styles.ctl} data-off={!camera} onClick={() => setCamera((value) => !value)} aria-label={camera ? "Turn camera off" : "Turn camera on"}>
              <Icon name={camera ? "video" : "videoOff"} size={18} />
            </button>
          </div>
        </div>
        <form
          className={styles.joinSide}
          onSubmit={(event) => {
            event.preventDefault();
            join();
          }}
        >
          <h1>{title}</h1>
          {lead ? <p className={styles.muted}>{lead}</p> : null}
          {askName ? (
            <Field label="Your name">
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="name" required autoFocus />
            </Field>
          ) : null}
          {microphone ? (
            <div aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className={styles.level}>
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          ) : null}
          {devices.microphones.length > 1 ? (
            <Field label="Microphone">
              <Select value={audioDeviceId} onChange={(event) => setAudioDeviceId(event.target.value)}>
                <option value="">Default</option>
                {devices.microphones.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || "Microphone"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {devices.cameras.length > 1 ? (
            <Field label="Camera">
              <Select value={videoDeviceId} onChange={(event) => setVideoDeviceId(event.target.value)}>
                <option value="">Default</option>
                {devices.cameras.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || "Camera"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {blocked ? <Notice tone="warning">The browser didn't give access to your camera or microphone. Allow it in the address bar, or join without them.</Notice> : null}
          {extra}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button type="submit" variant="primary" disabled={busy || (askName && !name.trim())}>
            {busy ? "Joining…" : joinLabel}
          </Button>
        </form>
      </div>
    </div>
  );
}
