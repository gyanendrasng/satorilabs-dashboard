/**
 * LLM provider wrapper — single entry point for every LLM call in the dashboard.
 *
 * Modelled on `auto-gui2/services/llm_service.py`: a thin abstraction over an
 * OpenAI-compatible provider family (OpenAI / Groq / Together / DeepInfra /
 * RunPod) plus Google Gemini. Picks provider + model from env vars at module
 * load. Every call goes through the same `chat()` surface so callers don't
 * care which provider is live.
 *
 * --------------------------------------------------------------------------
 * ENV VARS
 * --------------------------------------------------------------------------
 *   LLM_PROVIDER     One of: openai | groq | together | deepinfra | runpod | gemini
 *                    (default: 'openai')
 *   LLM_MODEL        Model id. Defaults per provider — see DEFAULT_MODELS.
 *   LLM_TEMPERATURE  Float, default 0.7. Override per call via chat({temperature}).
 *   LLM_MAX_TOKENS   Int, default 16000. Override per call via chat({maxTokens}).
 *                    The planner emits long structured JSON (full step plan
 *                    + rationale + per-step args); anything under ~12000
 *                    truncates the JSON response mid-stream on multi-step
 *                    modify cycles and the Zod parse fails. Keep generous
 *                    unless you know your specific call is small.
 *
 *   API keys (read based on the active provider):
 *     OPENAI_API_KEY      — openai
 *     GROQ_API_KEY        — groq
 *     TOGETHER_API_KEY    — together
 *     DEEPINFRA_API_KEY   — deepinfra
 *     RUNPOD_API_KEY      — runpod
 *     GEMINI_API_KEY      — gemini
 *
 *   Optional overrides:
 *     LLM_BASE_URL  Override the base URL for OpenAI-compatible providers
 *                   (useful for runpod / self-hosted vLLM).
 *
 * Usage:
 *   const llm = getLlmService();
 *   const result = await llm.chat({
 *     messages: [{ role: 'system', content: '...' }, { role: 'user', content: '...' }],
 *     requireJson: true,
 *   });
 *   // result.text → string  (always present)
 *   // result.json → parsed JSON (only when requireJson=true)
 *   // result.usage → { inputTokens, outputTokens, totalTokens }
 */
import OpenAI from 'openai';
// Node built-ins are loaded lazily via `(0, eval)('require')` inside the
// Gemini provider's `getClient()` — see the comment block in there. Doing
// this at module top-level breaks `next build`'s page-data collection
// step, which evaluates the route module in an environment where `require`
// is not yet defined globally.

// `@google/genai` is loaded LAZILY in the Gemini provider constructor below
// (dynamic import). It is ESM-only and ships with conditional Node/web
// exports — a top-level static `import` makes Next.js' webpack server bundler
// try to resolve it at build time and fail with "Module not found", even when
// the package is listed in `serverExternalPackages`. Lazy-loading keeps the
// dependency optional: only Gemini users need it installed.
type GeminiClientType = import('@google/genai').GoogleGenAI;

export type LlmProvider =
  | 'openai'
  | 'groq'
  | 'together'
  | 'deepinfra'
  | 'runpod'
  | 'gemini';

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-4o',
  groq: 'meta-llama/llama-4-maverick-17b-128e-instruct',
  together: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  deepinfra: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
  runpod: 'default',
  gemini: 'gemini-2.5-flash',
};

const API_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  runpod: 'http://localhost:8501/v1',
  // gemini uses its own SDK; no base URL needed.
};

