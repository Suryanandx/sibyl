/**
 * The GPT Realtime voice for a persona: an agent's explicit choice, else the
 * closest to its Sibyl voice (Kokoro / ElevenLabs / Gemini names) and style.
 */
import { REALTIME_VOICES } from "@open-gpt-live/protocol";

const FEMININE = /^(a|b)f_|^(sarah|rachel|bella|alice|aria|charlotte|domi|elli|emily|grace|jessica|laura|lily|matilda|nicole|serena|kore|aoede|leda|zephyr|callirrhoe|autonoe|despina|erinome|laomedeia|pulcherrima|vindemiatrix|sulafat|achernar|gacrux|nova|shimmer|coral|marin|sage|ballad)/i;
const MASCULINE = /^(a|b)m_|^(adam|antoni|arnold|bill|brian|callum|charlie|chris|daniel|dave|drew|eric|george|harry|james|josh|liam|michael|sam|will|puck|charon|fenrir|orus|enceladus|iapetus|umbriel|algieba|algenib|rasalgethi|alnilam|schedar|achird|zubenelgenubi|sadachbia|sadaltager|onyx|echo|ash|cedar|verse|alloy)/i;

export function isRealtimeVoice(voice: string | undefined): boolean {
  return Boolean(voice && (REALTIME_VOICES as readonly string[]).includes(voice));
}

/** Pick the GPT Realtime voice closest to a Sibyl voice name and style ("warm, upbeat"). */
export function closestRealtimeVoice(input: { ttsVoice?: string; style?: string; fallback: string }): string {
  if (input.ttsVoice && isRealtimeVoice(input.ttsVoice)) return input.ttsVoice;
  const name = input.ttsVoice?.trim() ?? "";
  const style = input.style?.toLowerCase() ?? "";
  const gender = MASCULINE.test(name) ? "m" : FEMININE.test(name) ? "f" : undefined;
  const calm = /calm|soft|gentle|quiet|soothing|serene/.test(style);
  const bright = /upbeat|energetic|excited|bright|cheer|playful|lively/.test(style);
  const deep = /deep|authoritative|serious|formal|grave/.test(style);
  if (gender === "m") return bright ? "verse" : deep ? "ash" : calm ? "echo" : "cedar";
  if (gender === "f") return bright ? "coral" : calm ? "sage" : "marin";
  if (bright) return "coral";
  if (calm) return "sage";
  if (deep) return "cedar";
  return input.fallback;
}
