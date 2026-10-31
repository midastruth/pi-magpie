import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Config {
  /** OpenAI-compatible base URL, always ending in /v1. */
  baseUrl: string;
  apiKey: string;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Magpie 地址无效，请填写完整的 http:// 或 https:// 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Magpie 地址只能使用 HTTP(S)，且不能包含用户名、密码、查询参数或片段。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString().replace(/\/$/, "");
}

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("Magpie 配置必须是 JSON 对象。");
  const { baseUrl, apiKey } = value as Record<string, unknown>;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error("请设置 Magpie baseUrl。");
  if (typeof apiKey !== "string" || !apiKey.trim() || /\s/.test(apiKey.trim())) {
    throw new Error("请设置有效的 Magpie gateway key（不能含空白字符）。");
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim() };
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<Config | undefined> {
  let saved: Record<string, unknown> = {};
  // A complete environment configuration needs no local file.
  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    let text: string | undefined;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取 Magpie 配置文件。");
    }
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        saved = parsed as Record<string, unknown>;
      } catch {
        throw new Error("Magpie 配置文件不是有效的 JSON 对象。");
      }
    }
  }
  const baseUrl = env.MAGPIE_BASE_URL ?? saved.baseUrl;
  const apiKey = env.MAGPIE_API_KEY ?? saved.apiKey;
  if (baseUrl === undefined && apiKey === undefined) return undefined;
  return validateConfig({ baseUrl, apiKey });
}

/** Atomic replacement; credentials never go to Pi settings, sessions or model files. */
export async function saveConfig(path: string, config: Config): Promise<void> {
  const valid = validateConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** ProviderConfig accepts interpolation and shell commands: keys must remain literal. */
export function literalApiKey(key: string): string {
  const escaped = key.replace(/\$/g, () => "$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export function isInsecureRemote(config: Config): boolean {
  const url = new URL(config.baseUrl);
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
