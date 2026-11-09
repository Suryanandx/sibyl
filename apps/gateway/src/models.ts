import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ModelCatalog,
  ModelOption,
  SessionSettings,
  TtsModelOption
} from "@open-gpt-live/protocol";

/**
 * Shape of models.config.json. Every list is optional; missing lists fall back
 * to the env defaults (OPENAI_MODEL / STT_MODEL / TTS_MODEL / TTS_VOICE).
 *
 * {
 *   "llm": { "default": "google/gemini-3.8-flash", "models": [{ "id": "...", "label": "..." }] },
 *   "stt": { "default": "...", "models": [...] },
 *   "tts": { "default": "...", "models": [{ "id": "...", "label": "...", "voices": ["..."], "defaultVoice": "..." }] },
 *   "genUi": true,
 *   "speak": true
 * }
 */
export interface ModelsConfigFile {
  /** Audio-native "voice brain" models (live conversation mode). */
  voice?: ModelGroupConfig<ModelOption>;
  llm?: ModelGroupConfig<ModelOption>;
  stt?: ModelGroupConfig<ModelOption>;
  tts?: ModelGroupConfig<TtsModelOption>;
  genUi?: boolean;
  speak?: boolean;
}

interface ModelGroupConfig<T extends ModelOption> {
  default?: string;
  /** Request params applied to every model in the group (LLM only). */
  params?: Record<string, unknown>;
  models?: Array<(T & { params?: Record<string, unknown> }) | string>;
}

/**
 * Keep models the user listed in models.config.json available next to the
 * scout's picks (marked "pinned"), so hand-picked favourites never disappear.
 */
export function mergePinnedModels(
  target: ModelCatalog,
  pinned: ModelCatalog,
  enabled: boolean
): void {
  if (!enabled) return;
  const merge = <T extends ModelOption>(into: T[] | undefined, from: T[] | undefined): T[] => {
    const out = [...(into ?? [])];
    for (const option of from ?? []) {
      if (!out.some((existing) => existing.id === option.id)) {
        out.push({ ...option, description: ["pinned", option.description].filter(Boolean).join(" · ") });
      }
    }
    return out;
  };
  target.voice = merge(target.voice, pinned.voice);
  target.llm = merge(target.llm, pinned.llm);
  target.stt = merge(target.stt, pinned.stt);
  target.tts = merge(target.tts, pinned.tts);
}

export interface ResolvedModels {
  catalog: ModelCatalog;
  /**
   * Server-side extra request fields per LLM model id (never sent to the
   * browser), e.g. { "google/gemini-3.8-flash": { reasoning: { effort: "low" } } }.
   */
  llmParams: Record<string, Record<string, unknown>>;
  defaults: Partial<SessionSettings>;
  source: string;
}

export interface ModelEnvDefaults {
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice?: string;
}

/** Load the model catalog from MODELS_CONFIG_FILE / models.config.json, then env lists. */
export function loadModelCatalog(
  env: NodeJS.ProcessEnv,
  fallback: ModelEnvDefaults,
  cwd = process.cwd()
): ResolvedModels {
  const path = resolveModelsConfigPath(env, cwd);
  const file: ModelsConfigFile = path
    ? (parseModelsFile(readFileSync(path, "utf8"), path))
    : {};

  const llm = buildGroup(file.llm, parseEnvList(env.LLM_MODELS), fallback.llmModel);
  const stt = buildGroup(file.stt, parseEnvList(env.STT_MODELS), fallback.sttModel);
  const tts = buildGroup<TtsModelOption>(
    file.tts,
    parseEnvList(env.TTS_MODELS),
    fallback.ttsModel
  );

  // TTS_VOICE applies to the default TTS model when the config lists no voices.
  const defaultTts = tts.models.find((model) => model.id === tts.default);
  if (defaultTts && fallback.ttsVoice) {
    defaultTts.voices ??= [fallback.ttsVoice];
    defaultTts.defaultVoice ??= fallback.ttsVoice;
  }

  const voiceList = parseEnvList(env.VOICE_MODELS);
  const voice =
    file.voice?.models?.length || voiceList.length
      ? buildGroup(file.voice, voiceList, voiceList[0]?.id ?? "")
      : undefined;

  const llmParams: Record<string, Record<string, unknown>> = {};
  const collectParams = (
    group: ModelGroupConfig<ModelOption> | undefined,
    models: ModelOption[]
  ): void => {
    for (const model of models) {
      const entry = group?.models?.find(
        (item) => typeof item !== "string" && item.id === model.id
      );
      const own = typeof entry === "object" ? entry.params : undefined;
      if (group?.params || own) {
        llmParams[model.id] = { ...llmParams[model.id], ...group?.params, ...own };
      }
    }
  };
  collectParams(file.llm, llm.models);
  if (voice) collectParams(file.voice, voice.models);

  return {
    catalog: {
      ...(voice ? { voice: voice.models.map(publicOption) } : {}),
      llm: llm.models.map(publicOption),
      stt: stt.models.map(publicOption),
      tts: tts.models.map(publicOption)
    },
    llmParams,
    defaults: {
      llmModel: nonEmpty(env.OPENAI_MODEL) && llm.models.some((m) => m.id === env.OPENAI_MODEL?.trim())
        ? env.OPENAI_MODEL!.trim()
        : llm.default,
      ...(voice ? { voiceModel: voice.default } : {}),
      sttModel: stt.default,
      ttsModel: tts.default,
      ...(defaultTts?.defaultVoice ? { ttsVoice: defaultTts.defaultVoice } : {}),
      ...(file.genUi === undefined ? {} : { genUi: file.genUi }),
      ...(file.speak === undefined ? {} : { speak: file.speak })
    },
    source: path ?? "env"
  };
}

