"use client";

/**
 * Playback of a meeting: a speaker-coloured timeline, a waveform, time,
 * speed, skip and play/pause.
 *
 * - With a recording (Sibyl Enterprise): the audio plays; the waveform is the
 *   recording's own.
 * - Without one: the same controls run a clock over the transcript's
 *   timestamps, so "play" walks through what was said and clicking the
 *   timeline jumps the transcript there. The bars show when people talked.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import type { MeetingSegmentView, MeetingView } from "@open-gpt-live/protocol";
import { Icon } from "../../components/Icon";
import { colorOf } from "./api";
import { clock, speakerColor } from "./speakers";
import styles from "./meetings.module.css";

const BARS = 96;
const SPEEDS = [1, 1.25, 1.5, 2] as const;

export interface PlaybackHandle {
  seek(ms: number): void;
}

export interface PlaybackProps {
  meeting: MeetingView;
  segments: MeetingSegmentView[];
  /** Object URL of the recording's audio (Enterprise), when there is one. */
  audioUrl?: string;
  /** Recording bytes for the waveform. */
  audioData?: ArrayBuffer;
  onPosition(ms: number): void;
  onDownload(): void;
  downloadLabel: string;
  /** A short line under the controls (e.g. where recordings come from). */
  note?: ReactNode;
}