const API_KEY_ENV: Record<LlmProvider, string> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  runpod: 'RUNPOD_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const OPENAI_COMPATIBLE: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  'openai',
  'groq',
  'together',
  'deepinfra',
  'runpod',
]);

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatArgs {
  messages: LlmMessage[];
  /** When true, ask the provider for JSON output AND parse it. Default true. */
  requireJson?: boolean;
  /** Per-call override; falls back to LLM_TEMPERATURE env / 0.7. */
  temperature?: number;
  /** Per-call override; falls back to LLM_MAX_TOKENS env / 16000. */
  maxTokens?: number;
  /** Per-call model override (rare). Falls back to the configured LLM_MODEL. */
  modelOverride?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  /** Raw text from the model. Always present. */
  text: string;
  /** Parsed JSON. Only present when `requireJson` was true (default). */
  json?: unknown;
  /** Token usage as reported by the provider (zeros if unavailable). */
  usage: TokenUsage;
  /** Wall-clock duration of the API call in milliseconds. */
  durationMs: number;
  /** Provider + model that actually served the call (useful for logs). */
  provider: LlmProvider;
  model: string;
}

interface ResolvedConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  defaultTemperature: number;
  defaultMaxTokens: number;
}

function readConfig(): ResolvedConfig {
  const rawProvider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
  if (!isLlmProvider(rawProvider)) {
    throw new Error(
      `[llm-service] LLM_PROVIDER='${rawProvider}' is not supported. ` +
        `Valid values: openai, groq, together, deepinfra, runpod, gemini.`,
    );
  }
  const provider = rawProvider;
  const model = process.env.LLM_MODEL || DEFAULT_MODELS[provider];

  const apiKeyEnv = API_KEY_ENV[provider];
  const apiKey = process.env[apiKeyEnv] ?? '';
  if (!apiKey) {
    throw new Error(
      `[llm-service] LLM_PROVIDER='${provider}' is selected but ${apiKeyEnv} is not set.`,
    );
  }

  const baseUrl = process.env.LLM_BASE_URL || API_BASE_URLS[provider];

  const tempStr = process.env.LLM_TEMPERATURE;
  const defaultTemperature = tempStr !== undefined ? Number(tempStr) : 0.7;
  if (!Number.isFinite(defaultTemperature)) {
    throw new Error(
      `[llm-service] LLM_TEMPERATURE='${tempStr}' is not a finite number.`,
    );
  }

  const mtStr = process.env.LLM_MAX_TOKENS;
  // 16000 is the safe default — the planner's structured JSON output (step
  // list + rationale + nested per-step args) routinely runs past 4k tokens
  // on long modify cycles, and 12000 has truncated mid-stream on the more
  // verbose post-plant_ls assessment flows. Raise via LLM_MAX_TOKENS only if
  // you have a specific reason to go higher.
  const defaultMaxTokens = mtStr !== undefined ? Number(mtStr) : 16000;
  if (!Number.isFinite(defaultMaxTokens) || defaultMaxTokens <= 0) {
    throw new Error(
      `[llm-service] LLM_MAX_TOKENS='${mtStr}' must be a positive number.`,
    );
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    defaultTemperature,
    defaultMaxTokens: Math.floor(defaultMaxTokens),
  };
}

