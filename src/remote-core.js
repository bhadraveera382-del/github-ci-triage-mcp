import { buildEvidence, classifyFailure, githubComparisonSource } from "./evidence.js";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build",
  "coverage", ".next", ".nuxt", ".venv", "venv", "__pycache__",
  "target", "out", "Pods", "DerivedData"
]);
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go",
  ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".lua",
  ".m", ".md", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".scala",
  ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml"
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_REMOTE_SCAN_FILES = 30;
const MAX_FAILURE_LOG_CHARS = 60_000;
const MAX_FAILED_RUNS = 25;
const MAX_SUCCESSFUL_RUNS = 100;
const MAX_EVIDENCE_ITEMS = 3;
const MAX_FAILED_JOBS = 5;
const MAX_JOB_LOG_BYTES = 1_000_000;
const STACK_FILE_RE = /(?:^|[\s(])((?:\.{0,2}\/)?[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|rb|php|cs|cpp|h|hpp|sql|vue|svelte|swift|kt)):(\d+)(?::\d+)?/gim;
const GITHUB_API = "https://api.github.com";

function validateRepoPart(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new Error(`${label} must be a GitHub owner or repository name.`);
  }
  return value;
}

function validateRef(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || value.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`${label} must be a branch, tag, or commit SHA using letters, digits, dot, underscore, slash, or hyphen.`);
  }
  return value;
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(validateRepoPart(owner, "owner"))}/${encodeURIComponent(validateRepoPart(repo, "repo"))}`;
}

function enforceRepositoryAccess(owner, repo, access) {
  validateRepoPart(owner, "owner");
  validateRepoPart(repo, "repo");
  const slug = `${owner}/${repo}`.toLowerCase();
  const allowed = access.allowedRepos;
  if (access.token && (!(allowed instanceof Set) || allowed.size === 0)) {
    throw new Error("Authenticated GitHub access requires a configured repository allowlist.");
  }
  const wildcardAccess = Boolean(access.token) && allowed instanceof Set && allowed.size === 1 && allowed.has("*");
  if (allowed instanceof Set && !wildcardAccess && !allowed.has(slug)) {
    throw new Error("This repository is not enabled for this hosted connector.");
  }
}

async function githubJson(pathname, access = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-ci-triage-mcp"
  };
  if (access.token) headers.Authorization = `Bearer ${access.token}`;
  const response = await fetch(`${GITHUB_API}${pathname}`, { headers, redirect: "manual" });
  if (!response.ok) {
    const isActionsEndpoint = pathname.includes("/actions/");
    if (response.status === 401) throw new Error("GitHub rejected the server-side repository credential. It may be expired or revoked.");
    if (response.status === 403 || response.status === 429) {
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        throw new Error("GitHub's API rate limit has been reached. Do not retry until its reset window.");
      }
      throw new Error(`GitHub refused the read. Check the server-side token's read-only repository permissions${isActionsEndpoint ? ", including Actions: read" : ""}.`);
    }
    if (response.status === 404) throw new Error("Repository, run, job, or ref not found, or the server token is not allowed to read it.");
    if (response.status === 451) throw new Error("GitHub refused access to this repository.");
    throw new Error(`GitHub API request failed (${response.status}).`);
  }
  return response.json();
}

function validateRunId(value) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("run_id must be a numeric GitHub Actions run ID.");
  const runId = String(value);
  if (!/^\d{1,20}$/.test(runId)) throw new Error("run_id must be a numeric GitHub Actions run ID.");
  return runId;
}

function summarizeWorkflowRun(run) {
  return {
    id: String(run.id),
    name: run.name || run.path || "Unnamed workflow",
    workflow_id: run.workflow_id,
    run_number: run.run_number,
    run_attempt: run.run_attempt || 1,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch || null,
    event: run.event || null,
    head_sha: run.head_sha || null,
    created_at: run.created_at || null,
    html_url: run.html_url || null
  };
}

// Large filtered Actions searches can report 2,500+ instead of an exact total.
// Never coerce that sentinel into either 2,500 exact failures or a page length.
function workflowCount(raw, incomplete = false) {
  const text = typeof raw === "string" ? raw.replaceAll(",", "").trim() : "";
  const capped = text.match(/^(\d+)\+$/);
  const number = typeof raw === "number" ? raw : (/^\d+$/.test(text) ? Number(text) : NaN);
  if (capped || (Number.isSafeInteger(number) && number >= 2500)) {
    return { total_count: null, count_accuracy: "lower_bound", total_count_lower_bound: capped ? Number(capped[1]) : number };
  }
  if (!incomplete && Number.isSafeInteger(number) && number >= 0) {
    return { total_count: number, count_accuracy: "api_reported_exact", total_count_lower_bound: null };
  }
  return { total_count: null, count_accuracy: "unknown", total_count_lower_bound: null };
}

function assertRunRepository(run, owner, repo) {
  const returnedRepo = run?.repository?.full_name;
  if (returnedRepo && returnedRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error("GitHub returned a workflow run for a different repository; no result was accepted.");
  }
}

function newestRuns(runs) {
  return [...runs].sort((a, b) => (runTimestamp(b.created_at) ?? 0) - (runTimestamp(a.created_at) ?? 0)
    || String(b.id).length - String(a.id).length || String(b.id).localeCompare(String(a.id)));
}

function dateFilter(since, until) {
  const validate = (value, label) => {
    if (value === undefined) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error(`${label} must be a UTC ISO date or timestamp (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ).`);
    }
    // Reject normalized invalid calendar dates such as February 30.
    if (new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error(`${label} is not a valid calendar date.`);
    return value;
  };
  const start = validate(since, "since");
  const end = validate(until, "until");
  if (start && end && Date.parse(start) > Date.parse(end)) throw new Error("since must not be later than until.");
  return start && end ? `${start}..${end}` : start ? `>=${start}` : end ? `<=${end}` : null;
}

