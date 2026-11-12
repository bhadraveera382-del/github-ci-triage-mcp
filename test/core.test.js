import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flagIntermittentTests, searchCode, triageFailure } from "../src/core.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "github-ci-triage-test-"));
}

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeGitRepo() {
  const directory = await makeTempDir();
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "test@example.invalid");
  git(directory, "config", "user.name", "Offline Test");
  return directory;
}

test("searchCode finds literal text and skips dependency folders", async (t) => {
  const repo = await makeTempDir();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.mkdir(path.join(repo, "node_modules", "fake"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "app.js"), "export function greet() { return 'Hello Cue'; }\n");
  await fs.writeFile(path.join(repo, "node_modules", "fake", "app.js"), "Hello Cue\n");

  const result = await searchCode({ repoPath: repo, query: "hello cue" });
  assert.equal(result.total_matches, 1);
  assert.equal(result.results[0].path, "src/app.js");
});

test("triageFailure ranks changed files that appear in a stack trace", async (t) => {
  const repo = await makeGitRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "cart.js"), "export function calculateDiscount(price) { return price; }\n");
  git(repo, "add", "src/cart.js");
  git(repo, "commit", "-qm", "baseline");
  const base = git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "src", "cart.js"), "export function calculateDiscount(price) { return price.discount.rate; }\n");
  git(repo, "add", "src/cart.js");
  git(repo, "commit", "-qm", "change discount calculation");
  const head = git(repo, "rev-parse", "HEAD");

  const result = await triageFailure({
    repoPath: repo,
    baseRef: base,
    headRef: head,
    failureLog: "TypeError: Cannot read properties of undefined (reading 'rate')\n    at calculateDiscount (/runner/src/cart.js:1:58)"
  });
  assert.equal(result.failure_category, "null_or_data_shape");
  assert.deepEqual(result.changed_files.map((file) => file.path), ["src/cart.js"]);
  assert.equal(result.likely_related_changed_files[0].path, "src/cart.js");
  assert.ok(result.likely_related_changed_files[0].evidence.includes("path appears in a stack trace"));
});

test("flagIntermittentTests distinguishes mixed outcomes from consistent failures", () => {
  const result = flagIntermittentTests({
    minRuns: 3,
    testRuns: [
      { test_name: "checkout > totals", status: "passed", run_id: "1" },
      { test_name: "checkout > totals", status: "failed", run_id: "2" },
      { test_name: "checkout > totals", status: "passed", run_id: "3" },
      { test_name: "auth > rejects bad token", status: "failed", run_id: "1" },
      { test_name: "auth > rejects bad token", status: "failed", run_id: "2" },
      { test_name: "auth > rejects bad token", status: "failed", run_id: "3" }
    ]
  });
  assert.equal(result.mixed_outcome_tests, 1);
  assert.equal(result.intermittent_test_candidates[0].test_name, "checkout > totals");
  assert.equal(result.intermittent_test_candidates[0].confidence, "candidate");
});

test("mixed outcomes below min_runs are labeled possible candidates", () => {
  const result = flagIntermittentTests({
    testRuns: [
      { test_name: "maybe flaky", status: "pass" },
      { test_name: "maybe flaky", status: "fail" }
    ]
  });
  assert.equal(result.intermittent_test_candidates[0].confidence, "possible_candidate_insufficient_history");
});

test("triageFailure only ranks symbols present on changed diff lines", async (t) => {
  const repo = await makeGitRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "context.js"), "export function stable() { return 1; }\nexport function ContextOnly() { return 2; }\nexport const untouched = 1;\n");
  await fs.writeFile(path.join(repo, "src", "changed.js"), "export function oldValue() { return 1; }\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  const base = git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "src", "context.js"), "export function stable() { return 1; }\nexport function ContextOnly() { return 2; }\nexport const untouched = 2;\n");
  await fs.writeFile(path.join(repo, "src", "changed.js"), "export function ChangedSymbol() { return 2; }\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "change symbol");
  const head = git(repo, "rev-parse", "HEAD");

  const result = await triageFailure({
    repoPath: repo, baseRef: base, headRef: head,
    failureLog: "TypeError\n    at ContextOnly (/runner/src/context.js:2:1)\n    at ChangedSymbol (/runner/src/changed.js:1:1)"
  });
  const context = result.likely_related_changed_files.find((file) => file.path === "src/context.js");
  const changed = result.likely_related_changed_files.find((file) => file.path === "src/changed.js");
  assert.ok(context);
  assert.deepEqual(context.matching_symbols, []);
  assert.ok(!context.match_kinds.includes("changed_line_symbol_overlap"));
  assert.ok(changed.match_kinds.includes("changed_line_symbol_overlap"));
  assert.deepEqual(changed.matching_symbols, ["ChangedSymbol"]);
  assert.equal(result.root_cause_established, false);
  assert.ok(result.evidence?.items?.length);
  assert.ok(result.diagnostic_claims.every((claim) => claim.evidence_ids.every((id) => result.evidence.items.some((item) => item.id === id))));
  assert.equal(result.evidence.sources.find((source) => source.id === "provided_log").line_number_scope, "caller_supplied_excerpt_not_original_ci_log");
  assert.equal(result.evidence.sources.find((source) => source.id === "local:comparison").type, "local_git_diff");
});

test("working-tree context and unchanged symbols do not rank without changed-line evidence", async (t) => {
  const repo = await makeGitRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "app.js"), "export function ExistingSymbol() { return 1; }\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  await fs.writeFile(path.join(repo, "src", "app.js"), "export function ExistingSymbol() { return 1; }\nexport function UnchangedSymbol() { return 2; }\n");
  const result = await triageFailure({
    repoPath: repo,
    failureLog: "TypeError\n    at ExistingSymbol (/runner/src/app.js:1:1)"
  });
  assert.equal(result.likely_related_changed_files.length, 1);
  assert.deepEqual(result.likely_related_changed_files[0].matching_symbols, []);
  assert.ok(!result.likely_related_changed_files[0].match_kinds.includes("changed_line_symbol_overlap"));
  assert.equal(result.comparison, "working tree vs HEAD");
});
