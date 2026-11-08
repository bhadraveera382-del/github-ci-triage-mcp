import assert from "node:assert/strict";
import test from "node:test";
import { flagIntermittentTests, searchGitHubCode, triageGitHubFailure } from "../src/remote-core.js";

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
