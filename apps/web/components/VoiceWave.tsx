"use client";

import type { VoiceState } from "./voice-state";

/**
 * Quiet monochrome voice indicator: five thin bars that follow the microphone
 * level while listening, sway while Sibyl speaks, and breathe while thinking.
 */
export function VoiceWave({ state, level }: { state: VoiceState; level: number }) {
  const amplitude = Math.min(1, level * 9);
  const shape = [0.45, 0.8, 1, 0.8, 0.45];
  return (
    <span className={`voiceWave ${state}`} aria-hidden>
      {shape.map((weight, index) => (
        <i
          key={index}
          style={
            state === "listening"
              ? { transform: `scaleY(${0.22 + amplitude * weight * 0.78})` }
              : { animationDelay: `${index * 0.12}s` }
          }
        />
      ))}
    </span>
  );
}