/**
 * Fill missing TTS voice lists from OpenRouter's model catalog
 * (GET /models?output_modalities=speech exposes `supported_voices`).
 * Best effort: failures leave the catalog unchanged.
 */
export async function discoverOpenRouterVoices(
  catalog: ModelCatalog,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000
): Promise<number> {
  const missing = catalog.tts.filter((model) => !model.voices || model.voices.length <= 1);
  if (missing.length === 0) return 0;

  const response = await fetchImpl(
    `${baseUrl.replace(/\/+$/, "")}/models?output_modalities=speech`,
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!response.ok) return 0;
  const body = (await response.json()) as {
    data?: Array<{ id?: string; canonical_slug?: string; supported_voices?: unknown }>;
  };

  let updated = 0;
  for (const model of missing) {
    const match = body.data?.find(
      (entry) => entry.id === model.id || entry.canonical_slug === model.id
    );
    const voices = Array.isArray(match?.supported_voices)
      ? match.supported_voices.filter((voice): voice is string => typeof voice === "string")
      : [];
    if (voices.length === 0) continue;
    const preferred = model.defaultVoice;
    model.voices = voices;
    model.defaultVoice = preferred && voices.includes(preferred) ? preferred : voices[0];
    updated += 1;
  }
  return updated;
}

/** Only fields the browser needs; server-side params stay private. */
function publicOption<T extends ModelOption>(option: T & { params?: unknown }): T {
  const { params: _params, ...rest } = option;
  return rest as unknown as T;
}

function resolveModelsConfigPath(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const explicit = nonEmpty(env.MODELS_CONFIG_FILE);
  const candidates = explicit
    ? [isAbsolute(explicit) ? explicit : resolve(env.INIT_CWD ?? cwd, explicit), resolve(cwd, explicit), resolve(cwd, "../..", explicit)]
    : [
        env.INIT_CWD ? resolve(env.INIT_CWD, "models.config.json") : undefined,
        resolve(cwd, "models.config.json"),
        resolve(cwd, "../../models.config.json"),
        // Fall back to the checked-in example so a fresh clone has a model picker.
        env.INIT_CWD ? resolve(env.INIT_CWD, "models.config.example.json") : undefined,
        resolve(cwd, "models.config.example.json"),
        resolve(cwd, "../../models.config.example.json")
      ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (explicit) {
    throw new Error(`MODELS_CONFIG_FILE not found: ${explicit}`);
  }
  return undefined;
}

function parseModelsFile(raw: string, path: string): ModelsConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as ModelsConfigFile;
}

function buildGroup<T extends ModelOption>(
  group: ModelGroupConfig<T> | undefined,
  envList: Array<{ id: string; label?: string }>,
  fallbackId: string
): { models: T[]; default: string } {
  const models: T[] = [];
  const add = (entry: T | string | { id: string; label?: string }): void => {
    const option = (typeof entry === "string" ? { id: entry } : { ...entry }) as T;
    if (!option.id || typeof option.id !== "string") {
      throw new Error("Every model entry needs a string id");
    }
    option.label ||= labelFor(option.id);
    if (!models.some((model) => model.id === option.id)) models.push(option);
  };

  for (const entry of group?.models ?? []) add(entry);
  for (const entry of envList) add(entry);

  const defaultId = group?.default ?? models[0]?.id ?? fallbackId;
  if (!models.some((model) => model.id === defaultId)) {
    add({ id: defaultId });
    // Keep the default first so it is the obvious choice in the UI.
    models.unshift(models.pop()!);
  }
  return { models, default: defaultId };
}

/** "id" or "id|Label" entries separated by commas. */
function parseEnvList(value: string | undefined): Array<{ id: string; label?: string }> {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id = "", label] = entry.split("|").map((part) => part.trim());
      return label ? { id, label } : { id };
    });
}

function labelFor(id: string): string {
  const name = id.split("/").pop() ?? id;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
