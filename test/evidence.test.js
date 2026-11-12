import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence, classifyFailure } from "../src/evidence.js";
import { triageGitHubFailure } from "../src/remote-core.js";

const originalFetch = globalThis.fetch;
const access = { token: "fixture-read-only-token", allowedRepos: new Set(["acme/tiny"]) };

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function assertEvidenceReferences(result) {
  const sourceIds = new Set(result.evidence.sources.map((source) => source.id));
  const itemIds = new Set(result.evidence.items.map((item) => item.id));
  const claimIds = new Set(result.diagnostic_claims.map((claim) => claim.id));
  assert.equal(itemIds.size, result.evidence.items.length);
  for (const item of result.evidence.items) assert.ok(sourceIds.has(item.source_id), `missing source for ${item.id}`);
  for (const claim of result.diagnostic_claims) {
    for (const evidenceId of claim.evidence_ids) assert.ok(itemIds.has(evidenceId), `missing item for ${claim.id}`);
    for (const pattern of claim.matched_patterns || []) for (const evidenceId of pattern.evidence_ids) assert.ok(itemIds.has(evidenceId));
  }
  for (const file of result.likely_related_changed_files) {
    assert.ok(claimIds.has(file.claim_id), `missing claim for ${file.path}`);
    assert.ok(itemIds.has(file.claim_id) === false, "claim IDs are not evidence item IDs");
    for (const evidenceId of file.evidence_ids) assert.ok(itemIds.has(evidenceId), `missing item for ${file.path}`);
  }
}

test("classifyFailure is deterministic and buildEvidence makes every claim/evidence ID traceable", () => {
  const longLine = "TypeError: " + "x".repeat(410);
  const failure = classifyFailure(longLine);
  assert.equal(failure.category, "null_or_data_shape");
  assert.equal(failure.rule_id, "null_or_data_shape");
  assert.deepEqual(failure.matched_categories, ["null_or_data_shape"]);
  assert.equal(failure.selection_method, "first_matching_rule_in_fixed_order_not_severity_or_cause");

  const result = buildEvidence({
    scope: "primary",
    documents: [{
      id: "provided_log", type: "caller_supplied_log", text: longLine,
      url: null, authenticity: "not_independently_verified",
      line_number_scope: "caller_supplied_excerpt_not_original_ci_log"
    }],
    comparisonSource: {
      id: "primary:comparison", type: "github_compare", repository: "acme/tiny"
    },
    changedFiles: [{ path: "src/cart.js", status: "M", patch: "@@\n+calculateCart();" }],
    rankedFiles: [{ path: "src/cart.js", status: "M", score: 8, matching_symbols: ["calculateCart"], source_quotes: [] }],
    failure
  });

  assertEvidenceReferences(result);
  assert.equal(result.evidence.sources.find((source) => source.id === "provided_log").authenticity, "not_independently_verified");
  assert.equal(result.evidence.sources.find((source) => source.id === "provided_log").line_number_scope, "caller_supplied_excerpt_not_original_ci_log");
  const logItem = result.evidence.items.find((item) => item.kind === "log_excerpt");
  assert.equal(logItem.quote.length, 400);
  assert.equal(logItem.quote_truncated, true);
  assert.equal(logItem.locator.line_number_scope, "caller_supplied_excerpt_not_original_ci_log");
});

test("classifyFailure records all matching categories while selecting the first fixed-precedence rule", () => {
  const failure = classifyFailure("TypeError: timeout while parsing; AssertionError expected value");
  assert.equal(failure.category, "null_or_data_shape");
  assert.deepEqual(failure.matched_categories, ["null_or_data_shape", "assertion_mismatch", "timeout"]);
  assert.deepEqual(failure.rule_precedence.slice(0, 3), ["import_or_dependency", "null_or_data_shape", "assertion_mismatch"]);
  assert.equal(failure.selection_method, "first_matching_rule_in_fixed_order_not_severity_or_cause");
});

