import assert from "node:assert/strict";
import test from "node:test";
import { flagIntermittentTests, listFailedWorkflowRuns, searchGitHubCode, triageGitHubFailure } from "../src/remote-core.js";

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const originalFetch = globalThis.fetch;
const access = { token: "fixture-read-only-token", allowedRepos: new Set(["acme/tiny"]) };

test("searchGitHubCode reads blobs from an allowed private repository using the server credential", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.href);
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    assert.equal(url.hostname, "api.github.com");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true, default_branch: "main" });
    if (url.pathname === "/repos/acme/tiny/commits/main") return jsonResponse({ sha: "abc123" });
    if (url.pathname === "/repos/acme/tiny/git/trees/abc123") {
      return jsonResponse({ truncated: false, tree: [
        { type: "blob", path: "node_modules/pkg/index.js", size: 15, sha: "ignored" },
        { type: "blob", path: "src/app.js", size: 40, sha: "blob1" }
      ] });
    }
    if (url.pathname === "/repos/acme/tiny/git/blobs/blob1") {
      return jsonResponse({ encoding: "base64", size: 40, content: btoa("export const message = 'Hello Triage';\n") });
    }
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await searchGitHubCode({ owner: "acme", repo: "tiny", query: "hello triage" }, access);
  assert.equal(result.repository, "acme/tiny");
  assert.equal(result.files_scanned, 1);
  assert.equal(result.total_matches, 1);
  assert.equal(result.results[0].path, "src/app.js");
  assert.equal(result.scan_limit_reached, false);
  assert.equal(requests.length, 4);
});

test("searchGitHubCode rejects repositories outside the allowlist before any network request", async (t) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Network should not be used."); };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(searchGitHubCode({ owner: "acme", repo: "other", query: "secret" }, access), /not enabled/i);
  assert.equal(calls, 0);
});

test("authenticated GitHub reads fail closed without a repository allowlist", async (t) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Network should not be used."); };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(searchGitHubCode({ owner: "acme", repo: "tiny", query: "secret" }, { token: "fixture-token" }), /allowlist/i);
  assert.equal(calls, 0);
});

test("triageGitHubFailure ranks direct stack-trace and diff evidence", async (t) => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/compare/main...next") {
      return jsonResponse({ total_commits: 1, files: [{
        filename: "src/cart.js",
        status: "modified",
        patch: "@@ -1 +1 @@\n-export function calculateDiscount(price) { return price; }\n+export function calculateDiscount(price) { return price.discount.rate; }"
      }] });
    }
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await triageGitHubFailure({
    owner: "acme", repo: "tiny", baseRef: "main", headRef: "next",
    failureLog: "TypeError: Cannot read properties of undefined (reading 'rate')\n    at calculateDiscount (/runner/src/cart.js:1:58)"
  }, access);
  assert.equal(result.failure_category, "null_or_data_shape");
  assert.equal(result.changed_file_count, 1);
  assert.equal(result.likely_related_changed_files[0].path, "src/cart.js");
  assert.ok(result.likely_related_changed_files[0].evidence.includes("path appears in a stack trace"));
  assert.ok(result.likely_related_changed_files[0].evidence.some((item) => item.includes("calculateDiscount")));
});

test("listFailedWorkflowRuns returns recent failures with a branch filter and only GET requests", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    assert.equal(init.method || "GET", "GET");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/actions/runs") {
      assert.equal(url.searchParams.get("status"), "failure");
      assert.equal(url.searchParams.get("branch"), "main");
      assert.equal(url.searchParams.get("per_page"), "1");
      return jsonResponse({ total_count: 2, workflow_runs: [{
        id: 123, name: "CI", workflow_id: 9, run_number: 17, run_attempt: 1,
        status: "completed", conclusion: "failure", head_branch: "main", event: "push",
        head_sha: "deadbeef", created_at: "2026-11-08T10:00:00Z", html_url: "https://github.com/acme/tiny/actions/runs/123"
      }] });
    }
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await listFailedWorkflowRuns({ owner: "acme", repo: "tiny", branch: "main", limit: 1 }, access);
  assert.equal(result.total_count, 2);
  assert.equal(result.runs[0].id, "123");
  assert.equal(result.runs[0].branch, "main");
  assert.equal(result.results_truncated, true);
  assert.equal(requests.length, 2);
});

