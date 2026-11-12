import assert from "node:assert/strict";
import test from "node:test";
import { getCIStatus, listFailedWorkflowRuns } from "../src/remote-core.js";

const originalFetch = globalThis.fetch;
const access = { token: "fixture-read-only-token", allowedRepos: new Set(["acme/tiny", "acme/other"]) };

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function run(id, overrides = {}) {
  return {
    id,
    name: "CI",
    workflow_id: 7,
    run_number: Number(id),
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    event: "push",
    head_sha: `sha-${id}`,
    created_at: "2026-11-08T10:00:00Z",
    html_url: `https://github.com/acme/tiny/actions/runs/${id}`,
    repository: { full_name: "acme/tiny" },
    ...overrides
  };
}

function installFetch(t, handler) {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const request = { url, init };
    requests.push(request);
    assert.ok(init.method === undefined || init.method === "GET", `non-GET request: ${init.method}`);
    assert.equal(init.body, undefined, "GitHub operations must not send a request body");
    assert.equal(init.headers.Authorization, "Bearer fixture-read-only-token");
    const response = await handler(url, init, requests);
    if (!response) throw new Error(`Unexpected test request: ${url.href}`);
    return response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return requests;
}

function repoInfo(fullName = "acme/tiny", defaultBranch = "main") {
  return { private: true, full_name: fullName, default_branch: defaultBranch };
}

function listHandler({ total_count, workflow_runs, assertQuery } = {}) {
  return (url) => {
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo());
    if (url.pathname === "/repos/acme/tiny/actions/runs") {
      assertQuery?.(url.searchParams);
      return jsonResponse({ total_count, workflow_runs });
    }
    return null;
  };
}

test("large failed-run counts preserve lower-bound accuracy for numeric and string sentinels", async (t) => {
  for (const raw of [2500, "2500+", "2,500+"]) {
    const requests = installFetch(t, listHandler({ total_count: raw, workflow_runs: [run("11")] }));
    const result = await listFailedWorkflowRuns({ owner: "acme", repo: "tiny", limit: 1 }, access);
    assert.equal(result.total_count, null, String(raw));
    assert.equal(result.count_accuracy, "lower_bound", String(raw));
    assert.equal(result.total_count_lower_bound, 2500, String(raw));
    assert.equal(result.returned_count, 1, String(raw));
    assert.equal(requests.length, 2, String(raw));
    // Restore between subcases so each case can install its own fixture.
    globalThis.fetch = originalFetch;
  }
});

test("unknown, null, and malformed counts never become zero, while exact zero remains exact", async (t) => {
  for (const raw of [undefined, null, "not-a-count"]) {
    installFetch(t, listHandler({ total_count: raw, workflow_runs: [] }));
    const result = await listFailedWorkflowRuns({ owner: "acme", repo: "tiny" }, access);
    assert.equal(result.total_count, null, String(raw));
    assert.equal(result.count_accuracy, "unknown", String(raw));
    assert.equal(result.returned_count, 0, String(raw));
    globalThis.fetch = originalFetch;
  }
  installFetch(t, listHandler({ total_count: 0, workflow_runs: [] }));
  const exactZero = await listFailedWorkflowRuns({ owner: "acme", repo: "tiny" }, access);
  assert.equal(exactZero.total_count, 0);
  assert.equal(exactZero.count_accuracy, "api_reported_exact");
  assert.equal(exactZero.returned_count, 0);
});

test("unexpected statuses and branch mismatches are excluded, not reported as failures", async (t) => {
  const requests = installFetch(t, listHandler({
    total_count: 99,
    workflow_runs: [
      run("21"),
      run("22", { status: "queued", conclusion: null }),
      run("23", { head_branch: "release" }),
      run("24", { status: "completed", conclusion: "success" })
    ]
  }));
  const result = await listFailedWorkflowRuns({ owner: "acme", repo: "tiny", branch: "main", limit: 10 }, access);
  assert.deepEqual(result.runs.map(({ id }) => id), ["21"]);
  assert.equal(result.returned_count, 1);
  assert.equal(result.excluded_unexpected_runs, 3);
  assert.equal(result.total_count, null);
  assert.equal(result.count_accuracy, "unknown");
  assert.equal(result.results_truncated, true);
  assert.equal(requests[1].url.searchParams.get("branch"), "main");
});

test("two repository requests remain isolated, including rows and counts", async (t) => {
  const requests = installFetch(t, (url) => {
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo());
    if (url.pathname === "/repos/acme/other") return jsonResponse(repoInfo("acme/other", "trunk"));
    if (url.pathname === "/repos/acme/tiny/actions/runs") return jsonResponse({ total_count: 1, workflow_runs: [run("31")] });
    if (url.pathname === "/repos/acme/other/actions/runs") return jsonResponse({ total_count: 2, workflow_runs: [run("41", { repository: { full_name: "acme/other" }, head_branch: "trunk" }), run("42", { repository: { full_name: "acme/other" }, head_branch: "trunk" })] });
    return null;
  });
  const [tiny, other] = await Promise.all([
    listFailedWorkflowRuns({ owner: "acme", repo: "tiny", limit: 10 }, access),
    listFailedWorkflowRuns({ owner: "acme", repo: "other", branch: "trunk", limit: 10 }, access)
  ]);
  assert.equal(tiny.repository, "acme/tiny");
  assert.equal(tiny.total_count, 1);
  assert.deepEqual(tiny.runs.map(({ id }) => id), ["31"]);
  assert.ok(!JSON.stringify(tiny).includes("fixture-read-only-token"));
  assert.equal(other.repository, "acme/other");
  assert.equal(other.total_count, 2);
  assert.deepEqual(other.runs.map(({ id }) => id), ["42", "41"]);
  assert.ok(requests.some(({ url }) => url.pathname === "/repos/acme/tiny/actions/runs"));
  assert.ok(requests.some(({ url }) => url.pathname === "/repos/acme/other/actions/runs"));
});

