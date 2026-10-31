import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchModels, USER_AGENT, type ChatModel } from "./catalog.ts";
import { isInsecureRemote, literalApiKey, loadConfig, saveConfig, validateConfig, type Config } from "./config.ts";

/** Kept separate from the entry point so tests do not need to load Pi's runtime. */
export async function registerMagpie(pi: ExtensionAPI, configPath: string): Promise<void> {
  let current: Config | undefined;
  let count = 0;
  let startupError: string | undefined;
  let busy = false;

  function install(config: Config, models: ChatModel[]) {
    pi.registerProvider("magpie", {
      name: "Magpie",
      baseUrl: config.baseUrl,
      apiKey: literalApiKey(config.apiKey),
      // Magpie translates all upstream APIs, including routing groups, to Chat.
      // Reuse Pi's implementation for streaming, tool calls, images and aborts.
      api: "openai-completions",
      headers: { "User-Agent": USER_AGENT },
      models,
      refreshModels: async ({ signal }) => {
        const next = await fetchModels(config, signal);
        if (current === config) count = next.length;
        return next;
      },
    });
    current = config;
    count = models.length;
    startupError = undefined;
  }

  async function refresh() {
    const config = await loadConfig(configPath);
    if (!config) throw new Error("尚未配置 Magpie。运行 /magpie setup，或设置 MAGPIE_BASE_URL 和 MAGPIE_API_KEY。");
    const models = await fetchModels(config);
    install(config, models);
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
          ? `Magpie：${current.baseUrl}\n已加载 ${count} 个聊天模型。密钥已配置（不显示）。`
          : startupError ?? "尚未配置 Magpie。运行 /magpie setup。", current ? "info" : "warning");
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
          const models = await fetchModels(config);
          // Only persist a configuration after successful authentication/discovery.
          await saveConfig(configPath, config);
          install(config, models);
        } else {
          await refresh();
        }
        notifyConnected(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Magpie 连接失败。", "error");
      } finally {
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

  try {
    const config = await loadConfig(configPath);
    if (config) install(config, await fetchModels(config));
  } catch (error) {
    // An unavailable VPS must not prevent Pi's other providers from starting.
    startupError = error instanceof Error ? error.message : "Magpie 初始化失败。";
  }
}
