import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModels, parseCatalog, USER_AGENT } from "../src/catalog.ts";
import { serve } from "./helpers.ts";

const SAMPLE = {
  id: "vendor/model", display_name: "示例模型", reasoning: true,
  reasoning_levels: ["none", "low", "high", "max"],
  context_window: 200000, max_output_tokens: 32000,
  modalities: { input: ["text", "image"], output: ["text"] },
  pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" },
};

test("maps Magpie metadata and per-token pricing to Pi", () => {
  const [model] = parseCatalog({ data: [SAMPLE] });
  assert.equal(model.id, "vendor/model");
  assert.equal(model.name, "示例模型");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 32000);
  assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.deepEqual(model.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
});

test("routing IDs are preserved, unknown capabilities use conservative defaults", () => {
  const [model] = parseCatalog({ data: [{ id: "group/auto" }] });
  assert.equal(model.id, "group/auto");
  assert.equal(model.name, "group/auto");
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 16384);
  assert.deepEqual(model.input, ["text"]);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("supports structured reasoning levels, including non-disableable thinking", () => {
  const [model] = parseCatalog({ data: [{ id: "a", supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }] }] });
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap?.off, null);
  assert.equal(model.thinkingLevelMap?.high, "high");
  assert.equal(model.thinkingLevelMap?.xhigh, "xhigh");
});

test("filters non-chat and malformed entries, deduplicates and clamps output", () => {
  const models = parseCatalog({ data: [null, {}, { id: " " },
    { id: "a", context_window: 4096, max_output_tokens: 8192, pricing: { prompt: "bad", completion: -1 } },
    { id: "a" }, { id: "picture", modalities: { output: ["image"] } },
    { id: "classifier", native_endpoints: ["/v1/systemone"] },
    { id: "image", type: "image" }, { id: "decision", type: "classifier" },
  ] });
  assert.equal(models.length, 1);
  assert.equal(models[0].maxTokens, 4096);
  assert.equal(models[0].cost.input, 0);
  assert.equal(models[0].cost.output, 0);
  assert.throws(() => parseCatalog({}), /data/);
  assert.deepEqual(parseCatalog({ data: [] }), []);
});

test("fetches only the authenticated catalog with a Pi-identifying User-Agent", async (t) => {
  const baseUrl = await serve(t, (req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.headers["user-agent"], USER_AGENT);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [SAMPLE] }));
  });
  assert.equal((await fetchModels({ baseUrl, apiKey: "test-key" })).length, 1);
});

for (const status of [401, 403, 500]) {
  test(`HTTP ${status} gives a useful error without leaking server content`, async (t) => {
    const baseUrl = await serve(t, (_req, res) => { res.writeHead(status); res.end("secret-key"); });
    await assert.rejects(fetchModels({ baseUrl, apiKey: "secret-key" }), (e: Error) => e.message.includes(String(status)) && !e.message.includes("secret"));
  });
}

test("rejects invalid JSON and redirects", async (t) => {
  let redirect = false;
  const baseUrl = await serve(t, (_req, res) => {
    if (redirect) { res.writeHead(302, { Location: "/other" }); res.end(); }
    else res.end("not-json secret-key");
  });
  await assert.rejects(fetchModels({ baseUrl, apiKey: "secret-key" }), /JSON/);
  redirect = true;
  await assert.rejects(fetchModels({ baseUrl, apiKey: "secret-key" }), /重定向/);
});

test("fetch honors timeouts and caller cancellation", async (t) => {
  const baseUrl = await serve(t, () => {});
  await assert.rejects(fetchModels({ baseUrl, apiKey: "k" }, undefined, 20), /超时/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchModels({ baseUrl, apiKey: "k" }, controller.signal), /取消/);
});