test("wrong repository metadata and run repository are rejected", async (t) => {
  installFetch(t, (url) => {
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo("acme/wrong"));
    return null;
  });
  await assert.rejects(listFailedWorkflowRuns({ owner: "acme", repo: "tiny" }, access), /different repository/i);
  globalThis.fetch = originalFetch;

  installFetch(t, (url) => {
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo());
    if (url.pathname === "/repos/acme/tiny/actions/runs") return jsonResponse({ total_count: 1, workflow_runs: [run("51", { repository: { full_name: "acme/other" } })] });
    return null;
  });
  await assert.rejects(listFailedWorkflowRuns({ owner: "acme", repo: "tiny" }, access), /different repository/i);
});

test("date filters are passed through with pagination, and invalid bounds/pages fail before GitHub", async (t) => {
  let calls = 0;
  installFetch(t, (url) => {
    calls++;
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo());
    if (url.pathname === "/repos/acme/tiny/actions/runs") {
      assert.equal(url.searchParams.get("created"), "2026-11-01..2026-11-10");
      assert.equal(url.searchParams.get("page"), "2");
      assert.equal(url.searchParams.get("per_page"), "3");
      return jsonResponse({ total_count: 4, workflow_runs: [] });
    }
    return null;
  });
  const result = await listFailedWorkflowRuns({ owner: "acme", repo: "tiny", since: "2026-11-01", until: "2026-11-10", page: 2, limit: 3 }, access);
  assert.equal(result.page, 2);
  assert.equal(result.page_size, 3);
  assert.equal(calls, 2);
  for (const args of [
    { since: "2026-02-30" },
    { since: "not-a-date" },
    { since: "2026-11-11", until: "2026-11-10" },
    { page: 1001, limit: 1 }
  ]) {
    await assert.rejects(listFailedWorkflowRuns({ owner: "acme", repo: "tiny", ...args }, access));
  }
  assert.equal(calls, 2);
});

function workflow(id, name, state = "active") {
  return { id, name, path: `.github/workflows/${name.toLowerCase()}.yml`, state };
}

test("getCIStatus reports latest per-workflow branch state, explicit coverage, pagination, and GET-only calls", async (t) => {
  const requests = installFetch(t, (url) => {
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo("acme/tiny", "main"));
    if (url.pathname === "/repos/acme/tiny/actions/workflows") {
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("per_page"), "5");
      return jsonResponse({ total_count: 5, workflows: [
        workflow(1, "Build"), workflow(2, "Lint"), workflow(3, "Queue"), workflow(4, "Disabled", "disabled"), workflow(5, "Empty")
      ] });
    }
    if (url.pathname.endsWith("/workflows/1/runs")) return jsonResponse({ total_count: 2500, workflow_runs: [run("101", { workflow_id: 1, created_at: "2026-11-08T09:00:00Z", conclusion: "failure" }), run("102", { workflow_id: 1, created_at: "2026-11-08T10:00:00Z", conclusion: "success" })] });
    if (url.pathname.endsWith("/workflows/2/runs")) return jsonResponse({ total_count: 2500, workflow_runs: [run("201", { workflow_id: 2, conclusion: "failure" })] });
    if (url.pathname.endsWith("/workflows/3/runs")) return jsonResponse({ total_count: 2500, workflow_runs: [run("301", { workflow_id: 3, status: "queued", conclusion: null })] });
    if (url.pathname.endsWith("/workflows/5/runs")) return jsonResponse({ total_count: 2500, workflow_runs: [] });
    return null;
  });
  const result = await getCIStatus({ owner: "acme", repo: "tiny", limit: 5 }, access);
  assert.equal(result.branch, "main");
  assert.equal(result.returned_workflow_count, 5);
  assert.deepEqual(result.workflows.map(({ current_state }) => current_state), ["success", "failure", "queued", "disabled", "no_runs_on_branch"]);
  assert.deepEqual(result.current_state_counts, { success: 1, failure: 1, queued: 1, disabled: 1, no_runs_on_branch: 1 });
  assert.equal(result.has_more, false, "run total_count must not drive workflow pagination");
  assert.equal(result.next_page, null);
  assert.equal(result.coverage_complete, true);
  assert.ok(!JSON.stringify(result).includes("fixture-read-only-token"));
  assert.ok(requests.every(({ url }) => url.hostname === "api.github.com"));
  assert.ok(requests.every(({ init }) => !JSON.stringify(init).includes("fixture-read-only-token") || init.headers.Authorization));
});

test("getCIStatus makes page and limit explicit and exposes incomplete coverage", async (t) => {
  installFetch(t, (url) => {
    if (url.pathname === "/repos/acme/tiny") return jsonResponse(repoInfo());
    if (url.pathname === "/repos/acme/tiny/actions/workflows") {
      assert.equal(url.searchParams.get("page"), "2");
      assert.equal(url.searchParams.get("per_page"), "2");
      return jsonResponse({ total_count: 5, workflows: [workflow(9, "One"), workflow(10, "Two")] });
    }
    if (url.pathname.endsWith("/workflows/9/runs") || url.pathname.endsWith("/workflows/10/runs")) return jsonResponse({ workflow_runs: [] });
    return null;
  });
  const result = await getCIStatus({ owner: "acme", repo: "tiny", branch: "main", page: 2, limit: 2 }, access);
  assert.equal(result.page, 2);
  assert.equal(result.page_size, 2);
  assert.equal(result.has_more, true);
  assert.equal(result.next_page, 3);
  assert.equal(result.coverage_complete, false);
});
