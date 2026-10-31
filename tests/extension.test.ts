import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerMagpie } from "../src/extension.ts";
import { saveConfig } from "../src/config.ts";
import { serve } from "./helpers.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-magpie-extension-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  const pi = {
    registerCommand: (name: string, config: { handler: typeof handler }) => { assert.equal(name, "magpie"); handler = config.handler; },
    registerProvider: (name: string, config: ProviderConfig) => { providers.push({ name, config }); },
    on: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    waitForIdle: async () => {},
    ui: { notify: (message: string) => notices.push(message), input: async () => inputs.shift() },
  } as unknown as ExtensionCommandContext;
  return { path: join(dir, "magpie.json"), providers, notices, inputs, pi, ctx, run: (args: string) => handler(args, ctx) };
}

test("unconfigured plugin does not touch providers and offers setup", async (t) => {
  const f = await fixture(t);
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, 0);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /setup/);
});

test("startup discovers models; failed refresh retains the last working provider", async (t) => {
  const f = await fixture(t);
  let fail = false;
  const baseUrl = await serve(t, (_req, res) => {
    if (fail) { res.writeHead(401); res.end("private-secret"); }
    else res.end(JSON.stringify({ data: [{ id: "vendor/chat" }] }));
  });
  await saveConfig(f.path, { baseUrl, apiKey: "private-secret" });
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, 1);
  assert.equal(f.providers[0].name, "magpie");
  assert.equal(f.providers[0].config.api, "openai-completions");
  assert.equal(f.providers[0].config.models?.[0].id, "vendor/chat");
  await f.run("status");
  assert.ok(!f.notices.join(" ").includes("private-secret"));
  fail = true;
  await f.run("refresh");
  assert.equal(f.providers.length, 1);
  assert.match(f.notices.at(-1)!, /401/);
  assert.ok(!f.notices.join(" ").includes("private-secret"));
});

test("offline startup leaves setup and refresh usable", async (t) => {
  const f = await fixture(t);
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(503); res.end(); });
  await saveConfig(f.path, { baseUrl, apiKey: "test" });
  await registerMagpie(f.pi, f.path);
  assert.equal(f.providers.length, 0);
  await f.run("status");
  assert.match(f.notices.at(-1)!, /503/);
});

test("interactive setup verifies, privately saves and installs the provider", async (t) => {
  const f = await fixture(t);
  const baseUrl = await serve(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: "group/code" }] })));
  await registerMagpie(f.pi, f.path);
  f.inputs.push(baseUrl, "test-secret");
  await f.run("setup");
  assert.equal(f.providers.length, 1);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).apiKey, "test-secret");
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