test("buildEvidence does not falsely mark exact-at-limit quotes as truncated", () => {
  const exact = "TypeError: " + "x".repeat(389); // exactly 400 characters
  assert.equal(exact.length, 400);
  const result = buildEvidence({
    documents: [{ id: "provided_log", text: exact, line_number_scope: "caller_supplied_excerpt_not_original_ci_log" }],
    comparisonSource: { id: "primary:comparison", type: "github_compare" },
    changedFiles: [], rankedFiles: [], failure: classifyFailure(exact)
  });
  assert.equal(result.evidence.items[0].quote.length, 400);
  assert.equal(result.evidence.items[0].quote_truncated, false);
});

test("buildEvidence preserves raw log quote whitespace and gives every matched pattern its evidence IDs", () => {
  const text = "  TypeError: timeout\n\tAssertionError expected value";
  const failure = classifyFailure(text);
  const result = buildEvidence({
    documents: [{ id: "provided_log", text, line_number_scope: "caller_supplied_excerpt_not_original_ci_log" }],
    comparisonSource: { id: "primary:comparison", type: "github_compare" },
    changedFiles: [], rankedFiles: [], failure
  });
  const claim = result.diagnostic_claims[0];
  assert.deepEqual(claim.matched_patterns.map(({ rule_id }) => rule_id), ["null_or_data_shape", "assertion_mismatch", "timeout"]);
  for (const pattern of claim.matched_patterns) assert.ok(pattern.evidence_ids.length > 0);
  const quotes = result.evidence.items.filter((item) => item.kind === "log_excerpt").map((item) => item.quote);
  assert.ok(quotes.includes("  TypeError: timeout"));
  assert.ok(quotes.includes("\tAssertionError expected value"));
});

test("triage keeps supplied logs explicitly unverified, preserves quote scope, ranks changed lines not context-only symbols, and exposes capped compare metadata", async (t) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.method || "GET", "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true, full_name: "acme/tiny" });
    if (url.pathname === "/repos/acme/tiny/compare/main...next") {
      const files = [
        { filename: "src/context-only.js", status: "modified", patch: "@@\n calculateCart();\n unchanged();" },
        { filename: "src/changed.js", status: "modified", patch: "@@\n-calculateCart();\n+calculateCart();" },
        { filename: "assets/large.bin", status: "modified" }
      ];
      for (let index = 3; index < 300; index++) files.push({ filename: `src/file-${index}.js`, status: "modified", patch: "" });
      return jsonResponse({ status: "ahead", files });
    }
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await triageGitHubFailure({
    owner: "acme", repo: "tiny", baseRef: "main", headRef: "next",
    failureLog: "TypeError: bad cart\n    at calculateCart (/runner/src/other.js:2:3)"
  }, access);

  assert.equal(result.failure_category, "null_or_data_shape");
  assert.equal(result.changed_file_count, 300);
  assert.equal(result.evidence.sources.find((source) => source.id === "provided_log").authenticity, "not_independently_verified");
  assert.equal(result.evidence.sources.find((source) => source.id === "provided_log").line_number_scope, "caller_supplied_excerpt_not_original_ci_log");
  assert.equal(result.analysis_coverage.comparison_file_list_may_be_capped, true);
  assert.equal(result.evidence.sources.find((source) => source.id === "primary:comparison").files_received, 300);
  assert.ok(result.analysis_coverage.missing_patch_files.includes("assets/large.bin"));
  assert.ok(result.evidence.sources.find((source) => source.id === "primary:comparison").missing_patch_files.includes("assets/large.bin"));
  assert.ok(result.likely_related_changed_files.some((file) => file.path === "src/changed.js"));
  assert.ok(!result.likely_related_changed_files.some((file) => file.path === "src/context-only.js"));
  assertEvidenceReferences(result);
  assert.ok(!JSON.stringify(result).includes("fixture-read-only-token"));
});

