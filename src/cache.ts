import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { object, type ChatModel } from "./catalog.ts";
import type { Config } from "./config.ts";

export interface ModelCache {
  updatedAt: string;
  models: ChatModel[];
}

function fingerprint(config: Config): string {
  return createHash("sha256").update(JSON.stringify([config.baseUrl, config.apiKey])).digest("hex");
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate cached metadata and whitelist fields; never restore endpoints or credentials. */
function parseModels(value: unknown): ChatModel[] {
  if (!Array.isArray(value)) throw new Error();
  const seen = new Set<string>();
  return value.map((entry) => {
    const model = object(entry);
    const cost = object(model?.cost);
    if (!model || typeof model.id !== "string" || !model.id.trim() || seen.has(model.id)
      || typeof model.name !== "string" || typeof model.reasoning !== "boolean"
      || !Array.isArray(model.input) || !model.input.includes("text")
      || !model.input.every((input) => input === "text" || input === "image")
      || !positive(model.contextWindow) || !positive(model.maxTokens)
      || (model.maxTokens as number) > (model.contextWindow as number)
      || !cost || !["input", "output", "cacheRead", "cacheWrite"].every((key) =>
        typeof cost[key] === "number" && Number.isFinite(cost[key]) && cost[key] >= 0)) {
      throw new Error();
    }
    const levels = model.thinkingLevelMap;
    const levelMap = object(levels);
    if (levels !== undefined && (!levelMap || !Object.entries(levelMap).every(([key, effort]) =>
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key)
      && (effort === null || (typeof effort === "string" && effort.length > 0))))) {
      throw new Error();
    }
    seen.add(model.id);
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite },
      ...(levels === undefined ? {} : { thinkingLevelMap: levels }),
    } as ChatModel;
  });
}

export async function loadModelCache(path: string, config: Config): Promise<ModelCache | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Only absence is optional; other I/O failures retain their cause.
    throw new Error("无法读取 Magpie 模型缓存，请运行 /magpie refresh。", { cause: error });
  }
  try {
    const data = object(JSON.parse(text));
    if (!data || data.version !== 1) throw new Error();
    // A different endpoint or credential must never inherit another account's catalog.
    if (data.fingerprint !== fingerprint(config)) return undefined;
    if (typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error();
    return { updatedAt: data.updatedAt, models: parseModels(data.models) };
  } catch (error) {
    // Decode boundary: fail loudly without echoing untrusted cache contents.
    throw new Error("Magpie 模型缓存无效，请运行 /magpie refresh 重建。", { cause: error });
  }
}

/** Atomic private snapshot: no gateway key or complete server response is stored. */
export async function saveModelCache(path: string, config: Config, cache: ModelCache): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const models = parseModels(cache.models);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify({
      version: 1, fingerprint: fingerprint(config), updatedAt: cache.updatedAt, models,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    // A failed write/rename may leave a private snapshot behind. Missing files
    // are tolerated by force; unexpected cleanup failures must also be reported.
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new Error("无法保存且无法清理 Magpie 模型缓存临时文件，请检查配置目录权限。", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw new Error("无法保存 Magpie 模型缓存，请检查配置目录权限后运行 /magpie refresh。", { cause: error });
  }
}