export async function listFailedWorkflowRuns({ owner, repo, branch, limit = 10, page = 1, since, until } = {}, access = {}) {
  const created = dateFilter(since, until);
  if (branch) validateRef(branch, "branch");
  const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || 10), MAX_FAILED_RUNS));
  const safePage = Number(page);
  if (!Number.isInteger(safePage) || safePage < 1 || safePage * safeLimit > 1000) throw new Error("page and limit must select within GitHub's 1,000-result filtered-search limit; narrow since/until for older history.");
  await requireRepo(owner, repo, access);
  const query = new URLSearchParams({ status: "failure", per_page: String(safeLimit), page: String(safePage) });
  if (branch) query.set("branch", branch);
  if (created) query.set("created", created);
  const result = await githubJson(`${repoPath(owner, repo)}/actions/runs?${query}`, access);
  if (!Array.isArray(result.workflow_runs)) throw new Error("GitHub returned an invalid workflow-run list; no count was accepted.");
  for (const run of result.workflow_runs) assertRunRepository(run, owner, repo);
  const startTime = since ? Date.parse(since) : null;
  const endTime = until ? Date.parse(until.length === 10 ? `${until}T23:59:59.999Z` : until) : null;
  const matches = result.workflow_runs.filter((run) => {
    const timestamp = runTimestamp(run?.created_at);
    return run?.status === "completed" && run?.conclusion === "failure" && (!branch || run.head_branch === branch)
      && (startTime === null || (timestamp !== null && timestamp >= startTime))
      && (endTime === null || (timestamp !== null && timestamp <= endTime));
  });
  const end = (safePage - 1) * safeLimit + result.workflow_runs.length;
  const reported = workflowCount(result.total_count, result.incomplete_results === true);
  const inconsistent = matches.length !== result.workflow_runs.length || (matches.length > 0 && reported.total_count !== null && reported.total_count < end);
  const counts = inconsistent ? { total_count: null, count_accuracy: "unknown", total_count_lower_bound: null } : reported;
  const runs = newestRuns(matches).slice(0, safeLimit).map(summarizeWorkflowRun);
  const more = counts.count_accuracy === "lower_bound" || (counts.total_count !== null ? counts.total_count > end : result.workflow_runs.length >= safeLimit);
  return {
    repository: `${owner}/${repo}`,
    filters: { conclusion: "failure", branch: branch || null, since: since || null, until: until || null },
    page: safePage,
    page_size: safeLimit,
    ...counts,
    returned_count: runs.length,
    runs,
    results_truncated: safePage > 1 || more || inconsistent,
    has_more: more,
    next_page: more && (safePage + 1) * safeLimit <= 1000 ? safePage + 1 : null,
    excluded_unexpected_runs: result.workflow_runs.length - matches.length,
    count_scope: "Historical failed workflow runs matching these filters, not failing tests, current CI problems, or runs inspected in detail.",
    note: counts.count_accuracy === "lower_bound"
      ? "GitHub's large-search count is a lower bound, not an exact total. Narrow since/until to obtain smaller counts. Only returned_count is the exact number of verified failures on this page."
      : "Only returned_count is the exact number of verified failures on this page. Historical failures may have been fixed by newer runs; use get_ci_status for current workflow state."
  };
}

export async function getCIStatus({ owner, repo, branch, page = 1, limit = 20 } = {}, access = {}) {
  const info = await requireRepo(owner, repo, access);
  const selectedBranch = validateRef(branch || info.default_branch, "branch");
  if (!Number.isInteger(page) || page < 1 || page > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("page must be 1–1000 and limit must be 1–20.");
  const path = repoPath(owner, repo);
  const data = await githubJson(`${path}/actions/workflows?per_page=${limit}&page=${page}`, access);
  if (!Array.isArray(data.workflows)) throw new Error("GitHub returned an invalid workflow list; current CI state is unknown.");
  if (data.workflows.length > limit) throw new Error("GitHub returned more workflows than requested; no partial current state was accepted.");
  const workflows = [];
  // Bound fan-out below the Worker's subrequest limit; no history total is used.
  for (let offset = 0; offset < data.workflows.length; offset += 4) {
    const batch = await Promise.all(data.workflows.slice(offset, offset + 4).map(async (workflow) => {
      const row = { workflow_id: workflow.id, name: workflow.name, path: workflow.path, workflow_state: workflow.state };
      if (workflow.state !== "active") return { ...row, current_state: "disabled", latest_run: null };
      const query = new URLSearchParams({ branch: selectedBranch, per_page: "1" });
      const result = await githubJson(`${path}/actions/workflows/${encodeURIComponent(String(workflow.id))}/runs?${query}`, access);
      if (!Array.isArray(result.workflow_runs)) throw new Error("GitHub returned an invalid current workflow-run list.");
      for (const run of result.workflow_runs) {
        assertRunRepository(run, owner, repo);
        if (String(run.workflow_id) !== String(workflow.id) || run.head_branch !== selectedBranch) throw new Error("GitHub returned a run outside the requested workflow or branch; current state was not accepted.");
      }
      const run = newestRuns(result.workflow_runs)[0];
      return { ...row, current_state: run ? (run.status === "completed" ? run.conclusion || "unknown" : run.status || "unknown") : "no_runs_on_branch", latest_run: run ? summarizeWorkflowRun(run) : null };
    }));
    workflows.push(...batch);
  }
  const knownTotal = Number.isSafeInteger(data.total_count) && data.total_count >= workflows.length ? data.total_count : null;
  const hasMore = knownTotal === null ? data.workflows.length >= limit : page * limit < knownTotal;
  const counts = {};
  for (const workflow of workflows) counts[workflow.current_state] = (counts[workflow.current_state] || 0) + 1;
  return {
    repository: `${owner}/${repo}`, branch: selectedBranch, observed_at: new Date().toISOString(),
    workflows, returned_workflow_count: workflows.length, current_state_counts: counts,
    page, page_size: limit, has_more: hasMore, next_page: hasMore ? page + 1 : null,
    coverage_complete: page === 1 && !hasMore,
    note: "Latest run per listed workflow on the selected branch, not historical failure totals. Disabled workflows and workflows with no runs are not passing. A latest run can be older than the branch tip; inspect head_sha and created_at before treating it as validation of current code. No workflow was triggered or changed."
  };
}

function trimFailureLog(log) {
  if (log.length <= MAX_FAILURE_LOG_CHARS) return log;
  const marker = "\n...[middle of job logs omitted]...\n";
  const headLength = 8_000;
  const tailLength = MAX_FAILURE_LOG_CHARS - headLength - marker.length;
  return `${log.slice(0, headLength)}${marker}${log.slice(-tailLength)}`;
}

async function readBoundedJobLog(response) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = MAX_JOB_LOG_BYTES - bytesRead;
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, Math.max(remaining, 0)), { stream: true });
        bytesRead = MAX_JOB_LOG_BYTES;
        truncated = true;
        await reader.cancel();
        break;
      }
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
    reader.releaseLock();
  }
  const boundedText = trimFailureLog(text);
  return { text: boundedText, truncated: truncated || boundedText.length < text.length,
    byte_limit_reached: truncated, character_limit_reached: boundedText.length < text.length };
}

