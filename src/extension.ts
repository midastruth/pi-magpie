import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadModelCache, saveModelCache } from "./cache.ts";
import { fetchModels, USER_AGENT, type ChatModel } from "./catalog.ts";
import { isInsecureRemote, literalApiKey, loadConfig, saveConfig, validateConfig, type Config } from "./config.ts";

/** Kept separate from the entry point so tests do not need to load Pi's runtime. */
export async function registerMagpie(pi: ExtensionAPI, configPath: string): Promise<void> {
  // Pi retains providers across /reload, even if the new config/cache cannot load.
  pi.unregisterProvider("magpie");
  const cachePath = join(dirname(configPath), "magpie-models.json");
  let current: Config | undefined;
  let count = 0;
  let updatedAt: string | undefined;
  let startupError: string | undefined;
  let lastError: string | undefined;
  let busy = false;
  let request: AbortController | undefined;

  function install(config: Config, models: ChatModel[], timestamp: string) {
    // Registrations merge omitted fields, so remove legacy refreshModels callbacks.
    pi.unregisterProvider("magpie");
    pi.registerProvider("magpie", {
      name: "Magpie",
      baseUrl: config.baseUrl,
      apiKey: literalApiKey(config.apiKey),
      // Magpie translates all upstream APIs, including routing groups, to Chat.
      // Reuse Pi's implementation for streaming, tool calls, images and aborts.
      api: "openai-completions",
      headers: { "User-Agent": USER_AGENT },
      // Deliberately omit refreshModels: even Pi's automatic catalog refresh must
      // not contact Magpie. Only /magpie setup and /magpie refresh do discovery.
      models,
    });
    current = config;
    count = models.length;
    updatedAt = timestamp;
    startupError = undefined;
    lastError = undefined;
  }

  async function saveAndInstall(config: Config, models: ChatModel[], setup = false) {
    const timestamp = new Date().toISOString();
    const previous = setup ? await loadConfig(configPath) : undefined;
    if (setup) await saveConfig(configPath, config);
    try {
      // Do not replace the working provider unless its new snapshot is durable.
      await saveModelCache(cachePath, config, { updatedAt: timestamp, models });
    } catch (error) {
      // Setup is the persistence boundary: a failed cache write must not commit
      // new credentials. Report both failures if restoring configuration also fails.
      if (setup) {
        try {
          if (previous) await saveConfig(configPath, previous);
          else await rm(configPath);
        } catch (rollbackError) {
          throw new Error("Magpie 模型缓存保存失败，且无法恢复原配置，请检查配置目录权限。", {
            cause: new AggregateError([error, rollbackError]),
          });
        }
      }
      throw error;
    }
    install(config, models, timestamp);
  }

  async function refresh(signal: AbortSignal) {
    const config = await loadConfig(configPath);
    if (!config) throw new Error("尚未配置 Magpie。运行 /magpie setup，或设置 MAGPIE_BASE_URL 和 MAGPIE_API_KEY。");
    const models = await fetchModels(config, signal);
    await saveAndInstall(config, models);
  }

  function notifyConnected(ctx: ExtensionCommandContext) {
    ctx.ui.notify(`Magpie 已连接：${count} 个聊天模型。使用 /model 选择（搜索 magpie）。`, "info");
    if (current && isInsecureRemote(current)) {
      ctx.ui.notify("当前远程地址使用 HTTP，密钥和对话将明文传输。公网请使用 HTTPS 或 SSH 隧道。", "warning");
    }
  }

  pi.registerCommand("magpie", {
    description: "连接远程 Magpie：setup / refresh / status",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "status") {
        ctx.ui.notify(current
          ? `Magpie：${current.baseUrl}\n已加载 ${count} 个聊天模型。密钥已配置（不显示）。\n缓存更新时间：${updatedAt}\n仅手动刷新：/magpie refresh。${lastError ? `\n最近刷新失败：${lastError}` : ""}`
          : lastError ?? startupError ?? "尚未配置 Magpie。运行 /magpie setup。", current ? "info" : "warning");
        return;
      }
      if (command !== "setup" && command !== "refresh") {
        ctx.ui.notify("用法：/magpie setup | refresh | status。不要把密钥写进命令。", "info");
        return;
      }
      if (busy) {
        ctx.ui.notify("Magpie 正在连接，请稍候。", "warning");
        return;
      }
      busy = true;
      request = new AbortController();
      try {
        await ctx.waitForIdle();
        if (command === "setup") {
          if (!ctx.hasUI) throw new Error("无交互界面时请设置 MAGPIE_BASE_URL 和 MAGPIE_API_KEY。");
          if (process.env.MAGPIE_BASE_URL !== undefined || process.env.MAGPIE_API_KEY !== undefined) {
            throw new Error("环境变量优先于配置文件。请先移除 MAGPIE_BASE_URL / MAGPIE_API_KEY，再运行 setup；或修改变量后重启 Pi。");
          }
          const baseUrl = await ctx.ui.input("Magpie API 地址（根地址或以 /v1 结尾）", current?.baseUrl ?? "https://magpie.example.com");
          if (baseUrl === undefined) return;
          const apiKey = await ctx.ui.input("Magpie gateway key（此输入框不隐藏字符，请勿共享屏幕）");
          if (apiKey === undefined) return;
          const config = validateConfig({ baseUrl, apiKey });
          const models = await fetchModels(config, request.signal);
          // Only persist a configuration after successful authentication/discovery.
          await saveAndInstall(config, models, true);
        } else {
          await refresh(request.signal);
        }
        notifyConnected(ctx);
      } catch (error) {
        // Command boundary: discovery, validation and persistence failures become
        // a sanitized UI error; no failed command installs a replacement provider.
        lastError = error instanceof Error ? error.message : "Magpie 连接失败。";
        ctx.ui.notify(lastError, "error");
      } finally {
        request = undefined;
        busy = false;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (startupError) ctx.ui.notify(`Magpie：${startupError}\n可使用 /magpie setup 或 /magpie refresh 重试。`, "warning");
    else if (current && isInsecureRemote(current)) {
      ctx.ui.notify("Magpie 远程连接正在使用明文 HTTP，公网请改用 HTTPS 或 SSH 隧道。", "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    request?.abort();
  });

  try {
    const config = await loadConfig(configPath);
    if (config) {
      const cache = await loadModelCache(cachePath, config);
      if (cache) install(config, cache.models, cache.updatedAt);
      else startupError = "尚无匹配的本地模型缓存。请运行 /magpie refresh；启动不会自动联网。";
    }
  } catch (error) {
    // Startup boundary: report config/cache failures without stopping other providers.
    // The retained Magpie registration was already removed, so failure is closed.
    startupError = error instanceof Error ? error.message : "Magpie 初始化失败。";
  }
}
