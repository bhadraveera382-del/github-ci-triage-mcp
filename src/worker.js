import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { flagIntermittentTests, listFailedWorkflowRuns, searchGitHubCode, triageGitHubFailure } from "./remote-core.js";

const CLAUDE_ORIGINS = new Set([
  "https://claude.ai",
  "https://claude.com",
  "https://platform.claude.com"
]);
const repoPart = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);
const refPart = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/);
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Triage error: ${message}` }] };
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function createMcpServer(access = {}) {
  const server = new McpServer({ name: "github-ci-triage", version: "0.5.0" });

  registerTool(server, "search_codebase", {
    title: "Search allowed GitHub code",
    description: "Read-only literal, case-insensitive-by-default search through source and text files in a repository accessible to this connector. Reads at most 30 eligible files per call and marks partial scans. The GitHub credential stays server-side.",
    annotations: readOnlyAnnotations,
    inputSchema: {
      owner: repoPart.describe("GitHub user or organization that owns the repository."),
      repo: repoPart.describe("Repository name accessible to this connector."),
      ref: refPart.optional().describe("Optional branch, tag, or commit SHA; defaults to the repository's default branch."),
      query: z.string().min(1).max(200).describe("Literal text to find; regular expressions are not interpreted."),
      case_sensitive: z.boolean().default(false),
      max_results: z.number().int().min(1).max(100).default(50)
    }
  }, ({ owner, repo, ref, query, case_sensitive, max_results }) => searchGitHubCode({ owner, repo, ref, query, caseSensitive: case_sensitive, maxResults: max_results }, access));

  registerTool(server, "list_failed_workflow_runs", {
    title: "List failed GitHub Actions runs",
    description: "Read-only listing of recent completed failed workflow runs for a repository accessible to this connector. Supports an optional branch filter; never reruns or changes a workflow.",
    annotations: readOnlyAnnotations,
    inputSchema: {
      owner: repoPart.describe("GitHub user or organization that owns the repository."),
      repo: repoPart.describe("Repository name accessible to this connector."),
      branch: refPart.optional().describe("Optional branch name to filter failed runs."),
      limit: z.number().int().min(1).max(25).default(10).describe("Maximum number of recent failed runs to return.")
    }
  }, ({ owner, repo, branch, limit }) => listFailedWorkflowRuns({ owner, repo, branch, limit }, access));

  registerTool(server, "triage_ci_failure", {
    title: "Triage GitHub Actions failure",
    description: "Read-only triage using a supplied failure log or automatically fetched logs from a selected failed run (run_id) or the latest completed failed run. Provide both base_ref and head_ref for a supplied log; automatic mode uses the run's pull request base or commit parent when available and separately compares it with the latest eligible older successful run of the same workflow, branch, event, and PR. Never reruns or changes workflows.",
    annotations: readOnlyAnnotations,
    inputSchema: {
      owner: repoPart.describe("GitHub user or organization that owns the repository."),
      repo: repoPart.describe("Repository name accessible to this connector."),
      failure_log: z.string().min(1).max(60_000).optional().describe("Optional relevant failing job log excerpt. Omit to fetch logs from an Actions run."),
      run_id: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]).optional().describe("Optional numeric Actions run ID. When omitted in automatic mode, the latest completed failed run is selected."),
      branch: refPart.optional().describe("Optional branch filter for automatic failed-run selection."),
      base_ref: refPart.optional().describe("Optional base branch or commit SHA. Required with head_ref for a supplied log; automatic mode infers it when possible."),
      head_ref: refPart.optional().describe("Optional head branch or commit SHA. Required with base_ref for a supplied log; automatic mode infers it when possible.")
    }
  }, ({ owner, repo, failure_log, run_id, branch, base_ref, head_ref }) => triageGitHubFailure({ owner, repo, failureLog: failure_log, runId: run_id, branch, baseRef: base_ref, headRef: head_ref }, access));

  registerTool(server, "flag_intermittent_tests", {
    title: "Flag intermittent test candidates",
    description: "Identify tests with both passing and failing outcomes in supplied CI history. Mixed outcomes are candidates, not proof of flakiness.",
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
    inputSchema: {
      test_runs: z.array(z.object({
        test_name: z.string().min(1),
        status: z.enum(["passed", "pass", "success", "failed", "fail", "error", "skipped"]),
        run_id: z.string().optional(),
        observed_at: z.string().optional()
      })).max(5_000).describe("One row per test result across workflow runs, oldest to newest when possible."),
      min_runs: z.number().int().min(2).max(100).default(3).describe("Run count before a mixed-outcome test is labeled a candidate rather than a possible candidate.")
    }
  }, ({ test_runs, min_runs }) => flagIntermittentTests({ testRuns: test_runs, minRuns: min_runs }));

  return server;
}

export function configuredAccess(env) {
  const githubToken = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
  const mcpToken = typeof env.MCP_ACCESS_TOKEN === "string" ? env.MCP_ACCESS_TOKEN.trim() : "";
  const rawRepos = typeof env.GITHUB_ALLOWED_REPOS === "string" ? env.GITHUB_ALLOWED_REPOS.split(/[,\n]/) : [];
  const configuredRepos = rawRepos.map((value) => value.trim().toLowerCase());
  if (!githubToken || /\s/.test(githubToken) || mcpToken.length < 32 || mcpToken.length > 512 || /\s/.test(mcpToken)) return null;
  const hasInvalidRepo = configuredRepos.some((value) => !value || (value !== "*" && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value)));
  const hasMixedWildcard = configuredRepos.includes("*") && (configuredRepos.length !== 1 || configuredRepos[0] !== "*");
  if (configuredRepos.length === 0 || configuredRepos.length > 10 || hasInvalidRepo || hasMixedWildcard) return null;
  return { token: githubToken, mcpToken, allowedRepos: new Set(configuredRepos) };
}

async function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || provided.length > 512) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function originError(request) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host && host.toLowerCase() !== url.host.toLowerCase()) return new Response("MCP request host does not match its URL.", { status: 421 });
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === "null") return new Response("Null origins are not accepted.", { status: 403 });
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return new Response("Invalid Origin header.", { status: 403 });
  }
  const sameOrigin = parsed.origin === url.origin;
  const localDevelopment = ["localhost", "127.0.0.1"].includes(url.hostname) && ["http://localhost:8787", "http://127.0.0.1:8787"].includes(parsed.origin);
  if (!sameOrigin && !CLAUDE_ORIGINS.has(parsed.origin) && !localDevelopment) return new Response("Origin is not allowed.", { status: 403 });
  return null;
}

function withCors(response, request) {
  const origin = request.headers.get("origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env = {}) {
    const invalidOrigin = originError(request);
    if (invalidOrigin) return invalidOrigin;
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
      return withCors(Response.json({ status: "ok", name: "github-ci-triage", version: "0.5.0", mcp_endpoint: "/mcp", ready: Boolean(configuredAccess(env)), read_only: true }), request);
    }
    if (url.pathname !== "/mcp") return new Response("Not found.", { status: 404 });
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request);
    if (request.method !== "POST") return withCors(new Response("Method not allowed. This stateless MCP endpoint accepts POST requests only.", { status: 405, headers: { Allow: "POST, OPTIONS" } }), request);

    const access = configuredAccess(env);
    if (!access) return withCors(Response.json({ error: "Server access is not configured." }, { status: 503 }), request);
    const match = (request.headers.get("authorization") || "").match(/^Bearer ([^\s]+)$/i);
    if (!match || !(await tokenMatches(match[1], access.mcpToken))) {
      return withCors(Response.json({ error: "A valid connector access key is required." }, { status: 401, headers: { "WWW-Authenticate": "Bearer realm=\"github-ci-triage\"" } }), request);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      keepAliveMs: 0,
      maxRequestBodySize: 1_000_000
    });
    const server = createMcpServer({ token: access.token, allowedRepos: access.allowedRepos });
    await server.connect(transport);
    return withCors(await transport.handleRequest(request), request);
  }
};
