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

export async function listFailedWorkflowRuns({ owner, repo, branch, limit = 10 } = {}, access = {}) {
  await requireRepo(owner, repo, access);
  if (branch) validateRef(branch, "branch");
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, MAX_FAILED_RUNS));
  const query = new URLSearchParams({ status: "failure", per_page: String(safeLimit) });
  if (branch) query.set("branch", branch);
  const result = await githubJson(`${repoPath(owner, repo)}/actions/runs?${query}`, access);
  const runs = Array.isArray(result.workflow_runs) ? result.workflow_runs : [];
  return {
    repository: `${owner}/${repo}`,
    total_count: Number(result.total_count) || runs.length,
    runs: runs.filter((run) => run?.status === "completed" && run?.conclusion === "failure").map(summarizeWorkflowRun),
    results_truncated: (Number(result.total_count) || 0) > runs.length
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
  return { text: trimFailureLog(text), truncated };
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
    run = (Array.isArray(result.workflow_runs) ? result.workflow_runs : [])
      .find((item) => item?.status === "completed" && item?.conclusion === "failure");
    if (!run) throw new Error("No completed failed GitHub Actions run was found for this repository and branch.");
  }
  if (run.status !== "completed" || run.conclusion !== "failure") {
    throw new Error("The selected GitHub Actions run is not a completed failure; no logs were fetched.");
  }

  const safeRunId = validateRunId(run.id);
  const jobsData = await githubJson(`${path}/actions/runs/${safeRunId}/jobs?filter=latest&per_page=100`, access);
  const failedJobs = (Array.isArray(jobsData.jobs) ? jobsData.jobs : [])
    .filter((job) => ["failure", "timed_out", "action_required"].includes(job?.conclusion));
  if (!failedJobs.length) throw new Error("GitHub reported a failed run but no failed job was available to read.");

  const selectedJobs = failedJobs.slice(0, MAX_FAILED_JOBS);
  const logs = await Promise.all(selectedJobs.map(async (job) => ({
    job,
    ...await downloadJobLog(path, job.id, access)
  })));
  const failureLog = trimFailureLog(logs.map(({ job, text }) => `Job: ${job.name}\n${text}`).join("\n\n"));
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
    omittedFailedJobs: Math.max(0, failedJobs.length - selectedJobs.length),
    logsTruncated: logs.some((item) => item.truncated) || failureLog.length >= MAX_FAILURE_LOG_CHARS
  };
}

async function requireRepo(owner, repo, access) {
  enforceRepositoryAccess(owner, repo, access);
  const info = await githubJson(repoPath(owner, repo), access);
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

function classifyFailure(log) {
  const cases = [
    [/Cannot find module|Module not found|No module named|Could not resolve/i, "import_or_dependency", "An import, module-resolution, or dependency issue is the clearest match."],
    [/Cannot read propert(?:y|ies) of (?:null|undefined)|undefined is not|NoneType|\bTypeError\b/i, "null_or_data_shape", "A null/undefined value or unexpected data shape is implicated."],
    [/\bAssertionError\b|Expected .{0,80}(?:received|but)|expect\(|toEqual\(|toBe\(/i, "assertion_mismatch", "A behavior or expected-value mismatch is the clearest match."],
    [/timed?\s*out|timeout|deadline exceeded/i, "timeout", "The failure is consistent with a timeout or resource/performance limit."],
    [/\bSyntaxError\b|parse error|unexpected token|\bTS\d{4}\b/i, "syntax_or_typecheck", "A syntax, parsing, or type-checking issue is the clearest match."],
    [/ECONN(?:REFUSED|RESET)|network error|socket hang up|fetch failed/i, "external_service_or_network", "The failure is consistent with a network or external-service problem."]
  ];
  for (const [pattern, category, summary] of cases) {
    if (pattern.test(log)) return { category, summary };
  }
  return { category: "unclear", summary: "The log does not match a specific failure pattern; inspect the cited failure lines and changed files." };
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

function scoreChangedFiles(changedFiles, references, symbols, log) {
  const scores = [];
  for (const item of changedFiles) {
    let score = 0;
    const evidence = [];
    if (matchesReference(item.path, references)) {
      score += 100;
      evidence.push("path appears in a stack trace");
    }
    const base = item.path.split("/").at(-1).toLowerCase();
    if (base.length > 3 && log.toLowerCase().includes(base)) {
      score += 20;
      evidence.push("filename is mentioned in the failure log");
    }
    const patch = typeof item.patch === "string" ? item.patch : "";
    const hits = symbols.filter((symbol) => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(patch));
    if (hits.length) {
      score += Math.min(hits.length * 8, 32);
      evidence.push(`contains stack-frame symbol${hits.length === 1 ? "" : "s"} in the GitHub diff: ${hits.join(", ")}`);
    }
    if (score > 0) scores.push({ path: item.path, status: item.status, score, evidence });
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
  const allChangedFiles = (comparisonData.files || []).map((file) => ({
    status: file.status === "renamed" ? "R" : file.status === "added" ? "A" : file.status === "removed" ? "D" : "M",
    path: normalizeRelative(file.filename),
    patch: file.patch || ""
  }));
  const references = extractFileReferences(log);
  const symbols = symbolsFromLog(log);
  const likelyChangedFiles = scoreChangedFiles(allChangedFiles, references, symbols, log);
  const failure = classifyFailure(log);
  const failureLines = extractFailureLines(log);
  const directFileMatches = likelyChangedFiles.filter((item) => item.evidence.includes("path appears in a stack trace"));
  let summary;
  if (likelyChangedFiles.length) {
    summary = `${failure.summary} ${directFileMatches.length ? "Stack-trace paths overlap the changed files." : "Changed-file names or GitHub diff snippets provide a possible connection."}`;
  } else if (allChangedFiles.length) {
    summary = `${failure.summary} No changed file has a direct stack-trace or diff-symbol match, so the connection to this change is weak.`;
  } else {
    summary = `${failure.summary} GitHub reported no changed files for ${base}...${head}.`;
  }
  return {
    repository: `${owner}/${repo}`,
    comparison: `${base}...${head}`,
    failure_category: failure.category,
    summary,
    changed_file_count: allChangedFiles.length,
    changed_files: allChangedFiles.slice(0, 100).map(({ status, path: filePath }) => ({ status, path: filePath })),
    changed_files_truncated: allChangedFiles.length > 100,
    likely_related_changed_files: likelyChangedFiles,
    stack_trace_files: references,
    failure_evidence: failureLines,
    source: fetched ? {
      type: "github_actions",
      workflow_run: summarizeWorkflowRun(fetched.run),
      failed_job_count: fetched.failedJobCount,
      failed_jobs: fetched.failedJobs,
      omitted_failed_jobs: fetched.omittedFailedJobs,
      logs_truncated: fetched.logsTruncated
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