async function downloadJobLog(repositoryPath, jobId, access) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-ci-triage-mcp"
  };
  if (access.token) headers.Authorization = `Bearer ${access.token}`;
  const response = await fetch(`${GITHUB_API}${repositoryPath}/actions/jobs/${encodeURIComponent(String(jobId))}/logs`, {
    headers,
    redirect: "manual"
  });
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0") throw new Error("GitHub's API rate limit has been reached. Do not retry until its reset window.");
    throw new Error("GitHub refused the job-log read. Check that the server-side token has Actions: read for this repository.");
  }
  if (response.status === 404) throw new Error("GitHub could not find these job logs, or the server-side token lacks Actions: read permission.");
  if (response.status !== 302) throw new Error(`GitHub job-log download failed (${response.status}).`);

  const location = response.headers.get("location");
  if (!location) throw new Error("GitHub returned a job-log redirect without a download URL.");
  let downloadUrl;
  try {
    downloadUrl = new URL(location);
  } catch {
    throw new Error("GitHub returned an invalid job-log download URL.");
  }
  const allowedHost = downloadUrl.hostname === "pipelines.actions.githubusercontent.com"
    || downloadUrl.hostname.endsWith(".actions.githubusercontent.com")
    || downloadUrl.hostname.endsWith(".githubusercontent.com")
    || downloadUrl.hostname.endsWith(".amazonaws.com");
  if (downloadUrl.protocol !== "https:" || !allowedHost || downloadUrl.port || downloadUrl.username || downloadUrl.password) {
    throw new Error("GitHub returned a job-log URL outside the approved HTTPS download hosts.");
  }

  // The temporary signed URL is fetched without forwarding the server-side GitHub credential.
  const download = await fetch(downloadUrl.href, { headers: { Accept: "text/plain" }, redirect: "error" });
  if (!download.ok) throw new Error(`The temporary GitHub job-log download failed (${download.status}).`);
  return readBoundedJobLog(download);
}