export const Playback = forwardRef<PlaybackHandle, PlaybackProps>(function Playback(props, ref) {
  const { meeting, segments, audioUrl, audioData, onPosition } = props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [audioMs, setAudioMs] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  const transcriptMs = Math.max(
    segments.at(-1)?.endMs ?? 0,
    meeting.startedAt && meeting.endedAt ? meeting.endedAt - meeting.startedAt : 0,
    meeting.status === "live" && meeting.startedAt ? Date.now() - meeting.startedAt : 0
  );
  const duration = Math.max(1, audioMs ?? transcriptMs);

  const update = (ms: number) => {
    const clamped = Math.max(0, Math.min(duration, ms));
    setPosition(clamped);
    onPosition(clamped);
  };

  const seek = (ms: number) => {
    const audio = audioRef.current;
    if (audioUrl && audio) audio.currentTime = Math.max(0, ms) / 1000;
    update(ms);
  };
  useImperativeHandle(ref, () => ({ seek }));

  // Without audio: a clock over the transcript.
  useEffect(() => {
    if (audioUrl || !playing) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = position + (now - last) * speed;
      last = now;
      if (next >= duration) {
        update(duration);
        setPlaying(false);
        return;
      }
      update(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // position is read once per start; the loop carries it forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl, playing, speed, duration]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  // The recording's waveform.
  useEffect(() => {
    if (!audioData) return setPeaks(null);
    let cancelled = false;
    const context = new AudioContext();
    context
      .decodeAudioData(audioData.slice(0))
      .then((buffer) => {
        if (cancelled) return;
        const data = buffer.getChannelData(0);
        const size = Math.max(1, Math.floor(data.length / BARS));
        const out: number[] = [];
        for (let bar = 0; bar < BARS; bar += 1) {
          let peak = 0;
          for (let index = bar * size; index < Math.min(data.length, (bar + 1) * size); index += 64) peak = Math.max(peak, Math.abs(data[index]!));
          out.push(peak);
        }
        const max = Math.max(0.01, ...out);
        setPeaks(out.map((value) => value / max));
      })
      .catch(() => setPeaks(null))
      .finally(() => void context.close().catch(() => undefined));
    return () => {
      cancelled = true;
    };
  }, [audioData]);

  // Without a recording: when people talked, from the transcript.
  const bars = useMemo(() => {
    if (peaks) return peaks;
    const out = new Array<number>(BARS).fill(0);
    const bucket = duration / BARS;
    for (const segment of segments) {
      const from = Math.floor(segment.startMs / bucket);
      const to = Math.min(BARS - 1, Math.floor(Math.max(segment.startMs, segment.endMs) / bucket));
      const density = Math.min(1, segment.text.length / Math.max(1, (segment.endMs - segment.startMs) / 60));
      for (let bar = Math.max(0, from); bar <= to; bar += 1) out[bar] = Math.max(out[bar]!, 0.35 + 0.65 * density * (0.7 + 0.3 * Math.sin(bar * 1.7)));
    }
    return out.map((value) => (value === 0 ? 0.08 : value));
  }, [peaks, segments, duration]);

  const blocks = useMemo(
    () =>
      segments.map((segment) => ({
        key: segment.seq,
        left: (segment.startMs / duration) * 100,
        width: Math.max(0.6, ((Math.max(segment.endMs, segment.startMs + 1500) - segment.startMs) / duration) * 100),
        color: speakerColor(colorOf(meeting.participants, segment.speaker)),
        title: `${segment.speakerName} · ${clock(segment.startMs)}`
      })),
    [segments, duration, meeting.participants]
  );

  const fromPointer = (event: React.MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - box.left) / Math.max(1, box.width)) * duration);
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (audioUrl && audio) {
      if (audio.paused) void audio.play().catch(() => setPlaying(false));
      else audio.pause();
      return;
    }
    if (position >= duration) update(0);
    setPlaying((value) => !value);
  };

  const played = Math.round((position / duration) * BARS);
  return (
    <div className={styles.player}>
      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          muted={muted}
          onLoadedMetadata={(event) => {
            const ms = event.currentTarget.duration * 1000;
            if (Number.isFinite(ms) && ms > 0) setAudioMs(ms);
          }}
          onTimeUpdate={(event) => update(event.currentTarget.currentTime * 1000)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      ) : null}
      <div className={styles.speakerBar} onClick={fromPointer} role="presentation" title="Who spoke when">
        {blocks.map((block) => (
          <span key={block.key} title={block.title} style={{ left: `${block.left}%`, width: `${block.width}%`, ["--speaker" as string]: block.color }} />
        ))}
      </div>
      <div className={styles.wave}>
        <span className={styles.waveTime}>{clock(position)}</span>
        <div
          className={styles.bars}
          onClick={fromPointer}
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={Math.round(position / 1000)}
          aria-valuetext={clock(position)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") seek(position + 5_000);
            if (event.key === "ArrowLeft") seek(position - 5_000);
          }}
        >
          {bars.map((value, index) => (
            <span key={index} data-played={index < played} style={{ height: `${Math.round(10 + value * 90)}%` }} />
          ))}
        </div>
        <span className={styles.waveTime}>{clock(duration)}</span>
      </div>
      <div className={styles.transport}>
        {audioUrl ? (
          <button type="button" className={styles.round} onClick={() => setMuted((value) => !value)} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted}>
            <Icon name="volume" size={16} />
          </button>
        ) : null}
        <button type="button" className={styles.round} onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)} aria-label={`Speed ${speed}×`}>
          {speed}×
        </button>
        <span className={styles.grow} />
        <button type="button" className={styles.round} onClick={() => seek(position - 15_000)} aria-label="Back 15 seconds">
          <Icon name="skipBack" size={16} />
        </button>
        <button type="button" className={styles.playBtn} onClick={toggle} aria-label={playing ? "Pause" : "Play"} disabled={segments.length === 0 && !audioUrl}>
          <Icon name={playing ? "pause" : "play"} size={18} strokeWidth={2.2} />
        </button>
        <button type="button" className={styles.round} onClick={() => seek(position + 15_000)} aria-label="Forward 15 seconds">
          <Icon name="skipForward" size={16} />
        </button>
        <span className={styles.grow} />
        <button type="button" className={styles.round} onClick={props.onDownload} aria-label={props.downloadLabel} title={props.downloadLabel}>
          <Icon name="download" size={16} />
        </button>
      </div>
      {props.note ? <p className={styles.note}>{props.note}</p> : null}
    </div>
  );
});
