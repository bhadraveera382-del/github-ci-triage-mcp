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

test("automatic triage selects the older same-workflow branch event PR success and returns baseline evidence", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    assert.equal(init.method || "GET", "GET");
    if (url.hostname === "pipelines.actions.githubusercontent.com") return new Response("TypeError: bad cart\n    at calculateCart (/runner/src/cart.js:2:3)\n", { status: 200 });
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/actions/runs/123") return jsonResponse({
      id: 123, name: "CI", workflow_id: 9, run_number: 20, status: "completed", conclusion: "failure",
      head_branch: "feature/cart", event: "pull_request", head_sha: "failedsha", created_at: "2026-11-10T10:00:00Z",
      pull_requests: [{ number: 7, base: { sha: "base123" }, head: { sha: "real-failed-pr-head" } }]
    });
    if (url.pathname === "/repos/acme/tiny/actions/runs/123/jobs") return jsonResponse({ jobs: [{ id: 456, name: "tests", conclusion: "failure" }] });
    if (url.pathname === "/repos/acme/tiny/actions/jobs/456/logs") return new Response(null, { status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/signed/log" } });
    if (url.pathname === "/repos/acme/tiny/compare/base123...real-failed-pr-head") return jsonResponse({ status: "ahead", files: [{ filename: "src/cart.js", status: "modified", patch: "+function calculateCart() {}" }] });
    if (url.pathname === "/repos/acme/tiny/actions/workflows/9/runs" && url.searchParams.get("status") === "success") {
      assert.equal(url.pathname, "/repos/acme/tiny/actions/workflows/9/runs");
      assert.equal(url.searchParams.get("branch"), "feature/cart");
      assert.equal(url.searchParams.get("event"), "pull_request");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(url.searchParams.get("created"), "<=2026-11-10T10:00:00Z");
      return jsonResponse({ total_count: 4, workflow_runs: [
        { id: 1, workflow_id: 8, status: "completed", conclusion: "success", head_branch: "feature/cart", event: "pull_request", head_sha: "wrong-workflow", created_at: "2026-11-09T10:00:00Z", pull_requests: [{ number: 7, head: { sha: "older-pr-head" } }] },
        { id: 2, workflow_id: 9, status: "completed", conclusion: "success", head_branch: "feature/cart", event: "pull_request", head_sha: "wrong-pr", created_at: "2026-11-08T10:00:00Z", pull_requests: [{ number: 8, head: { sha: "wrong-pr-head" } }] },
        { id: 3, workflow_id: 9, status: "completed", conclusion: "success", head_branch: "feature/cart", event: "pull_request", head_sha: "future", created_at: "2026-11-11T10:00:00Z", pull_requests: [{ number: 7, head: { sha: "future-pr-head" } }] },
        { id: 4, name: "CI", workflow_id: 9, status: "completed", conclusion: "success", head_branch: "feature/cart", event: "pull_request", head_sha: "successsha", created_at: "2026-11-08T10:00:00Z", pull_requests: [{ number: 7, head: { sha: "real-success-pr-head" } }] }
      ] });
    }
    if (url.pathname === "/repos/acme/tiny/compare/real-success-pr-head...real-failed-pr-head") return jsonResponse({ status: "behind", ahead_by: 2, behind_by: 1, total_commits: 2, files: [{ filename: "src/cart.js", status: "modified", patch: "@@\n+calculateCart();" }] });
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "123" }, access);
  assert.equal(result.baseline.status, "selected");
  assert.equal(result.baseline.run.id, "4");
  assert.equal(result.baseline.comparison, "real-success-pr-head...real-failed-pr-head");
  assert.equal(result.baseline.non_linear, true);
  assert.equal(result.baseline.likely_related_changed_files[0].log_quotes[0].text, "at calculateCart (/runner/src/cart.js:2:3)");
  assert.deepEqual(result.baseline.likely_related_changed_files[0].diff_snippets, ["+calculateCart();"]);
  assert.ok(requests.every(({ init }) => !init.method || init.method === "GET"));
});

test("automatic baseline reports missing metadata and does not fabricate history", async (t) => {
  let actionRunsCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init.method || "GET", "GET");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/actions/runs/124") return jsonResponse({ id: 124, status: "completed", conclusion: "failure", head_sha: "failedsha", pull_requests: [{ base: { sha: "base123" }, head: { sha: "failedsha" } }] });
    if (url.pathname === "/repos/acme/tiny/actions/runs/124/jobs") return jsonResponse({ jobs: [{ id: 456, name: "tests", conclusion: "failure" }] });
    if (url.pathname === "/repos/acme/tiny/actions/jobs/456/logs") return new Response(null, { status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/signed/log" } });
    if (url.hostname === "pipelines.actions.githubusercontent.com") return new Response("failure\n", { status: 200 });
    if (url.pathname === "/repos/acme/tiny/compare/base123...failedsha") return jsonResponse({ files: [] });
    if (url.pathname.endsWith("/actions/runs")) actionRunsCalls++;
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "124" }, access);
  assert.equal(result.baseline.status, "unavailable");
  assert.equal(result.baseline.reason, "missing_failed_run_metadata");
  assert.equal(actionRunsCalls, 0);
});


test("stack source line numbers never become unrelated log quote line numbers", async (t) => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/compare/main...next") return jsonResponse({ files: [{ filename: "src/cart.js", status: "modified", patch: "-old\n+new" }] });
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", baseRef: "main", headRef: "next", failureLog: "TypeError\n    at calculateCart (/runner/src/cart.js:999:3)" }, access);
  assert.deepEqual(result.likely_related_changed_files[0].log_quotes, [{ line: 2, text: "at calculateCart (/runner/src/cart.js:999:3)" }]);
});

test("baseline comparison reports missing patches independently of commit count and treats identical as linear", async (t) => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname === "/repos/acme/tiny/actions/runs/200") return jsonResponse({ id: 200, workflow_id: 9, status: "completed", conclusion: "failure", head_branch: "main", event: "push", head_sha: "failed", created_at: "2026-11-10T10:00:00Z", pull_requests: [{ number: 1, base: { sha: "base" }, head: { sha: "failed" } }] });
    if (url.pathname === "/repos/acme/tiny/actions/runs/200/jobs") return jsonResponse({ jobs: [{ id: 201, name: "test", conclusion: "failure" }] });
    if (url.pathname === "/repos/acme/tiny/actions/jobs/201/logs") return new Response(null, { status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/signed/log" } });
    if (url.hostname === "pipelines.actions.githubusercontent.com") return new Response("failure\n", { status: 200 });
    if (url.pathname === "/repos/acme/tiny/compare/base...failed") return jsonResponse({ files: [] });
    if (url.pathname === "/repos/acme/tiny/compare/old...failed") return jsonResponse({ status: "identical", total_commits: 99, files: [{ filename: "src/a.js", status: "modified" }] });
    if (url.pathname === "/repos/acme/tiny/actions/workflows/9/runs") return jsonResponse({ total_count: 2, workflow_runs: [
      { id: 100, workflow_id: 9, status: "completed", conclusion: "success", head_branch: "main", event: "push", head_sha: "old", created_at: "2026-11-09T10:00:00Z", pull_requests: [{ number: 1 }] },
      { id: 101, workflow_id: 9, status: "completed", conclusion: "success", head_branch: "main", event: "push", head_sha: "missing-date" }
    ] });
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "200" }, access);
  assert.equal(result.baseline.non_linear, false);
  assert.equal(result.baseline.patches_incomplete, true);
  assert.deepEqual(result.baseline.missing_patch_files, ["src/a.js"]);
});