async function fetchFailedRunLog({ owner, repo, runId, branch }, access = {}) {
  await requireRepo(owner, repo, access);
  if (branch) validateRef(branch, "branch");
  const path = repoPath(owner, repo);
  let run;
  if (runId !== undefined && runId !== null && runId !== "") {
    const safeRunId = validateRunId(runId);
    run = await githubJson(`${path}/actions/runs/${safeRunId}`, access);
    if (String(run.id) !== safeRunId) throw new Error("GitHub returned a different workflow run than requested.");
    if (branch && run.head_branch !== branch) throw new Error("The selected workflow run is not on the requested branch.");
  } else {
    const query = new URLSearchParams({ status: "failure", per_page: "10" });
    if (branch) query.set("branch", branch);
    const result = await githubJson(`${path}/actions/runs?${query}`, access);
    const candidates = Array.isArray(result.workflow_runs) ? result.workflow_runs : [];
    for (const candidate of candidates) assertRunRepository(candidate, owner, repo);
    run = newestRuns(candidates.filter((item) => item?.status === "completed" && item?.conclusion === "failure" && (!branch || item.head_branch === branch)))[0];
    if (!run) throw new Error("No completed failed GitHub Actions run was found for this repository and branch.");
  }
  assertRunRepository(run, owner, repo);
  if (run.status !== "completed" || run.conclusion !== "failure") {
    throw new Error("The selected GitHub Actions run is not a completed failure; no logs were fetched.");
  }

  const safeRunId = validateRunId(run.id);
  const jobsData = await githubJson(`${path}/actions/runs/${safeRunId}/jobs?filter=latest&per_page=100`, access);
  if (!Array.isArray(jobsData.jobs)) throw new Error("GitHub returned no valid jobs list; job evidence is unavailable.");
  for (const job of jobsData.jobs) {
    if (job.run_id != null && String(job.run_id) !== safeRunId) throw new Error("GitHub returned a job from a different run; no log evidence was accepted.");
    if (job.run_attempt != null && run.run_attempt != null && job.run_attempt !== run.run_attempt) throw new Error("GitHub returned jobs from a different run attempt; no log evidence was accepted.");
  }
  const failedJobs = (Array.isArray(jobsData.jobs) ? jobsData.jobs : [])
    .filter((job) => ["failure", "timed_out", "action_required"].includes(job?.conclusion));
  if (!failedJobs.length) throw new Error("GitHub reported a failed run but no failed job was available to read.");

  const selectedJobs = failedJobs.slice(0, MAX_FAILED_JOBS);
  const logs = await Promise.all(selectedJobs.map(async (job) => ({
    job,
    ...await downloadJobLog(path, job.id, access)
  })));
  const joinedLog = logs.map(({ text }) => text).join("\n\n");
  const failureLog = trimFailureLog(joinedLog);
  const pullRequest = Array.isArray(run.pull_requests)
    ? run.pull_requests.find((item) => item?.base?.sha && (item?.head?.sha || run.head_sha))
    : null;

  return {
    run,
    failureLog,
    baseRef: pullRequest?.base?.sha || null,
    headRef: pullRequest?.head?.sha || run.head_sha || null,
    failedJobCount: failedJobs.length,
    failedJobs: logs.map(({ job, truncated }) => ({
      id: String(job.id),
      name: job.name || "Unnamed job",
      conclusion: job.conclusion,
      html_url: job.html_url || null,
      log_truncated: truncated
    })),
    logDocuments: logs.map(({ job, text, truncated, byte_limit_reached, character_limit_reached }) => ({
      id: `job:${safeRunId}:${job.id}`, type: "github_actions_job_log", text,
      url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${safeRunId}/job/${encodeURIComponent(String(job.id))}`,
      run_id: safeRunId, selected_run_attempt: run.run_attempt || 1, job_run_attempt: job.run_attempt ?? null,
      attempt_attribution: job.run_attempt != null ? "job_metadata_matches_selected_run" : "latest_jobs_endpoint_not_independently_attempt_pinned",
      job_id: String(job.id), job_name: job.name || "Unnamed job", workflow_id: run.workflow_id || null,
      branch: run.head_branch || null, event: run.event || null, run_created_at: run.created_at || null,
      selected_run_head_sha: run.head_sha || null, job_head_sha: job.head_sha || null,
      log_truncated: truncated, byte_limit_reached, character_limit_reached,
      line_number_scope: "bounded_job_log_excerpt_not_original_log_or_github_anchor"
    })),
    jobsListMayBeIncomplete: Number.isSafeInteger(jobsData.total_count) ? jobsData.total_count > (jobsData.jobs || []).length : (jobsData.jobs || []).length >= 100,
    omittedFailedJobs: Math.max(0, failedJobs.length - selectedJobs.length),
    logsTruncated: logs.some((item) => item.truncated) || failureLog.length < joinedLog.length,
    combinedLogTruncated: failureLog.length < joinedLog.length
  };
}

async function requireRepo(owner, repo, access) {
  enforceRepositoryAccess(owner, repo, access);
  const info = await githubJson(repoPath(owner, repo), access);
  if (info.full_name && info.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error("GitHub returned a different repository than requested; no data was accepted.");
  if (!access.token && info.private !== false) {
    throw new Error("Private repository access requires a configured server-side GitHub credential.");
  }
  return info;
}

function isSearchablePath(filePath) {
  const segments = filePath.split("/");
  if (segments.some((segment) => segment.startsWith(".") && segment !== ".github")) return false;
  if (segments.slice(0, -1).some((segment) => SKIP_DIRS.has(segment))) return false;
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension);
}

function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function extractFileReferences(log) {
  const references = [];
  for (const match of log.matchAll(STACK_FILE_RE)) {
    references.push({ path: normalizeRelative(match[1]), line: Number(match[2]) });
  }
  const unique = new Map();
  for (const ref of references) unique.set(`${ref.path}:${ref.line}`, ref);
  return [...unique.values()].slice(0, 40);
}

function extractFailureLines(log) {
  return log.split(/\r?\n/)
    .filter((line) => /\b(?:FAIL|FAILED|ERROR|AssertionError|TypeError|SyntaxError)\b|✗|✕|×/.test(line.trim()))
    .slice(0, 12)
    .map((line) => line.trim().slice(0, 400));
}

function symbolsFromLog(log) {
  const symbols = new Set();
  for (const line of log.split(/\r?\n/)) {
    const frame = line.match(/\bat\s+(?:new\s+)?([\w$.[\]<>]+)/);
    if (!frame) continue;
    const symbol = frame[1].split(".").at(-1).replace(/[^\w$]/g, "");
    if (symbol.length >= 3 && !["anonymous", "Object", "Module"].includes(symbol)) symbols.add(symbol);
  }
  return [...symbols].slice(0, 20);
}

function matchesReference(changedPath, references) {
  const candidate = normalizeRelative(changedPath);
  return references.some((ref) => {
    const refPath = normalizeRelative(ref.path);
    return candidate === refPath || refPath.endsWith(`/${candidate}`) || candidate.endsWith(`/${refPath}`);
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedLogQuotes(path, log, references, symbols = []) {
  const lines = log.split(/\r?\n/);
  const normalizedPath = normalizeRelative(path).toLowerCase();
  const name = normalizedPath.split("/").at(-1);
  const pathReferences = references.filter((item) => normalizeRelative(item.path).toLowerCase() === normalizedPath);
  const wantedSymbols = symbols.length ? symbols : symbolsFromLog(log);
  const quotes = [];
  for (const [index, line] of lines.entries()) {
    const normalizedLine = normalizeRelative(line).toLowerCase();
    const pathMatch = normalizedLine.includes(normalizedPath) || (name.length > 3 && normalizedLine.includes(name));
    const symbolMatch = wantedSymbols.some((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line));
    if (pathMatch || (pathReferences.length > 0 && symbolMatch)) {
      const text = line.trim();
      if (text) quotes.push({ line: index + 1, text: text.slice(0, 400) });
    }
    if (quotes.length >= MAX_EVIDENCE_ITEMS) break;
  }
  return quotes;
}

function patchSnippets(patch, symbols = []) {
  const lines = String(patch || "").split(/\r?\n/)
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"));
  const relevant = symbols.length
    ? lines.filter((line) => symbols.some((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line)))
    : [];
  return (relevant.length ? relevant : lines).slice(0, MAX_EVIDENCE_ITEMS).map((text) => text.slice(0, 400));
}

function scoreChangedFiles(changedFiles, references, symbols, log) {
  const scores = [];
  for (const item of changedFiles) {
    let score = 0;
    const evidence = [];
    const matchKinds = [];
    const logQuotes = boundedLogQuotes(item.path, log, references, symbols);
    const diffSnippets = patchSnippets(item.patch, symbols);
    if (matchesReference(item.path, references)) {
      score += 100;
      evidence.push("path appears in a stack trace");
      matchKinds.push("stack_path_overlap");
    }
    const base = item.path.split("/").at(-1).toLowerCase();
    if (base.length > 3 && log.toLowerCase().includes(base)) {
      score += 20;
      evidence.push("filename is mentioned in the failure log");
      matchKinds.push("filename_mention");
    }
    const patch = typeof item.patch === "string" ? item.patch : "";
    const changedLines = patch.split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line)).join("\n");
    const hits = symbols.filter((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(changedLines));
    if (hits.length) {
      score += Math.min(hits.length * 8, 32);
      evidence.push(`changed diff lines contain stack-frame symbol${hits.length === 1 ? "" : "s"}: ${hits.join(", ")}`);
      matchKinds.push("changed_line_symbol_overlap");
    }
    if (score > 0) scores.push({ path: item.path, status: item.status, score, evidence, match_kinds: matchKinds, matching_symbols: hits,
      score_interpretation: "heuristic_ranking_points_not_probability", log_quotes: logQuotes, diff_snippets: diffSnippets,
      log_quote_line_number_scope: "combined_analyzed_excerpt_not_original_log", legacy_snippets_may_be_truncated: true });
  }
  scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scores.slice(0, 15);
}

export async function searchGitHubCode({ owner, repo, ref, query, caseSensitive = false, maxResults = 50 }, access = {}) {
  const safeQuery = String(query ?? "").trim();
  if (!safeQuery || safeQuery.length > 200) throw new Error("query must contain 1–200 characters.");
  const safeMax = Math.max(1, Math.min(Number(maxResults) || 50, 100));
  const info = await requireRepo(owner, repo, access);
  const selectedRef = ref ? validateRef(ref, "ref") : info.default_branch;
  const base = repoPath(owner, repo);
  const commit = await githubJson(`${base}/commits/${encodeURIComponent(selectedRef)}`, access);
  const tree = await githubJson(`${base}/git/trees/${encodeURIComponent(commit.sha)}?recursive=1`, access);
  const eligible = (tree.tree || [])
    .filter((entry) => entry.type === "blob" && Number(entry.size) <= MAX_FILE_BYTES && isSearchablePath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const scanLimitReached = Boolean(tree.truncated) || eligible.length > MAX_REMOTE_SCAN_FILES;
  const files = eligible.slice(0, MAX_REMOTE_SCAN_FILES);
  const results = [];
  let filesScanned = 0;
  let filesSkippedAsLargeOrBinary = (tree.tree || []).filter((entry) => entry.type === "blob" && isSearchablePath(entry.path) && Number(entry.size) > MAX_FILE_BYTES).length;
  let totalMatches = 0;
  const wanted = caseSensitive ? safeQuery : safeQuery.toLocaleLowerCase();
  const scanOne = async (entry) => {
    const blob = await githubJson(`${base}/git/blobs/${encodeURIComponent(entry.sha)}`, access);
    if (blob.encoding !== "base64" || Number(blob.size) > MAX_FILE_BYTES) return null;
    const bytes = Uint8Array.from(atob(String(blob.content || "").replace(/\s/g, "")), (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_FILE_BYTES) return null;
    const content = new TextDecoder().decode(bytes);
    if (content.includes("\u0000")) return null;
    return content;
  };
  const contents = await Promise.all(files.map((entry) => scanOne(entry)));
  for (let index = 0; index < files.length; index++) {
    const content = contents[index];
    if (content == null) {
      filesSkippedAsLargeOrBinary++;
      continue;
    }
    filesScanned++;
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const haystack = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLocaleLowerCase();
      if (!haystack.includes(wanted)) continue;
      totalMatches++;
      if (results.length < safeMax) {
        results.push({ path: files[index].path, line: lineIndex + 1, text: lines[lineIndex].trim().slice(0, 500) });
      }
    }
  }
  return {
    repository: `${owner}/${repo}`,
    ref: commit.sha,
    files_scanned: filesScanned,
    files_skipped_as_large_or_binary: filesSkippedAsLargeOrBinary,
    total_matches: totalMatches,
    results,
    results_truncated: totalMatches > results.length,
    scan_limit_reached: scanLimitReached,
    scan_limit: MAX_REMOTE_SCAN_FILES,
    note: scanLimitReached ? `Only the first ${MAX_REMOTE_SCAN_FILES} eligible files in path order were scanned.` : "Only repository files on the selected ref were read."
  };
}

async function comparisonRefs({ baseRef, headRef, run, repositoryPath, access }) {
  if (Boolean(baseRef) !== Boolean(headRef)) throw new Error("Provide both base_ref and head_ref.");
  if (baseRef && headRef) return { base: validateRef(baseRef, "base_ref"), head: validateRef(headRef, "head_ref") };
  if (!run) throw new Error("The hosted connector requires both base_ref and head_ref when failure_log is supplied.");
  const pullRequest = Array.isArray(run.pull_requests)
    ? run.pull_requests.find((item) => item?.base?.sha && (item?.head?.sha || run.head_sha))
    : null;
  if (pullRequest) {
    return { base: validateRef(pullRequest.base.sha, "base_ref"), head: validateRef(pullRequest.head.sha || run.head_sha, "head_ref") };
  }
  if (!run.head_sha) throw new Error("The selected run has no head SHA; supply both base_ref and head_ref to compare it.");
  const commit = await githubJson(`${repositoryPath}/commits/${encodeURIComponent(run.head_sha)}`, access);
  const parent = Array.isArray(commit.parents) ? commit.parents[0]?.sha : null;
  if (!parent) throw new Error("Could not infer a base commit for this run; supply both base_ref and head_ref.");
  return { base: validateRef(parent, "base_ref"), head: validateRef(run.head_sha, "head_ref") };
}

function pullRequestIdentity(run) {
  const pr = Array.isArray(run?.pull_requests) ? run.pull_requests[0] : null;
  if (!pr) return null;
  return pr.number != null ? `number:${pr.number}` : (pr.url || pr.html_url || (pr.head?.ref && pr.base?.ref ? `refs:${pr.base.ref}->${pr.head.ref}` : null));
}

function runTimestamp(value) {
  const timestamp = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectedPullRequestHeadSha(run) {
  const pullRequest = Array.isArray(run?.pull_requests)
    ? run.pull_requests.find((item) => typeof item?.head?.sha === "string" && item.head.sha)
    : null;
  return pullRequest?.head?.sha || null;
}

function sameBaselineRun(candidate, failedRun, failedPrIdentity, failedTimestamp) {
  if (!candidate || String(candidate.id) === String(failedRun.id) || candidate.status !== "completed" || candidate.conclusion !== "success") return false;
  if (String(candidate.workflow_id) !== String(failedRun.workflow_id)) return false;
  if ((candidate.head_branch || null) !== (failedRun.head_branch || null)) return false;
  if ((candidate.event || null) !== (failedRun.event || null)) return false;
  if (failedPrIdentity && pullRequestIdentity(candidate) !== failedPrIdentity) return false;
  const candidateTimestamp = runTimestamp(candidate.created_at);
  if (candidateTimestamp === null || failedTimestamp === null || candidateTimestamp >= failedTimestamp) return false;
  return Boolean(candidate.head_sha);
}

function comparisonFiles(data) {
  if (!Array.isArray(data?.files) || data.files.some((file) => typeof file?.filename !== "string" || !file.filename)) {
    throw new Error("GitHub returned no valid changed-file list; comparison evidence is unavailable, not an empty change.");
  }
  return (Array.isArray(data?.files) ? data.files : []).map((file) => ({
    status: file.status === "renamed" ? "R" : file.status === "added" ? "A" : file.status === "removed" ? "D" : "M",
    path: normalizeRelative(file.filename),
    patch: typeof file.patch === "string" ? file.patch : ""
  }));
}

async function findSuccessfulBaseline({ failedRun, repositoryPath, access, owner, repo }) {
  const metadata = { workflow_id: failedRun.workflow_id, branch: failedRun.head_branch || null, event: failedRun.event || null, pull_request: pullRequestIdentity(failedRun) };
  const failedTimestamp = runTimestamp(failedRun.created_at);
  if (!failedRun.workflow_id || !failedRun.head_branch || !failedRun.event || failedTimestamp === null) {
    return { status: "unavailable", reason: "missing_failed_run_metadata", metadata, search_capped: false };
  }
  const query = new URLSearchParams({ status: "success", branch: failedRun.head_branch, event: failedRun.event, per_page: String(MAX_SUCCESSFUL_RUNS), created: `<=${failedRun.created_at}` });
  const workflowPath = `${repositoryPath}/actions/workflows/${encodeURIComponent(String(failedRun.workflow_id))}/runs`;
  const result = await githubJson(`${workflowPath}?${query}`, access);
  const runs = Array.isArray(result.workflow_runs) ? result.workflow_runs : [];
  for (const candidate of runs) assertRunRepository(candidate, owner, repo);
  const failedPrIdentity = pullRequestIdentity(failedRun);
  const eligible = runs.filter((candidate) => sameBaselineRun(candidate, failedRun, failedPrIdentity, failedTimestamp));
  eligible.sort((a, b) => runTimestamp(b.created_at) - runTimestamp(a.created_at));
  const baseline = eligible[0];
  const count = workflowCount(result.total_count, result.incomplete_results === true);
  const searchCapped = runs.length >= MAX_SUCCESSFUL_RUNS || count.count_accuracy !== "api_reported_exact" || count.total_count > runs.length;
  if (!baseline) return { status: "unavailable", reason: "no_eligible_successful_run_in_history", metadata, search_capped: searchCapped };
  return { status: "selected", run: summarizeWorkflowRun(baseline), rawRun: baseline, metadata, search_capped: searchCapped };
}

async function compareBaseline({ baseline, failedRun, repositoryPath, access, failureLog, references, symbols, owner, repo, documents, failure }) {
  if (baseline.status !== "selected") return baseline;
  const baselineHead = selectedPullRequestHeadSha(baseline.rawRun) || baseline.rawRun.head_sha;
  const failedHead = selectedPullRequestHeadSha(failedRun) || failedRun.head_sha;
  if (!baselineHead || !failedHead) return { ...baseline, status: "unavailable", reason: "missing_comparison_head_sha" };
  const comparisonData = await githubJson(`${repositoryPath}/compare/${encodeURIComponent(baselineHead)}...${encodeURIComponent(failedHead)}`, access);
  const files = comparisonFiles(comparisonData);
  const missingPatchFiles = files.filter((file) => !file.patch).map((file) => file.path);
  const comparisonFileListCapped = files.length >= 300;
  const ranked = scoreChangedFiles(files, references, symbols, failureLog);
  return {
    status: "selected",
    run: baseline.run,
    comparison: `${baselineHead}...${failedHead}`,
    changed_file_count: files.length,
    changed_files: files.slice(0, 100).map(({ status, path }) => ({ status, path })),
    changed_files_truncated: files.length > 100,
    likely_related_changed_files: ranked,
    search_capped: baseline.search_capped,
    non_linear: comparisonData.status ? ["behind", "diverged"].includes(comparisonData.status) : null,
    comparison_status: comparisonData.status || null,
    comparison_ahead_by: comparisonData.ahead_by ?? null,
    comparison_behind_by: comparisonData.behind_by ?? null,
    patches_incomplete: missingPatchFiles.length > 0,
    missing_patch_files: missingPatchFiles,
    comparison_file_list_capped: comparisonFileListCapped,
    ...buildEvidence({ scope: "baseline", documents, changedFiles: files, rankedFiles: ranked, failure,
      comparisonSource: githubComparisonSource({ scope: "baseline", owner, repo, base: baselineHead, head: failedHead, data: comparisonData,
        basis: "selected_older_success_same_workflow_branch_event_and_available_pr_identity" }) }),
    note: "Baseline compares the selected older successful run head to the failed run head; it is a heuristic reference, not proof of causation."
  };
}

export async function triageGitHubFailure({ owner, repo, failureLog, runId, branch, baseRef, headRef }, access = {}) {
  const suppliedLog = typeof failureLog === "string" && Boolean(failureLog.trim());
  if (failureLog !== undefined && !suppliedLog) throw new Error("failure_log must not be empty when provided.");
  if (suppliedLog && (runId !== undefined || branch !== undefined)) throw new Error("Use either failure_log or GitHub Actions run selection, not both.");
  enforceRepositoryAccess(owner, repo, access);
  const path = repoPath(owner, repo);
  await requireRepo(owner, repo, access);

  let fetched = null;
  let log;
  if (suppliedLog) {
    if (Boolean(baseRef) !== Boolean(headRef)) throw new Error("Provide both base_ref and head_ref.");
    if (!baseRef || !headRef) throw new Error("The hosted connector requires both base_ref and head_ref when failure_log is supplied.");
    log = failureLog;
    if (log.length > MAX_FAILURE_LOG_CHARS) throw new Error(`failure_log must be no longer than ${MAX_FAILURE_LOG_CHARS} characters.`);
  } else {
    fetched = await fetchFailedRunLog({ owner, repo, runId, branch }, access);
    log = fetched.failureLog;
  }
  if (!log.trim()) throw new Error("The selected GitHub Actions failure logs were empty.");
  const refs = await comparisonRefs({ baseRef, headRef, run: fetched?.run, repositoryPath: path, access });
  const base = refs.base;
  const head = refs.head;
  const comparisonData = await githubJson(`${path}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, access);
  const allChangedFiles = comparisonFiles(comparisonData);
  const references = extractFileReferences(log);
  const symbols = symbolsFromLog(log);
  const likelyChangedFiles = scoreChangedFiles(allChangedFiles, references, symbols, log);
  const failure = classifyFailure(log);
  const failureLines = extractFailureLines(log);
  const documents = fetched ? fetched.logDocuments : [{ id: "provided_log", type: "caller_supplied_log", text: log,
    url: null, authenticity: "not_independently_verified", log_truncated: false,
    line_number_scope: "caller_supplied_excerpt_not_original_ci_log" }];
  const directFileMatches = likelyChangedFiles.filter((item) => item.match_kinds.includes("stack_path_overlap"));
  const baseline = fetched
    ? await compareBaseline({ baseline: await findSuccessfulBaseline({ failedRun: fetched.run, repositoryPath: path, access, owner, repo }), failedRun: fetched.run, repositoryPath: path, access, failureLog: log, references, symbols, owner, repo, documents, failure })
    : { status: "not_applicable", reason: "provided_log_mode" };
  let summary;
  if (likelyChangedFiles.length) {
    summary = `${failure.summary} ${directFileMatches.length ? "Stack-trace paths overlap the changed files." : "Changed-file names or GitHub diff snippets provide a possible connection."}`;
  } else if (allChangedFiles.length) {
    summary = `${failure.summary} No overlap was found in the inspected path, filename, or changed-line-symbol evidence; incomplete evidence may hide a connection.`;
  } else {
    summary = `${failure.summary} The compare response returned no file entries for ${base}...${head}; this is not a root-cause finding.`;
  }
  return {
    repository: `${owner}/${repo}`,
    comparison: `${base}...${head}`,
    failure_category: failure.category,
    summary,
    evidence_strength: directFileMatches.length ? "direct_stack_path_overlap_not_proof_of_cause" : likelyChangedFiles.length ? "weak_filename_or_symbol_correlation" : "no_changed_file_connection_found",
    current_ci_state: "not_established_by_historical_failure_triage",
    changed_file_count: allChangedFiles.length,
    changed_files: allChangedFiles.slice(0, 100).map(({ status, path: filePath }) => ({ status, path: filePath })),
    changed_files_truncated: allChangedFiles.length > 100,
    likely_related_changed_files: likelyChangedFiles,
    stack_trace_files: references,
    failure_evidence: failureLines,
    ...buildEvidence({ documents, changedFiles: allChangedFiles, rankedFiles: likelyChangedFiles, failure,
      comparisonSource: githubComparisonSource({ owner, repo, base, head, data: comparisonData,
        basis: baseRef && headRef ? "caller_provided_refs" : fetched?.baseRef ? "linked_pull_request_base_and_head" : "failed_run_first_parent_and_head" }) }),
    analysis_coverage: {
      changed_file_count_scope: "files_returned_by_compare_api_not_guaranteed_total", comparison_file_list_may_be_capped: allChangedFiles.length >= 300,
      missing_patch_files: allChangedFiles.filter((file) => !file.patch).map((file) => file.path),
      patches_incomplete: allChangedFiles.some((file) => !file.patch),
      log_comparison_head_attribution: suppliedLog ? "caller_supplied_log_not_linked_to_a_verified_run" : baseRef && headRef ? "caller_provided_refs_not_verified_against_selected_run_head" : "inferred_from_selected_run_metadata",
      combined_log_truncated: fetched?.combinedLogTruncated || false,
      ranking_log_scope: "combined_analyzed_excerpt", evidence_quote_scope: "bounded_source_excerpts",
      extraction_limits: { stack_references: 40, stack_symbols: 20, legacy_failure_lines: 12, ranked_files: 15, quotes_per_file_per_kind: 3, classification_quotes_per_pattern: 3 },
      negative_result_meaning: "No match found in inspected evidence, not proof no related change exists; omitted logs, files, patches, and extraction limits can hide signals."
    },
    baseline,
    source: fetched ? {
      type: "github_actions",
      workflow_run: summarizeWorkflowRun(fetched.run),
      failed_job_count: fetched.failedJobCount,
      failed_jobs: fetched.failedJobs,
      omitted_failed_jobs: fetched.omittedFailedJobs,
      logs_truncated: fetched.logsTruncated,
      jobs_list_may_be_incomplete: fetched.jobsListMayBeIncomplete,
      failed_job_count_scope: "failed_jobs_observed_on_first_jobs_page",
      job_selection_policy: "first_five_failed_jobs_in_api_order"
    } : { type: "provided_log" },
    limitations: [
      "This is deterministic, evidence-based triage—not an LLM diagnosis or proof of causation.",
      fetched
        ? "Only failed job logs and the allowed repository's GitHub compare API response are inspected; no workflow is dispatched or modified."
        : "Only the supplied CI log and the allowed repository's GitHub compare API response are inspected; no CI service is contacted.",
      "GitHub omits patches for some large or binary files, and comparison file lists may be capped, so evidence may be incomplete."
    ]
  };
}

export function flagIntermittentTests({ testRuns, minRuns = 3 }) {
  const safeMin = Math.max(2, Math.min(Number(minRuns) || 3, 100));
  if (!Array.isArray(testRuns)) throw new Error("test_runs must be an array.");
  const tests = new Map();
  for (const [index, run] of testRuns.entries()) {
    if (!run || typeof run !== "object") throw new Error(`test_runs[${index}] must be an object.`);
    const name = String(run.test_name ?? "").trim();
    const status = String(run.status ?? "").trim().toLowerCase();
    if (!name) throw new Error(`test_runs[${index}].test_name is required.`);
    if (!["passed", "pass", "success", "failed", "fail", "error", "skipped"].includes(status)) {
      throw new Error(`test_runs[${index}].status must be passed, failed, error, or skipped.`);
    }
    if (status === "skipped") continue;
    const normalized = ["passed", "pass", "success"].includes(status) ? "pass" : "fail";
    if (!tests.has(name)) tests.set(name, []);
    tests.get(name).push({
      result: normalized,
      run_id: run.run_id == null ? null : String(run.run_id),
      observed_at: run.observed_at == null ? null : String(run.observed_at)
    });
  }
  const mixed = [];
  let testsSeen = 0;
  for (const [testName, runs] of tests) {
    testsSeen++;
    const passed = runs.filter((run) => run.result === "pass").length;
    const failed = runs.length - passed;
    if (passed === 0 || failed === 0) continue;
    mixed.push({
      test_name: testName,
      runs: runs.length,
      passes: passed,
      failures: failed,
      failure_rate_percent: Math.round((failed / runs.length) * 1000) / 10,
      confidence: runs.length >= safeMin ? "candidate" : "possible_candidate_insufficient_history",
      run_sequence: runs.slice(-20).map((run) => ({ result: run.result, run_id: run.run_id, observed_at: run.observed_at }))
    });
  }
  mixed.sort((a, b) => (b.confidence === "candidate") - (a.confidence === "candidate") || b.runs - a.runs || b.failure_rate_percent - a.failure_rate_percent || a.test_name.localeCompare(b.test_name));
  return {
    test_names_seen: testsSeen,
    mixed_outcome_tests: mixed.length,
    min_runs_for_candidate: safeMin,
    intermittent_test_candidates: mixed,
    note: "Mixed pass/fail outcomes are a signal, not proof of flakiness. Provide multiple CI runs per test; skipped runs are excluded."
  };
}
