import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRuntime, type ExtensionAPI, type ExtensionCommandContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerMagpie } from "../src/extension.ts";
import { loadModelCache, saveModelCache } from "../src/cache.ts";
import { parseCatalog } from "../src/catalog.ts";
import { saveConfig } from "../src/config.ts";
import { serve } from "./helpers.ts";

async function fixture(t: TestContext, realRuntime = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-magpie-extension-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = realRuntime ? await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
  }) : undefined;
  // Each test file runs in an isolated process; tests here run sequentially.
  const previous = { url: process.env.MAGPIE_BASE_URL, key: process.env.MAGPIE_API_KEY };
  delete process.env.MAGPIE_BASE_URL;
  delete process.env.MAGPIE_API_KEY;
  t.after(() => {
    if (previous.url !== undefined) process.env.MAGPIE_BASE_URL = previous.url; else delete process.env.MAGPIE_BASE_URL;
    if (previous.key !== undefined) process.env.MAGPIE_API_KEY = previous.key; else delete process.env.MAGPIE_API_KEY;
  });
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const providers: { name: string; config: ProviderConfig }[] = [];
  const notices: string[] = [];
  const inputs: (string | undefined)[] = [];
  const shutdown: (() => Promise<void>)[] = [];
  const pi = {
    registerCommand: (name: string, config: { handler: typeof handler }) => { assert.equal(name, "magpie"); handler = config.handler; },
    registerProvider: (name: string, config: ProviderConfig) => {
      providers.push({ name, config });
      runtime?.registerProvider(name, config);
    },
    unregisterProvider: (name: string) => { runtime?.unregisterProvider(name); },
    on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown.push(handler); },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    waitForIdle: async () => {},
    ui: { notify: (message: string) => notices.push(message), input: async () => inputs.shift() },
  } as unknown as ExtensionCommandContext;
  return { path: join(dir, "magpie.json"), cachePath: join(dir, "magpie-models.json"), runtime, providers, notices, inputs, pi, ctx, shutdown, run: (args: string) => handler(args, ctx) };
}

test("unconfigured plugin installs no provider and offers setup", async (t) => {
  const f = await fixture(t);
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, 0);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /setup/);
});

test("startup is cache-only; manual refresh persists models and failed refresh preserves them", async (t) => {
  const f = await fixture(t);
  let fail = false;
  let requests = 0;
  const baseUrl = await serve(t, (_req, res) => {
    requests++;
    if (fail) { res.writeHead(401); res.end("private-secret"); }
    else res.end(JSON.stringify({ data: [{ id: "vendor/chat" }] }));
  });
  await saveConfig(f.path, { baseUrl, apiKey: "private-secret" });
  await registerMagpie(f.pi, f.path);
  assert.equal(requests, 0);
  assert.equal(f.providers.length, 0);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /magpie refresh/);
  await f.run("refresh");
  assert.equal(requests, 1);
  assert.equal(f.providers.length, 1);
  assert.equal(f.providers[0].name, "magpie");
  assert.equal(f.providers[0].config.api, "openai-completions");
  assert.equal(f.providers[0].config.models?.[0].id, "vendor/chat");
  assert.equal(f.providers[0].config.refreshModels, undefined);
  const cache = await readFile(f.cachePath, "utf8");
  assert.ok(!cache.includes("private-secret"));
  await f.run("status");
  assert.match(f.notices.at(-1)!, /缓存更新时间/);
  fail = true;
  await f.run("refresh");
  assert.equal(f.providers.length, 1);
  assert.match(f.notices.at(-1)!, /401/);
  assert.equal(await readFile(f.cachePath, "utf8"), cache);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /最近刷新失败.*401/);
  assert.ok(!f.notices.join(" ").includes("private-secret"));
  // Reload with an unavailable gateway must still use the snapshot, with no request.
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, 2);
  assert.equal(requests, 2);
  assert.equal(f.providers[1].config.models?.[0].id, "vendor/chat");
});

test("missing or corrupt cache never triggers network requests and can be rebuilt manually", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const baseUrl = await serve(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ id: "vendor/chat" }] }));
  });
  await saveConfig(f.path, { baseUrl, apiKey: "test" });
  await writeFile(f.cachePath, "broken-private-secret");
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, 0);
  assert.equal(requests, 0);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /缓存无效/);
  assert.ok(!f.notices.at(-1)!.includes("private-secret"));
  await f.run("refresh");
  assert.equal(requests, 1);
  assert.equal(f.providers.length, 1);
});

