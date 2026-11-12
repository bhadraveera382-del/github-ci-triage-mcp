import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { flagIntermittentTests, searchCode, triageFailure } from "./core.js";

const server = new McpServer({
  name: "github-ci-triage",
  version: "0.7.0"
});

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Triage error: ${message}` }] };
}

server.registerTool("search_codebase", {
  title: "Search local codebase",
  description: "Read-only literal search through source and text files in a local checkout. Skips common generated/dependency directories and never follows symlinks.",
  inputSchema: {
    repo_path: z.string().optional().describe("Path to a local checkout. Optional when TRIAGE_REPO_ROOT is configured."),
    query: z.string().min(1).max(200).describe("Literal text to find; regular expressions are not interpreted."),
    case_sensitive: z.boolean().default(false),
    max_results: z.number().int().min(1).max(100).default(50)
  }
}, async ({ repo_path, query, case_sensitive, max_results }) => {
  try {
    return textResult(await searchCode({ repoPath: repo_path, query, caseSensitive: case_sensitive, maxResults: max_results }));
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool("triage_ci_failure", {
  title: "Triage CI failure",
  description: "Compare a supplied CI failure log with changed files in a local Git checkout and return an evidence ledger with diagnostic claims. Optionally provide base_ref and head_ref to compare a commit range. Does not contact GitHub or any CI service.",
  inputSchema: {
    repo_path: z.string().optional().describe("Path to a local Git checkout. Optional when TRIAGE_REPO_ROOT is configured."),
    failure_log: z.string().min(1).max(60_000).describe("Relevant failing job log excerpt, pasted or copied from CI."),
    base_ref: z.string().optional().describe("Optional base branch or commit SHA; must be supplied with head_ref."),
    head_ref: z.string().optional().describe("Optional head branch or commit SHA; must be supplied with base_ref.")
  }
}, async ({ repo_path, failure_log, base_ref, head_ref }) => {
  try {
    return textResult(await triageFailure({ repoPath: repo_path, failureLog: failure_log, baseRef: base_ref, headRef: head_ref }));
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool("flag_intermittent_tests", {
  title: "Flag intermittent tests",
  description: "Identify tests with both passing and failing outcomes in supplied CI history. Mixed outcomes are candidates, not proof of flakiness.",
  inputSchema: {
    test_runs: z.array(z.object({
      test_name: z.string().min(1),
      status: z.enum(["passed", "pass", "success", "failed", "fail", "error", "skipped"]),
      run_id: z.string().optional(),
      observed_at: z.string().optional()
    })).max(5_000).describe("One row per test result across workflow runs, oldest to newest when possible."),
    min_runs: z.number().int().min(2).max(100).default(3).describe("Run count before a mixed-outcome test is labeled a candidate rather than a possible candidate.")
  }
}, async ({ test_runs, min_runs }) => {
  try {
    return textResult(flagIntermittentTests({ testRuns: test_runs, minRuns: min_runs }));
  } catch (error) {
    return errorResult(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
