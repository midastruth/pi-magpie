import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadModelCache, saveModelCache } from "../src/cache.ts";
import { parseCatalog } from "../src/catalog.ts";

const config = { baseUrl: "https://magpie.example.com/v1", apiKey: "private-cache-secret" };
const models = parseCatalog({ data: [{
  id: "vendor/chat", display_name: "Test 模型", reasoning_levels: ["none", "high"],
  modalities: { input: ["text", "image"] }, pricing: { prompt: "0.000002" },
}] });
const cache = { updatedAt: "2026-11-01T00:00:00.000Z", models };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-magpie-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "magpie-models.json") };
}

test("cache privately round-trips metadata without storing credentials or leaving temp files", async (t) => {
  const f = await fixture(t);
  assert.equal(await loadModelCache(f.path, config), undefined);
  await saveModelCache(f.path, config, cache);
  assert.deepEqual(await loadModelCache(f.path, config), cache);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(f.path, "utf8")).includes(config.apiKey));
  assert.deepEqual(await readdir(f.dir), ["magpie-models.json"]);
  const next = { ...cache, updatedAt: "2026-11-02T00:00:00.000Z" };
  await saveModelCache(f.path, config, next);
  assert.deepEqual(await loadModelCache(f.path, config), next);
});

test("endpoint and credential changes invalidate the cache", async (t) => {
  const f = await fixture(t);
  await saveModelCache(f.path, config, cache);
  assert.equal(await loadModelCache(f.path, { ...config, baseUrl: "https://other.example.com/v1" }), undefined);
  assert.equal(await loadModelCache(f.path, { ...config, apiKey: "different-key" }), undefined);
});

test("invalid JSON, version, timestamp and model metadata are rejected with sanitized errors", async (t) => {
  const f = await fixture(t);
  await saveModelCache(f.path, config, cache);
  const valid = JSON.parse(await readFile(f.path, "utf8"));
  const variants = [
    "private-invalid-json", "[]", JSON.stringify({ ...valid, version: 99 }),
    JSON.stringify({ ...valid, updatedAt: "invalid-date" }),
    JSON.stringify({ ...valid, models: [{}] }),
    JSON.stringify({ ...valid, models: [{ ...models[0], contextWindow: -1 }] }),
    JSON.stringify({ ...valid, models: [{ ...models[0], input: ["video"] }] }),
    JSON.stringify({ ...valid, models: [{ ...models[0], thinkingLevelMap: { high: 123 } }] }),
    JSON.stringify({ ...valid, models: [models[0], models[0]] }),
  ];
  for (const contents of variants) {
    await writeFile(f.path, contents);
    await assert.rejects(loadModelCache(f.path, config), (error: Error) =>
      /缓存无效/.test(error.message) && !error.message.includes("private"));
  }
});

test("untrusted cache fields cannot override provider endpoints or credentials", async (t) => {
  const f = await fixture(t);
  await saveModelCache(f.path, config, cache);
  const data = JSON.parse(await readFile(f.path, "utf8"));
  data.models[0].baseUrl = "https://attacker.example.com";
  data.models[0].apiKey = "!shell-command";
  data.models[0].headers = { Authorization: "unsafe" };
  await writeFile(f.path, JSON.stringify(data));
  assert.deepEqual(await loadModelCache(f.path, config), cache);
});

test("failed cache rename reports its I/O cause and removes the temporary snapshot", async (t) => {
  const f = await fixture(t);
  await mkdir(f.path);
  await assert.rejects(saveModelCache(f.path, config, cache), (error: Error) => {
    assert.match(error.message, /无法保存/);
    assert.equal((error.cause as NodeJS.ErrnoException).code, "EISDIR");
    return true;
  });
  assert.deepEqual(await readdir(f.dir), ["magpie-models.json"]);
});

test("cache cleanup failure retains both the original I/O error and the cleanup error", async (t) => {
  const f = await fixture(t);
  await mkdir(f.path);
  const remove = fs.rm;
  const cleanupError = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
  const mocked = t.mock.method(fs, "rm", async (...args: Parameters<typeof remove>) => {
    if (String(args[0]).endsWith(".tmp")) throw cleanupError;
    return remove(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(saveModelCache(f.path, config, cache), (error: Error) => {
    assert.match(error.message, /无法清理/);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0].code, "EISDIR");
    assert.equal(error.cause.errors[1], cleanupError);
    return true;
  });
  assert.equal((await readdir(f.dir)).filter((name) => name.endsWith(".tmp")).length, 1);
});
