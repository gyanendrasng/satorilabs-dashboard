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
 *   LLM_MAX_TOKENS   Int, default 4096. Override per call via chat({maxTokens}).
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
import { GoogleGenAI } from '@google/genai';

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
  /** Per-call override; falls back to LLM_MAX_TOKENS env / 4096. */
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
  const defaultMaxTokens = mtStr !== undefined ? Number(mtStr) : 4096;
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

    const completion = await this.client.chat.completions.create({
      model,
      messages: args.messages,
      max_tokens: args.maxTokens ?? this.cfg.defaultMaxTokens,
      temperature: args.temperature ?? this.cfg.defaultTemperature,
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
  private readonly client: GoogleGenAI;
  constructor(private readonly cfg: ResolvedConfig) {
    this.client = new GoogleGenAI({ apiKey: cfg.apiKey });
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    const start = Date.now();
    const requireJson = args.requireJson ?? true;
    const model = args.modelOverride || this.cfg.model;

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

    const response = await this.client.models.generateContent({
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