test("interactive setup verifies, privately saves and installs the provider", async (t) => {
  const f = await fixture(t);
  const baseUrl = await serve(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: "group/code" }] })));
  await registerMagpie(f.pi, f.path);
  f.inputs.push(baseUrl, "test-secret");
  await f.run("setup");
  assert.equal(f.providers.length, 1);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).apiKey, "test-secret");
  const cache = await loadModelCache(f.cachePath, { baseUrl, apiKey: "test-secret" });
  assert.equal(cache?.models[0].id, "group/code");
  assert.ok(!f.notices.join(" ").includes("test-secret"));
  assert.match(f.notices[0], /1 个/);
});

test("canceled/failed setup does not persist credentials", async (t) => {
  const f = await fixture(t);
  await registerMagpie(f.pi, f.path);
  f.inputs.push(undefined);
  await f.run("setup");
  f.inputs.push("https://host", undefined);
  await f.run("setup");
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(403); res.end(); });
  f.inputs.push(baseUrl, "bad-key");
  await f.run("setup");
  assert.equal(f.providers.length, 0);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("non-interactive setup and environment shadowing give actionable errors", async (t) => {
  const f = await fixture(t);
  await registerMagpie(f.pi, f.path);
  (f.ctx as { hasUI: boolean }).hasUI = false;
  await f.run("setup");
  assert.match(f.notices.at(-1)!, /MAGPIE_BASE_URL/);
  (f.ctx as { hasUI: boolean }).hasUI = true;
  process.env.MAGPIE_API_KEY = "from-environment";
  await f.run("setup");
  assert.match(f.notices.at(-1)!, /环境变量/);
  await f.run("unknown");
  assert.match(f.notices.at(-1)!, /用法/);
});

test("successful manual refresh replaces models and survives restart", async (t) => {
  const f = await fixture(t);
  let id = "vendor/old";
  let requests = 0;
  const baseUrl = await serve(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ id }] }));
  });
  await saveConfig(f.path, { baseUrl, apiKey: "test" });
  await registerMagpie(f.pi, f.path);
  await f.run("refresh");
  id = "vendor/new";
  await f.run("refresh");
  assert.equal(f.providers.at(-1)!.config.models?.[0].id, id);
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.at(-1)!.config.models?.[0].id, id);
  assert.equal(requests, 2);
  // Changing the credential must not load the previous account's models.
  await saveConfig(f.path, { baseUrl, apiKey: "new-key" });
  const before = f.providers.length;
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, before);
  assert.equal(requests, 2);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /匹配.*缓存/);
});

test("duplicate refreshes are rejected and shutdown cancels an in-flight discovery", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  const received = new Promise<void>((resolve) => { started = resolve; });
  const baseUrl = await serve(t, () => { started(); });
  await saveConfig(f.path, { baseUrl, apiKey: "test" });
  await registerMagpie(f.pi, f.path);
  const refresh = f.run("refresh");
  await received;
  await f.run("refresh");
  assert.match(f.notices.at(-1)!, /正在连接/);
  await f.shutdown[0]();
  await refresh;
  assert.equal(f.providers.length, 0);
  assert.match(f.notices.at(-1)!, /取消/);
  await assert.rejects(readFile(f.cachePath), { code: "ENOENT" });
});