function isLlmProvider(s: string): s is LlmProvider {
  return (
    s === 'openai' ||
    s === 'groq' ||
    s === 'together' ||
    s === 'deepinfra' ||
    s === 'runpod' ||
    s === 'gemini'
  );
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

interface ProviderClient {
  chat(args: ChatArgs): Promise<ChatResult>;
}

class OpenAICompatibleClient implements ProviderClient {
  private readonly client: OpenAI;
  constructor(private readonly cfg: ResolvedConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    const start = Date.now();
    const requireJson = args.requireJson ?? true;
    const model = args.modelOverride || this.cfg.model;
    const maxTok = args.maxTokens ?? this.cfg.defaultMaxTokens;
    const temperature = args.temperature ?? this.cfg.defaultTemperature;

    // OpenAI's gpt-5.x / o-series models renamed `max_tokens` →
    // `max_completion_tokens` (sending the old name 400s) and only accept the
    // DEFAULT temperature (a custom value 400s). The other OpenAI-compatible
    // providers (groq, together, deepinfra, runpod) keep the classic
    // `max_tokens` + `temperature` shape. `max_completion_tokens` is accepted by
    // all current real-OpenAI chat models, so we send it for any `openai` model.
    const isOpenAI = this.cfg.provider === 'openai';
    const isReasoningModel = isOpenAI && /^(o\d|gpt-5)/i.test(model);

    const completion = await this.client.chat.completions.create({
      model,
      messages: args.messages,
      ...(isOpenAI ? { max_completion_tokens: maxTok } : { max_tokens: maxTok }),
      ...(isReasoningModel ? {} : { temperature }),
      ...(requireJson ? { response_format: { type: 'json_object' } as const } : {}),
    });

    const durationMs = Date.now() - start;
    const text = completion.choices[0]?.message?.content ?? '';
    const usage: TokenUsage = {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    };

    return buildResult({
      text,
      requireJson,
      usage,
      durationMs,
      provider: this.cfg.provider,
      model,
    });
  }
}

class GeminiClient implements ProviderClient {
  private client: GeminiClientType | null = null;
  constructor(private readonly cfg: ResolvedConfig) {}

  private async getClient(): Promise<GeminiClientType> {
    if (this.client) return this.client;
    // Resolving @google/genai at runtime from a webpack-bundled Next.js server
    // chunk is fiddly:
    //   - A bare static `import '@google/genai'` makes webpack try to bundle
    //     it at build time and fails ("Module not found") because the package
    //     is ESM-only with conditional exports.
    //   - A dynamic `await import('@google/genai')` from the chunk resolves
    //     from .next/server/chunks/ (no node_modules there) — fails at run.
    //   - createRequire(process.cwd()) breaks when the process is started via
    //     PM2/systemd from a different cwd.
    //   - require('@google/genai/dist/node/index.cjs') is blocked by the
    //     package's `exports` field (deep paths aren't whitelisted).
    //   - `await import('node:path')` / `await import('node:fs')` inside a
    //     Next.js server chunk gets interop-wrapped so the named exports land
    //     as undefined ("a is not a function" / "(void 0) is not a function"
    //     boot crashes we hit earlier).
    //   - A top-level `(0, eval)('require')` evaluates during `next build`'s
    //     page-data collection, when `require` isn't defined globally yet.
    //   - Even a LAZY `(0, eval)('require')` inside this function fails under
    //     Turbopack (next dev/build --turbopack), which evaluates server code
    //     in a context where the `require` global isn't bound. The eval throws
    //     `ReferenceError: require is not defined`.
    //
    // The reliable path: `process.getBuiltinModule(...)`, a Node ≥22.12 API
    // designed exactly for this — it returns Node's real built-in modules
    // bypassing any bundler / loader / require shim. Since it's a method on
    // the `process` global, bundlers can't strip it.
    const nodeModule = process.getBuiltinModule('module') as typeof import('module');
    const { createRequire } = nodeModule;
    const nodePath = process.getBuiltinModule('path') as typeof import('path');
    const nodeFs = process.getBuiltinModule('fs') as typeof import('fs');

    // __dirname is unreliable in Next.js bundled chunks. Walk up from
    // process.cwd() AND from a few well-known prod roots until we find the
    // installed package. Most prod deploys keep node_modules at the repo
    // root, which is one of these candidates.
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addUpwards = (start: string) => {
      let dir = start;
      // Cap at 8 levels to avoid an infinite loop on a weird FS.
      for (let i = 0; i < 8; i++) {
        if (seen.has(dir)) break;
        seen.add(dir);
        candidates.push(nodePath.join(dir, 'node_modules/@google/genai/dist/node/index.cjs'));
        const parent = nodePath.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    };
    addUpwards(process.cwd());
    // Also try resolving from this module's own location if available
    // (CommonJS-compiled chunks expose __dirname; ESM doesn't, so guard it).
    if (typeof __dirname === 'string') addUpwards(__dirname);

    const cjsEntry = candidates.find((p) => {
      try {
        return nodeFs.statSync(p).isFile();
      } catch {
        return false;
      }
    });

    if (!cjsEntry) {
      throw new Error(
        `[llm-service] Could not locate @google/genai in node_modules. ` +
          `Looked under: ${candidates.slice(0, 4).join(', ')}${candidates.length > 4 ? ', ...' : ''}. ` +
          `Run \`npm install @google/genai\` at the app root.`,
      );
    }

    // Load the CJS file by absolute path. The `exports` field only gates
    // bare-specifier resolution; loading a literal filesystem path bypasses
    // it entirely, so this is safe regardless of how the package declares
    // its conditional exports.
    const requireFromHere = createRequire(cjsEntry);
    const mod = requireFromHere(cjsEntry);
    const client = new mod.GoogleGenAI({ apiKey: this.cfg.apiKey }) as GeminiClientType;
    this.client = client;
    return client;
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    const start = Date.now();
    const requireJson = args.requireJson ?? true;
    const model = args.modelOverride || this.cfg.model;
    const client = await this.getClient();

    // Gemini takes the system prompt as a top-level `systemInstruction`. Pull
    // it out of the messages list and forward the rest as `contents`.
    let systemInstruction = '';
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    for (const m of args.messages) {
      if (m.role === 'system') {
        // If multiple system messages are passed, concatenate. The planner
        // only sends one, but be defensive.
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${m.content}`
          : m.content;
        continue;
      }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }

    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        temperature: args.temperature ?? this.cfg.defaultTemperature,
        maxOutputTokens: args.maxTokens ?? this.cfg.defaultMaxTokens,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(requireJson ? { responseMimeType: 'application/json' } : {}),
      },
    });

    const durationMs = Date.now() - start;
    const text = response.text ?? '';
    const usage: TokenUsage = {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
    };

    return buildResult({
      text,
      requireJson,
      usage,
      durationMs,
      provider: this.cfg.provider,
      model,
    });
  }
}

function buildResult(args: {
  text: string;
  requireJson: boolean;
  usage: TokenUsage;
  durationMs: number;
  provider: LlmProvider;
  model: string;
}): ChatResult {
  const base: ChatResult = {
    text: args.text,
    usage: args.usage,
    durationMs: args.durationMs,
    provider: args.provider,
    model: args.model,
  };
  if (args.requireJson) {
    base.json = parseJsonStrict(args.text);
  }
  return base;
}

/**
 * Parse JSON from a model response. Tries strict parse first, then a fenced
 * code-block extraction, then a regex extraction. Throws if none of the three
 * yield valid JSON — the caller routes that into the planner-failure path
 * (re-plan on next tick).
 */
function parseJsonStrict(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('LLM returned empty content');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  // Strip fenced code blocks (```json ... ``` or ``` ... ```).
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  // Last resort: first {...} block.
  const obj = /\{[\s\S]*\}/.exec(trimmed);
  if (obj?.[0]) {
    try {
      return JSON.parse(obj[0]);
    } catch {
      // fall through
    }
  }
  throw new Error(
    `LLM response was not valid JSON: ${trimmed.slice(0, 200)}${trimmed.length > 200 ? '…' : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export class LlmService {
  private readonly client: ProviderClient;
  constructor(public readonly config: ResolvedConfig) {
    if (OPENAI_COMPATIBLE.has(config.provider)) {
      this.client = new OpenAICompatibleClient(config);
    } else if (config.provider === 'gemini') {
      this.client = new GeminiClient(config);
    } else {
      throw new Error(`[llm-service] unsupported provider: ${config.provider}`);
    }
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    return this.client.chat(args);
  }
}

let cached: LlmService | null = null;

/**
 * Returns the singleton LlmService bound to the env-configured provider.
 * The first call validates env + instantiates the SDK; subsequent calls reuse
 * the same instance. Tests that swap env vars can call `resetLlmService()` to
 * force re-resolution.
 */
export function getLlmService(): LlmService {
  if (cached === null) {
    cached = new LlmService(readConfig());
    console.log(
      `[llm-service] initialised: provider=${cached.config.provider} model=${cached.config.model}`,
    );
  }
  return cached;
}

/** For tests: drop the cached singleton so the next getLlmService() re-reads env. */
export function resetLlmService(): void {
  cached = null;
}