test("triageGitHubFailure fetches failed job logs and never forwards the GitHub token to a signed URL", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.hostname === "pipelines.actions.githubusercontent.com") {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.redirect, "error");
      return new Response("TypeError: Cannot read properties of undefined (reading 'id')\n    at calculateCart (/runner/src/cart.js:2:3)\n", { status: 200 });
    }
    assert.equal(url.hostname, "api.github.com");
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    assert.equal(init.method || "GET", "GET");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/actions/runs") {
      return jsonResponse({ workflow_runs: [{
        id: 123, name: "CI", workflow_id: 9, run_number: 17, run_attempt: 2,
        status: "completed", conclusion: "failure", head_branch: "main", event: "pull_request",
        head_sha: "deadbeef", html_url: "https://github.com/acme/tiny/actions/runs/123",
        pull_requests: [{ base: { sha: "base123" }, head: { sha: "deadbeef" } }]
      }] });
    }
    if (url.pathname === "/repos/acme/tiny/actions/runs/123/jobs") {
      return jsonResponse({ jobs: [
        { id: 456, name: "unit tests", conclusion: "failure", html_url: "https://github.com/acme/tiny/actions/runs/123/job/456" },
        { id: 457, name: "build", conclusion: "success" }
      ] });
    }
    if (url.pathname === "/repos/acme/tiny/actions/jobs/456/logs") {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/signed/log" } });
    }
    if (url.pathname === "/repos/acme/tiny/compare/base123...deadbeef") {
      return jsonResponse({ files: [{ filename: "src/cart.js", status: "modified", patch: "+function calculateCart() {}" }] });
    }
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny" }, access);
  assert.equal(result.failure_category, "null_or_data_shape");
  assert.equal(result.comparison, "base123...deadbeef");
  assert.equal(result.source.type, "github_actions");
  assert.equal(result.source.workflow_run.id, "123");
  assert.equal(result.source.failed_job_count, 1);
  assert.equal(result.source.failed_jobs[0].id, "456");
  assert.equal(result.likely_related_changed_files[0].path, "src/cart.js");
  assert.ok(requests.every(({ init }) => init.method === undefined || init.method === "GET"));
});

test("automatic Actions triage rejects a repository outside the allowlist before network access", async (t) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Network should not be used."); };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(triageGitHubFailure({ owner: "acme", repo: "other" }, access), /not enabled/i);
  assert.equal(calls, 0);
});

test("flagIntermittentTests marks mixed outcomes as candidates but excludes skipped runs", () => {
  const result = flagIntermittentTests({ testRuns: [
    { test_name: "checkout > totals", status: "passed", run_id: "1" },
    { test_name: "checkout > totals", status: "failed", run_id: "2" },
    { test_name: "checkout > totals", status: "skipped", run_id: "3" }
  ], minRuns: 2 });
  assert.equal(result.mixed_outcome_tests, 1);
  assert.equal(result.intermittent_test_candidates[0].confidence, "candidate");
  assert.equal(result.intermittent_test_candidates[0].runs, 2);
});

test("searchGitHubCode surfaces upstream rate limits instead of returning a false empty result", async (t) => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true, default_branch: "main" });
    if (url.pathname === "/repos/acme/tiny/commits/main") return jsonResponse({ sha: "abc123" });
    if (url.pathname === "/repos/acme/tiny/git/trees/abc123") return jsonResponse({ tree: [{ type: "blob", path: "src/app.js", size: 40, sha: "blob1" }] });
    if (url.pathname === "/repos/acme/tiny/git/blobs/blob1") return jsonResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" });
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(searchGitHubCode({ owner: "acme", repo: "tiny", query: "message" }, access), /rate limit/i);
});


test("wildcard access reads a private repository but preserves upstream denial errors", async (t) => {
  const wildcard = { token: "fixture-read-only-token", allowedRepos: new Set(["*"]) };
  let mode = "private";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/other") {
      if (mode === "private") return jsonResponse({ private: true, default_branch: "main" });
      if (mode === "not-found") return jsonResponse({ message: "not found" }, 404);
      return jsonResponse({ message: "forbidden" }, 403);
    }
    if (url.pathname === "/repos/acme/other/commits/main") return jsonResponse({ sha: "abc123" });
    if (url.pathname === "/repos/acme/other/git/trees/abc123") return jsonResponse({ tree: [{ type: "blob", path: "src/app.js", size: 10, sha: "blob1" }] });
    if (url.pathname === "/repos/acme/other/git/blobs/blob1") return jsonResponse({ encoding: "base64", size: 10, content: btoa("private hit") });
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await searchGitHubCode({ owner: "acme", repo: "other", query: "private" }, wildcard);
  assert.equal(result.total_matches, 1);
  mode = "denied";
  await assert.rejects(searchGitHubCode({ owner: "acme", repo: "other", query: "private" }, wildcard), /refused the read/i);
  mode = "not-found";
  await assert.rejects(searchGitHubCode({ owner: "acme", repo: "other", query: "private" }, wildcard), /not found/i);
});