test("fetched jobs retain job-specific attribution for identical logs and report exact character/byte limits", async (t) => {
  const requests = [];
  const shared = "TypeError: same text\n    at calculateCart (/runner/src/cart.js:2:3)\n";
  const charLimited = shared + "c".repeat(60_001 - shared.length);
  const byteLimited = shared + "b".repeat(1_000_001 - shared.length);
  const exactByteLimit = "e".repeat(1_000_000);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    assert.equal(init.method || "GET", "GET");
    assert.equal(init.body, undefined);
    if (url.hostname === "pipelines.actions.githubusercontent.com") {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.redirect, "error");
      if (url.pathname.endsWith("/1")) return new Response(charLimited);
      if (url.pathname.endsWith("/2")) return new Response(byteLimited);
      if (url.pathname.endsWith("/3")) return new Response(exactByteLimit);
      throw new Error(`Unexpected signed URL: ${url.href}`);
    }
    assert.equal(url.hostname, "api.github.com");
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true, full_name: "acme/tiny" });
    if (url.pathname === "/repos/acme/tiny/actions/runs/77") return jsonResponse({
      id: 77, name: "CI", workflow_id: 9, run_number: 1, run_attempt: 1,
      status: "completed", conclusion: "failure", head_branch: "main", event: "push",
      head_sha: "failed", created_at: "2026-11-10T10:00:00Z", pull_requests: [{ base: { sha: "base" }, head: { sha: "failed" } }]
    });
    if (url.pathname === "/repos/acme/tiny/actions/runs/77/jobs") return jsonResponse({ total_count: 3, jobs: [
      { id: 1, name: "char-job", conclusion: "failure" },
      { id: 2, name: "byte-job", conclusion: "failure" },
      { id: 3, name: "exact-byte-job", conclusion: "failure" }
    ] });
    if (url.pathname.match(/\/actions\/jobs\/[123]\/logs$/)) {
      const id = url.pathname.match(/jobs\/(\d+)\/logs/)[1];
      return new Response(null, { status: 302, headers: { Location: `https://pipelines.actions.githubusercontent.com/log/${id}` } });
    }
    if (url.pathname === "/repos/acme/tiny/compare/base...failed") return jsonResponse({ files: [{ filename: "src/cart.js", status: "modified", patch: "+calculateCart();" }] });
    if (url.pathname === "/repos/acme/tiny/actions/workflows/9/runs") return jsonResponse({ total_count: 0, workflow_runs: [] });
    throw new Error(`Unexpected test request: ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "77" }, access);
  const documents = new Map(result.evidence.sources.filter((source) => source.type === "github_actions_job_log").map((source) => [source.job_id, source]));
  assert.equal(documents.get("1").character_limit_reached, true);
  assert.equal(documents.get("1").byte_limit_reached, false);
  assert.equal(documents.get("2").byte_limit_reached, true);
  assert.equal(documents.get("3").byte_limit_reached, false, "exactly 1 MB must not be marked byte-truncated");
  assert.ok(documents.get("3").character_limit_reached, "exactly 1 MB still exceeds the independent character limit");
  assert.equal(documents.get("1").line_number_scope, "bounded_job_log_excerpt_not_original_log_or_github_anchor");
  assert.equal(documents.get("2").line_number_scope, "bounded_job_log_excerpt_not_original_log_or_github_anchor");
  assert.equal(documents.get("3").line_number_scope, "bounded_job_log_excerpt_not_original_log_or_github_anchor");
  const logItems = result.evidence.items.filter((item) => item.kind === "log_excerpt");
  assert.ok(logItems.some((item) => item.source_id === "job:77:1"));
  assert.ok(logItems.some((item) => item.source_id === "job:77:2"));
  assert.ok(result.likely_related_changed_files[0].evidence_ids.some((id) => logItems.find((item) => item.id === id)?.source_id === "job:77:1"));
  assert.ok(!JSON.stringify(result).includes("fixture-read-only-token"));
  assert.ok(!JSON.stringify(result).includes("pipelines.actions.githubusercontent.com"));
  assert.equal(documents.get("1").selected_run_attempt, 1);
  assert.equal(documents.get("1").job_run_attempt, null);
  assert.equal(documents.get("1").attempt_attribution, "latest_jobs_endpoint_not_independently_attempt_pinned");
  assert.ok(requests.every(({ init }) => !init.method || init.method === "GET"));
  assert.ok(requests.every(({ url }) => !url.search.includes("fixture-read-only-token")));
});

test("exact 60000-character logs are not marked truncated and job names do not become error evidence", async (t) => {
  let length = 60_000;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.method || "GET", "GET");
    assert.equal(init.body, undefined);
    if (url.hostname === "pipelines.actions.githubusercontent.com") return new Response("setup complete\n".padEnd(length, "x"));
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname.endsWith("/actions/runs/99")) return jsonResponse({ id: 99, status: "completed", conclusion: "failure", head_sha: "head", pull_requests: [{ base: { sha: "base" }, head: { sha: "head" } }] });
    if (url.pathname.endsWith("/runs/99/jobs")) return jsonResponse({ total_count: 1, jobs: [{ id: 1, name: "TypeError timeout src/cart.js", conclusion: "failure", run_attempt: 2 }] });
    if (url.pathname.endsWith("/jobs/1/logs")) return new Response(null, { status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/log/1" } });
    if (url.pathname.endsWith("/compare/base...head")) return jsonResponse({ files: [{ filename: "src/cart.js", status: "modified", patch: "+unrelated();" }] });
    throw new Error(`Unexpected request ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (length of [60_000, 60_001]) {
    const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "99" }, access);
    const source = result.evidence.sources.find((item) => item.type === "github_actions_job_log");
    assert.equal(source.selected_run_attempt, null);
    assert.equal(source.job_run_attempt, 2);
    assert.equal(source.attempt_attribution, "latest_jobs_endpoint_not_independently_attempt_pinned");
    assert.equal(result.source.workflow_run.run_attempt, null);
    assert.equal(source.character_limit_reached, length > 60_000);
    assert.equal(source.log_truncated, length > 60_000);
    assert.equal(result.source.logs_truncated, length > 60_000);
    assert.equal(result.failure_category, "unclear");
    assert.deepEqual(result.likely_related_changed_files, []);
    assert.equal(result.diagnostic_claims[0].assessment, "insufficient_evidence");
  }
});

