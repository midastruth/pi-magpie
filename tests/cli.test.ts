import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fetchModels, USER_AGENT } from "../src/catalog.ts";
import { saveModelCache } from "../src/cache.ts";
import { serve } from "./helpers.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

test("real Pi loads the provider and streams a Unicode response after a tool round-trip", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-magpie-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "sample.txt"), "喜鹊测试 🐦");
  const key = "!literal$KEY";
  const requests: Record<string, any>[] = [];
  const headers: { authorization?: string; userAgent?: string }[] = [];
  let serverError: Error | undefined;
  let modelRequests = 0;
  const baseUrl = await serve(t, async (req, res) => {
    try {
      headers.push({ authorization: req.headers.authorization, userAgent: req.headers["user-agent"] });
      if (req.url === "/v1/models") {
        modelRequests++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "vendor/chat", display_name: "Test chat", reasoning: false }] }));
        return;
      }
      assert.equal(req.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      assert.equal(body.model, "vendor/chat");
      assert.equal(body.stream, true);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", model: "vendor/chat", created: 1,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      send({ role: "assistant" });
      if (requests.length === 1) {
        assert.ok(body.tools.some((tool: any) => tool.function.name === "read"));
        send({ tool_calls: [{ index: 0, id: "read_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(dir, "sample.txt") }) } }] });
        send({}, "tool_calls");
      } else {
        assert.ok(body.messages.some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes("喜鹊测试")));
        send({ content: "已读取：" });
        send({ content: "喜鹊测试 🐦" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      serverError = error as Error;
      res.destroy();
    }
  });
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), MAGPIE_BASE_URL: baseUrl, MAGPIE_API_KEY: key, PI_OFFLINE: "1" };
  const common = [cli, "--no-extensions", "-e", join(root, "index.ts"), "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve"];
  // Cold startup must not discover models, even when the gateway is reachable.
  await exec(process.execPath, [...common, "--help"], { cwd: dir, env, timeout: 10000 });
  assert.equal(modelRequests, 0);
  // Seed the same snapshot as an explicit /magpie refresh, then exercise real Pi.
  const config = { baseUrl, apiKey: key };
  await saveModelCache(join(env.PI_CODING_AGENT_DIR, "magpie-models.json"), config, {
    updatedAt: new Date().toISOString(), models: await fetchModels(config),
  });
  const list = await exec(process.execPath, [...common, "--list-models", "magpie"], { cwd: dir, env, timeout: 10000 });
  assert.match(list.stdout, /vendor\/chat/);
  const operation = exec(process.execPath, [...common, "--provider", "magpie", "--model", "vendor/chat", "--thinking", "off", "--tools", "read", "--no-session", "-p", "Read sample.txt and confirm its contents."], { cwd: dir, env, timeout: 15000 });
  operation.child.stdin?.end();
  const reply = await operation.catch((error) => { throw serverError ?? error; });
  if (serverError) throw serverError;
  assert.match(reply.stdout, /已读取：喜鹊测试 🐦/);
  assert.equal(requests.length, 2);
  assert.equal(modelRequests, 1); // Only the explicit cache seed; never Pi startup.
  for (const h of headers) {
    assert.equal(h.authorization, `Bearer ${key}`);
    assert.equal(h.userAgent, USER_AGENT);
  }
  assert.ok(!reply.stdout.includes(key));
  assert.ok(!reply.stderr.includes(key));
});
