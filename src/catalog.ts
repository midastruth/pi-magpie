import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

export const USER_AGENT = "pi-magpie/0.1.0";
export type ChatModel = Extract<ProviderModelConfig, { reasoning: boolean }>;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function price(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const parsed = Number(value);
  // Magpie uses OpenRouter's per-token prices; Pi uses per-million prices.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : 0;
}

export function parseCatalog(data: unknown): ChatModel[] {
  const entries = object(data)?.data;
  if (!Array.isArray(entries)) throw new Error("Magpie /v1/models 返回格式无效（缺少 data 数组）。");
  const models: ChatModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const m = object(entry);
    if (!m || typeof m.id !== "string" || !m.id.trim() || seen.has(m.id)) continue;
    const modalities = object(m.modalities);
    const output = strings(modalities?.output);
    if (m.type === "image" || m.type === "classifier" || (output.length > 0 && !output.includes("text"))) continue;
    if (strings(m.native_endpoints).includes("/v1/systemone")) continue;
    const efforts = strings(m.reasoning_levels);
    if (!efforts.length && Array.isArray(m.supported_reasoning_levels)) {
      for (const level of m.supported_reasoning_levels) {
        const effort = typeof level === "string" ? level : object(level)?.effort;
        if (typeof effort === "string") efforts.push(effort);
      }
    }
    const thinkingLevelMap: NonNullable<ChatModel["thinkingLevelMap"]> = {};
    for (const level of LEVELS) {
      thinkingLevelMap[level] = efforts.find((effort) => effort === (level === "off" ? "none" : level)) ?? null;
    }
    const pricing = object(m.pricing);
    const contextWindow = positive(m.context_window, positive(m.context_length, 128000));
    models.push({
      id: m.id,
      name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
      reasoning: m.reasoning === true || efforts.some((e) => e !== "none"),
      ...(efforts.length ? { thinkingLevelMap } : {}),
      input: strings(modalities?.input).includes("image") ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens: Math.min(positive(m.max_output_tokens, 16384), contextWindow),
      cost: {
        input: price(pricing?.prompt),
        output: price(pricing?.completion),
        cacheRead: price(pricing?.input_cache_read),
        cacheWrite: price(pricing?.input_cache_write),
      },
    });
    seen.add(m.id);
  }
  return models;
}

export async function fetchModels(config: Config, signal?: AbortSignal, timeoutMs = 10000): Promise<ChatModel[]> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}`, "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: combined,
      // Do not follow a redirect with a gateway credential attached.
      redirect: "error",
    });
  } catch {
    if (signal?.aborted) throw new Error("Magpie 模型刷新已取消。");
    if (timeout.aborted) throw new Error("连接 Magpie 超时，请检查 VPS 地址和网络。");
    throw new Error("无法连接 Magpie，请检查地址、TLS 证书、网络，以及是否发生了重定向。");
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? "请检查 gateway key、远程访问设置和模型权限。" : "请检查 Magpie 服务和反向代理。";
    // Never echo a server body: it may contain credentials or an entire HTML page.
    throw new Error(`Magpie 模型列表请求失败（HTTP ${response.status}）。${hint}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (signal?.aborted) throw new Error("Magpie 模型刷新已取消。");
    if (timeout.aborted) throw new Error("读取 Magpie 模型列表超时。");
    throw new Error("Magpie 模型列表不是有效 JSON，请检查 API 地址。");
  }
  return parseCatalog(data);
}