test("omitted jobs and incomplete jobs-page coverage remain explicit rather than a complete failure diagnosis", async (t) => {
  const downloaded = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.method || "GET", "GET");
    assert.equal(init.body, undefined);
    if (url.hostname === "pipelines.actions.githubusercontent.com") return new Response("TypeError: observed\n");
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname.endsWith("/actions/runs/99")) return jsonResponse({ id: 99, status: "completed", conclusion: "failure", head_sha: "head", pull_requests: [{ base: { sha: "base" }, head: { sha: "head" } }] });
    if (url.pathname.endsWith("/runs/99/jobs")) return jsonResponse({ total_count: 101, jobs: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `job-${index + 1}`, conclusion: "failure", run_id: 99 })) });
    const job = url.pathname.match(/\/jobs\/(\d+)\/logs$/);
    if (job) {
      downloaded.push(job[1]);
      return new Response(null, { status: 302, headers: { Location: `https://pipelines.actions.githubusercontent.com/log/${job[1]}` } });
    }
    if (url.pathname.endsWith("/compare/base...head")) return jsonResponse({ files: [] });
    throw new Error(`Unexpected request ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "99" }, access);
  assert.deepEqual(downloaded, ["1", "2", "3", "4", "5"]);
  assert.equal(result.source.failed_job_count, 6);
  assert.equal(result.source.omitted_failed_jobs, 1);
  assert.equal(result.source.jobs_list_may_be_incomplete, true);
  assert.equal(result.source.failed_job_count_scope, "failed_jobs_observed_on_first_jobs_page");
  assert.equal(result.root_cause_established, false);
});

test("mismatched job identity and malformed comparisons fail as unavailable, never as empty verified evidence", async (t) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.method || "GET", "GET");
    assert.equal(init.body, undefined);
    if (url.pathname === "/repos/acme/tiny") return jsonResponse({ private: true });
    if (url.pathname.endsWith("/actions/runs/99")) return jsonResponse({ id: 99, status: "completed", conclusion: "failure" });
    if (url.pathname.endsWith("/runs/99/jobs")) return jsonResponse({ jobs: [{ id: 1, run_id: 100, conclusion: "failure" }] });
    if (url.pathname.endsWith("/compare/main...next")) return jsonResponse({});
    throw new Error(`Unexpected request ${url.href}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(triageGitHubFailure({ owner: "acme", repo: "tiny", runId: "99" }, access), /different run/);
  await assert.rejects(triageGitHubFailure({ owner: "acme", repo: "tiny", baseRef: "main", headRef: "next", failureLog: "TypeError" }, access), /unavailable, not an empty change/);
});
