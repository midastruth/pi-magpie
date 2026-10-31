import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isInsecureRemote, literalApiKey, loadConfig, normalizeBaseUrl, saveConfig, validateConfig } from "../src/config.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-magpie-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "magpie.json");
}

test("normalizes root, /v1, trailing slash and reverse-proxy prefix", () => {
  for (const [input, expected] of [
    [" https://magpie.test/ ", "https://magpie.test/v1"],
    ["https://magpie.test/v1/", "https://magpie.test/v1"],
    ["https://magpie.test/proxy/", "https://magpie.test/proxy/v1"],
    ["http://[::1]:3425", "http://[::1]:3425/v1"],
  ]) assert.equal(normalizeBaseUrl(input), expected);
});

test("rejects invalid URLs and URL credentials without echoing input", () => {
  for (const value of ["bad-secret", "file:///tmp/a", "https://user:secret@host", "https://host?key=secret", "https://host/#secret"]) {
    assert.throws(() => normalizeBaseUrl(value), (e: Error) => !e.message.includes("secret"));
  }
  for (const value of [null, {}, { baseUrl: "https://host", apiKey: "" }, { baseUrl: "https://host", apiKey: "bad key" }]) {
    assert.throws(() => validateConfig(value));
  }
});

test("no configuration is a no-op; partial config is an error", async (t) => {
  const path = await fixture(t);
  assert.equal(await loadConfig(path, {}), undefined);
  await assert.rejects(loadConfig(path, { MAGPIE_BASE_URL: "https://host" }), /key/);
});

test("saves credentials privately and replaces existing files atomically", async (t) => {
  const path = await fixture(t);
  await writeFile(path, "{}", { mode: 0o644 });
  const config = { baseUrl: "https://host/v1", apiKey: "gateway-secret" };
  await saveConfig(path, config);
  assert.deepEqual(await loadConfig(path, {}), config);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok((await readFile(path, "utf8")).includes("gateway-secret"));
  await saveConfig(path, { ...config, apiKey: "rotated" });
  assert.equal((await loadConfig(path, {}))?.apiKey, "rotated");
});

test("environment overrides saved fields and a complete environment ignores a broken file", async (t) => {
  const path = await fixture(t);
  await saveConfig(path, { baseUrl: "https://saved", apiKey: "saved" });
  assert.deepEqual(await loadConfig(path, { MAGPIE_API_KEY: "override" }), { baseUrl: "https://saved/v1", apiKey: "override" });
  await writeFile(path, "invalid secret json");
  await assert.rejects(loadConfig(path, {}), (e: Error) => !e.message.includes("secret"));
  assert.deepEqual(await loadConfig(path, { MAGPIE_BASE_URL: "https://env", MAGPIE_API_KEY: "env" }), { baseUrl: "https://env/v1", apiKey: "env" });
  for (const invalid of ["null", "[]", "5"]) {
    await writeFile(path, invalid);
    await assert.rejects(loadConfig(path, {}), /JSON/);
  }
});

test("keys cannot become Pi environment expressions or shell commands", () => {
  assert.equal(literalApiKey("sk-magpie-test"), "sk-magpie-test");
  assert.equal(literalApiKey("$HOME"), "$$HOME");
  assert.equal(literalApiKey("!command"), "$!command");
  assert.equal(literalApiKey("a${HOME}"), "a$${HOME}");
});

test("only remote HTTP gets a plaintext warning", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(isInsecureRemote({ baseUrl: `http://${host}:3425/v1`, apiKey: "k" }), false);
  }
  assert.equal(isInsecureRemote({ baseUrl: "https://remote/v1", apiKey: "k" }), false);
  assert.equal(isInsecureRemote({ baseUrl: "http://remote/v1", apiKey: "k" }), true);
});
