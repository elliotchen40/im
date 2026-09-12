import type { ModelConfig } from "./chat.js";

export interface ModelEntry {
  name: string;
  config: ModelConfig;
}

export interface ModelsRegistry {
  /** Ordered list of all configured models. Order: single-model first if present, then multi-model in env-iteration order. */
  entries: ModelEntry[];
  /** Name of the default model to use on startup. */
  defaultName: string;
  /** Convenience: Map from lower-case name to entry. */
  byName: Map<string, ModelEntry>;
}

const MODEL_ENV_PREFIX = "MODEL_";
const MODEL_ENV_KEY_SUFFIX = "_API_KEY";

/** Default context-window size (tokens) for an unlabeled / generic model. */
const DEFAULT_CONTEXT_LIMIT = 16384;

function defaultContextLimitFor(modelId: string): number {
  const m = modelId.toLowerCase();
  if (m.startsWith("deepseek")) return 1048576;  // deepseek: 1M tokens (per Elliot 2026-09-03)
  if (m.startsWith("minimax")) return 1048576;   // minimax:  1M tokens (per Elliot 2026-09-03)
  return DEFAULT_CONTEXT_LIMIT;
}

function parseContextLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function isValidName(s: string): boolean {
  // Name must be non-empty after stripping prefix; allow alnum/_/-
  if (!s) return false;
  return /^[A-Z0-9_-]+$/.test(s);
}

function hasAnyMultiModelEnv(env: NodeJS.ProcessEnv): boolean {
  for (const key of Object.keys(env)) {
    if (key.startsWith(MODEL_ENV_PREFIX) && key.endsWith(MODEL_ENV_KEY_SUFFIX)) {
      return true;
    }
  }
  return false;
}

function loadFromEnv(env: NodeJS.ProcessEnv): { entries: ModelEntry[]; defaultName: string } {
  const entries: ModelEntry[] = [];

  // Single-model mode: OPENAI_API_KEY (+ optional BASE_URL/MODEL)
  const singleKey = env.OPENAI_API_KEY;
  const singleBase = env.OPENAI_BASE_URL;
  const singleModel = env.OPENAI_MODEL;
  if (singleKey) {
    const resolvedModel = singleModel || "gpt-4o";
    entries.push({
      name: "default",
      config: {
        apiKey: singleKey,
        baseURL: singleBase || undefined,
        model: resolvedModel,
        contextLimit:
          parseContextLimit(env.OPENAI_CONTEXT_LIMIT) ??
          defaultContextLimitFor(resolvedModel),
      },
    });
  }

  // Multi-model mode: scan MODEL_<NAME>_API_KEY (one entry per unique NAME)
  if (hasAnyMultiModelEnv(env)) {
    const seen = new Set<string>();
    // Sort keys for deterministic ordering across Node versions / platforms.
    const keys = Object.keys(env)
      .filter((k) => k.startsWith(MODEL_ENV_PREFIX) && k.endsWith(MODEL_ENV_KEY_SUFFIX))
      .sort();
    for (const key of keys) {
      const apiKey = env[key];
      if (!apiKey) continue;
      const rawName = key.slice(MODEL_ENV_PREFIX.length, key.length - MODEL_ENV_KEY_SUFFIX.length);
      if (!isValidName(rawName)) continue;
      const lower = rawName.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);

      const baseUrl = env[`MODEL_${rawName}_BASE_URL`];
      const modelName = env[`MODEL_${rawName}_MODEL`];
      const resolvedModel = modelName || "gpt-4o";

      entries.push({
        name: lower,
        config: {
          apiKey,
          baseURL: baseUrl || undefined,
          model: resolvedModel,
          contextLimit:
            parseContextLimit(env[`MODEL_${rawName}_CONTEXT_LIMIT`]) ??
            defaultContextLimitFor(resolvedModel),
        },
      });
    }
  }

  // Default selection:
  //  - If single-model entry exists → that's the default (legacy compat).
  //  - Otherwise → first multi-model entry.
  let defaultName: string;
  if (entries.length === 0) {
    defaultName = "";
  } else if (entries[0].name === "default") {
    defaultName = "default";
  } else {
    defaultName = entries[0].name;
  }

  return { entries, defaultName };
}

export function loadModels(env: NodeJS.ProcessEnv = process.env): ModelsRegistry {
  const { entries, defaultName } = loadFromEnv(env);
  if (entries.length === 0) {
    throw new Error(
      "未配置任何模型：请在 .env 中设置 OPENAI_API_KEY 或至少一个 MODEL_<NAME>_API_KEY",
    );
  }
  const byName = new Map<string, ModelEntry>();
  for (const e of entries) {
    byName.set(e.name, e);
  }
  return { entries, defaultName, byName };
}
