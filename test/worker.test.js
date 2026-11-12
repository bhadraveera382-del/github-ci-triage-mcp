import assert from "node:assert/strict";
import test from "node:test";
import worker, { configuredAccess } from "../src/worker.js";

const env = {
  GITHUB_TOKEN: "fixture-read-only-github-token",
  MCP_ACCESS_TOKEN: "fixture-mcp-access-key-at-least-thirty-two-characters",
  GITHUB_ALLOWED_REPOS: "acme/tiny"
};

function request(payload, authorization, origin) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (authorization) headers.Authorization = authorization;
  if (origin) headers.Origin = origin;
  return new Request("https://triage.example/mcp", { method: "POST", headers, body: JSON.stringify(payload) });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "unit-test", version: "1" } } };

test("Worker is fail-closed when server secrets are not configured", async () => {
  const response = await worker.fetch(request(initialize), {});
  assert.equal(response.status, 503);
});

test("Worker rejects missing and incorrect connector keys", async () => {
  assert.equal((await worker.fetch(request(initialize), env)).status, 401);
  assert.equal((await worker.fetch(request(initialize, "Bearer wrong-key"), env)).status, 401);
});

test("Worker rejects untrusted browser origins even with a correct key", async () => {
  const response = await worker.fetch(request(initialize, `Bearer ${env.MCP_ACCESS_TOKEN}`, "https://untrusted.example"), env);
  assert.equal(response.status, 403);
});

test("Worker accepts an authenticated MCP initialization", async () => {
  const response = await worker.fetch(request(initialize, `Bearer ${env.MCP_ACCESS_TOKEN}`), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.serverInfo.name, "github-ci-triage");
  assert.equal(body.result.protocolVersion, "2025-03-26");
});

test("Worker exposes only the five read-only tools to an authenticated caller", async () => {
  const response = await worker.fetch(request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, `Bearer ${env.MCP_ACCESS_TOKEN}`), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.tools.map((tool) => tool.name), ["search_codebase", "list_failed_workflow_runs", "get_ci_status", "triage_ci_failure", "flag_intermittent_tests"]);
  assert.ok(body.result.tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.ok(body.result.tools.every((tool) => tool.annotations.destructiveHint === false));
  const triage = body.result.tools.find((tool) => tool.name === "triage_ci_failure");
  assert.ok(triage.inputSchema.properties.run_id);
  assert.ok(!triage.inputSchema.required?.includes("failure_log"));
  assert.ok(body.result.tools.every((tool) => !Object.keys(tool.inputSchema.properties || {}).some((key) => /token|credential|secret/i.test(key))));
});

test("authenticated tool calls cannot access a repository outside the allowlist", async (t) => {
  const originalFetch = globalThis.fetch;
  let outgoingRequests = 0;
  globalThis.fetch = async () => { outgoingRequests++; throw new Error("No GitHub call should be made."); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await worker.fetch(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_codebase", arguments: { owner: "acme", repo: "other", query: "secret" } } }, `Bearer ${env.MCP_ACCESS_TOKEN}`), env);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /not enabled/i);
  assert.equal(outgoingRequests, 0);
});


test("configuredAccess accepts the sole wildcard and rejects missing or mixed wildcard configuration", () => {
  assert.deepEqual([...configuredAccess({ ...env, GITHUB_ALLOWED_REPOS: "*" }).allowedRepos], ["*"]);
  assert.equal(configuredAccess({ ...env, GITHUB_ALLOWED_REPOS: "" }), null);
  assert.equal(configuredAccess({ ...env, GITHUB_ALLOWED_REPOS: "*,acme/tiny" }), null);
  assert.equal(configuredAccess({ ...env, GITHUB_ALLOWED_REPOS: "acme/tiny,*" }), null);
});