test("reload removes the real SDK's retained provider when config/cache is rejected", async (t) => {
  for (const change of ["endpoint", "credential", "missing-cache", "invalid-cache", "missing-config", "invalid-config"]) {
    await t.test(change, async (t) => {
      const f = await fixture(t, true);
      let requests = 0;
      const baseUrl = await serve(t, (_req, res) => { requests++; res.end("{}"); });
      const config = { baseUrl, apiKey: "old-key" };
      await saveConfig(f.path, config);
      await saveModelCache(f.cachePath, config, {
        updatedAt: new Date().toISOString(), models: parseCatalog({ data: [{ id: "old-model" }] }),
      });
      await registerMagpie(f.pi, f.path);
      assert.equal(f.runtime!.getModels("magpie").length, 1);
      if (change === "endpoint") await saveConfig(f.path, { ...config, baseUrl: `${baseUrl}/other` });
      if (change === "credential") await saveConfig(f.path, { ...config, apiKey: "new-key" });
      if (change === "missing-cache") await rm(f.cachePath);
      if (change === "invalid-cache") await writeFile(f.cachePath, "invalid JSON");
      if (change === "missing-config") await rm(f.path);
      if (change === "invalid-config") await writeFile(f.path, "invalid JSON");
      await registerMagpie(f.pi, f.path);
      assert.equal(f.runtime!.getRegisteredProviderConfig("magpie"), undefined);
      assert.equal(f.runtime!.getProvider("magpie"), undefined);
      assert.equal(f.runtime!.getModels("magpie").length, 0);
      assert.equal(requests, 0);
    });
  }
});

test("reload and manual replacement remove legacy refreshModels in the real SDK", async (t) => {
  const f = await fixture(t, true);
  let requests = 0;
  let legacyCalls = 0;
  const baseUrl = await serve(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ id: "new-model" }] }));
  });
  const config = { baseUrl, apiKey: "test" };
  const models = parseCatalog({ data: [{ id: "cached-model" }] });
  const legacy: ProviderConfig = {
    ...config, api: "openai-completions", models,
    refreshModels: async () => { legacyCalls++; return models; },
  };
  await saveConfig(f.path, config);
  await saveModelCache(f.cachePath, config, { updatedAt: new Date().toISOString(), models });
  f.runtime!.registerProvider("magpie", legacy);
  await registerMagpie(f.pi, f.path);
  assert.equal(f.runtime!.getRegisteredProviderConfig("magpie")?.refreshModels, undefined);
  await f.runtime!.refresh({ allowNetwork: true, providers: ["magpie"] });
  assert.equal(legacyCalls, 0);
  assert.equal(requests, 0);
  // Manual discovery must keep Pi's automatic refresh network-free as well.
  await f.run("refresh");
  assert.equal(f.runtime!.getRegisteredProviderConfig("magpie")?.refreshModels, undefined);
  await f.runtime!.refresh({ allowNetwork: true, providers: ["magpie"] });
  assert.equal(legacyCalls, 0);
  assert.equal(requests, 1);
  assert.equal(f.runtime!.getModels("magpie")[0].id, "new-model");
});

test("failed setup cache persistence restores previous config, cache and active provider", async (t) => {
  const f = await fixture(t, true);
  const baseUrl = await serve(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: "new-model" }] })));
  const previous = { baseUrl, apiKey: "old-key" };
  await saveConfig(f.path, previous);
  await saveModelCache(f.cachePath, previous, {
    updatedAt: new Date().toISOString(), models: parseCatalog({ data: [{ id: "old-model" }] }),
  });
  const configBefore = await readFile(f.path, "utf8");
  const cacheBefore = await readFile(f.cachePath, "utf8");
  await registerMagpie(f.pi, f.path);
  const rename = fs.rename;
  const failure = Object.assign(new Error("cache destination denied"), { code: "EACCES" });
  const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    if (args[1] === f.cachePath) throw failure;
    return rename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  f.inputs.push(baseUrl, "new-key");
  await f.run("setup");
  assert.match(f.notices.at(-1)!, /无法保存/);
  assert.equal(await readFile(f.path, "utf8"), configBefore);
  assert.equal(await readFile(f.cachePath, "utf8"), cacheBefore);
  assert.equal(f.runtime!.getRegisteredProviderConfig("magpie")?.apiKey, "old-key");
  assert.equal(f.runtime!.getModels("magpie")[0].id, "old-model");
  await registerMagpie(f.pi, f.path);
  assert.equal(f.runtime!.getModels("magpie")[0].id, "old-model");
});

test("failed first setup removes newly saved config when the cache destination is a directory", async (t) => {
  const f = await fixture(t);
  const baseUrl = await serve(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: "new-model" }] })));
  await mkdir(f.cachePath);
  await registerMagpie(f.pi, f.path);
  f.inputs.push(baseUrl, "new-key");
  await f.run("setup");
  assert.match(f.notices.at(-1)!, /无法保存/);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  assert.equal(f.providers.length, 0);
});
