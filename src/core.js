import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build",
  "coverage", ".next", ".nuxt", ".venv", "venv", "__pycache__",
  "target", "out", "Pods", "DerivedData"
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_SCAN_FILES = 20_000;
const MAX_FAILURE_LOG_CHARS = 60_000;
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go",
  ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".lua",
  ".m", ".md", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".scala",
  ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml"
]);
const STACK_FILE_RE = /(?:^|[\s(])((?:\.{0,2}\/)?[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|rb|php|cs|cpp|h|hpp|sql|vue|svelte|swift|kt)):(\d+)(?::\d+)?/gim;

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalDirectory(value, label) {
  let resolved;
  try {
    resolved = await fs.realpath(path.resolve(value));
  } catch {
    throw new Error(`${label} does not exist or cannot be accessed.`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  return resolved;
}

export async function resolveWorkspace(repoPath) {
  const configuredRoot = process.env.TRIAGE_REPO_ROOT;
  if (!repoPath && !configuredRoot) {
    throw new Error("Provide repo_path, or configure TRIAGE_REPO_ROOT for this MCP server.");
  }
  const requested = await canonicalDirectory(repoPath || configuredRoot, "Repository path");
  const restrictedRoot = configuredRoot ? await canonicalDirectory(configuredRoot, "TRIAGE_REPO_ROOT") : null;
  if (restrictedRoot && !isInside(restrictedRoot, requested)) {
    throw new Error("repo_path must be inside TRIAGE_REPO_ROOT.");
  }

  const top = runGit(["-C", requested, "rev-parse", "--show-toplevel"], { allowFailure: true });
  let workspace = requested;
  if (top.ok) {
    workspace = await canonicalDirectory(top.stdout.trim(), "Git repository root");
    if (restrictedRoot && !isInside(restrictedRoot, workspace)) {
      throw new Error("The Git repository root is outside TRIAGE_REPO_ROOT.");
    }
  }
  return { workspace, isGitRepository: top.ok };
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: 7_000,
    maxBuffer: 2_000_000,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.error) {
    if (allowFailure) return { ok: false, stdout: "", stderr: result.error.message };
    throw new Error(`Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return { ok: false, stdout: result.stdout || "", stderr: result.stderr || "" };
    const detail = (result.stderr || "Git command failed.").trim().slice(0, 500);
    throw new Error(detail);
  }
  return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
}

async function walkFiles(root, { maxFiles = MAX_SCAN_FILES } = {}) {
  const files = [];
  const pending = [root];
  while (pending.length && files.length < maxFiles) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(path.join(directory, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(directory, entry.name));
        if (files.length >= maxFiles) break;
      }
    }
  }
  return { files, truncated: pending.length > 0 };
}

export async function searchCode({ repoPath, query, caseSensitive = false, maxResults = 50 }) {
  const { workspace } = await resolveWorkspace(repoPath);
  const needle = String(query ?? "").trim();
  if (!needle || needle.length > 200) throw new Error("query must contain 1–200 characters.");
  const safeMax = Math.max(1, Math.min(Number(maxResults) || 50, 100));
  const { files, truncated: scanLimitReached } = await walkFiles(workspace);
  const wanted = caseSensitive ? needle : needle.toLocaleLowerCase();
  const matches = [];
  let filesScanned = 0;
  let filesSkippedAsLargeOrBinary = 0;
  let totalMatches = 0;

  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) {
        filesSkippedAsLargeOrBinary++;
        continue;
      }
      const content = await fs.readFile(file, "utf8");
      if (content.includes("\u0000")) {
        filesSkippedAsLargeOrBinary++;
        continue;
      }
      filesScanned++;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const haystack = caseSensitive ? lines[i] : lines[i].toLocaleLowerCase();
        if (!haystack.includes(wanted)) continue;
        totalMatches++;
        if (matches.length < safeMax) {
          matches.push({
            path: path.relative(workspace, file).split(path.sep).join("/"),
            line: i + 1,
            text: lines[i].trim().slice(0, 500)
          });
        }
      }
    } catch {
      // A file that changes or is unreadable during a scan is safely skipped.
    }
  }
  return {
    query: needle,
    repository: path.basename(workspace),
    files_scanned: filesScanned,
    files_skipped_as_large_or_binary: filesSkippedAsLargeOrBinary,
    total_matches: totalMatches,
    results: matches,
    results_truncated: totalMatches > matches.length,
    scan_limit_reached: scanLimitReached
  };
}

function validateRef(ref, label) {
  if (typeof ref !== "string" || !ref.trim() || ref.length > 200 || ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`${label} must be a local Git ref or commit SHA using letters, digits, dot, underscore, slash, or hyphen.`);
  }
  return ref;
}

function normalizeRelative(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
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
  const lines = log.split(/\r?\n/);
  const candidates = lines.filter((line) => /\b(?:FAIL|FAILED|ERROR|AssertionError|TypeError|SyntaxError)\b|✗|✕|×/.test(line.trim()));
  return candidates.slice(0, 12).map((line) => line.trim().slice(0, 400));
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
    if (frame) {
      const symbol = frame[1].split(".").at(-1).replace(/[^\w$]/g, "");
      if (symbol.length >= 3 && !["anonymous", "Object", "Module"].includes(symbol)) symbols.add(symbol);
    }
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

async function scoreChangedFiles(workspace, changedFiles, references, symbols, log) {
  const scores = [];
  for (const item of changedFiles) {
    const relative = item.path;
    let score = 0;
    const evidence = [];
    if (matchesReference(relative, references)) {
      score += 100;
      evidence.push("path appears in a stack trace");
    }
    const base = path.basename(relative).toLocaleLowerCase();
    if (base.length > 3 && log.toLocaleLowerCase().includes(base)) {
      score += 20;
      evidence.push("filename is mentioned in the failure log");
    }
    const absolute = path.join(workspace, ...relative.split("/"));
    try {
      const realFile = await fs.realpath(absolute);
      if (!isInside(workspace, realFile)) continue;
      const stat = await fs.stat(realFile);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(realFile, "utf8");
      if (content.includes("\u0000")) continue;
      const hits = symbols.filter((symbol) => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content));
      if (hits.length) {
        score += Math.min(hits.length * 8, 32);
        evidence.push(`contains stack-frame symbol${hits.length === 1 ? "" : "s"}: ${hits.join(", ")}`);
      }
    } catch {
      // Deleted or unreadable changed paths remain listed without content inspection.
    }
    if (score > 0) scores.push({ path: relative, status: item.status, score, evidence });
  }
  scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scores.slice(0, 15);
}

function parseNameStatus(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    const file = parts.at(-1);
    if (!file) continue;
    rows.push({ status: status.slice(0, 1), path: normalizeRelative(file) });
  }
  return rows;
}

export async function triageFailure({ repoPath, failureLog, baseRef, headRef }) {
  const log = String(failureLog ?? "");
  if (!log.trim()) throw new Error("failure_log must not be empty.");
  if (log.length > MAX_FAILURE_LOG_CHARS) throw new Error(`failure_log must be no longer than ${MAX_FAILURE_LOG_CHARS} characters.`);
  if (Boolean(baseRef) !== Boolean(headRef)) throw new Error("Provide both base_ref and head_ref, or neither.");

  const { workspace, isGitRepository } = await resolveWorkspace(repoPath);
  if (!isGitRepository) throw new Error("triage_ci_failure requires a local Git checkout.");

  let changedText;
  let comparison;
  if (baseRef && headRef) {
    const base = validateRef(baseRef, "base_ref");
    const head = validateRef(headRef, "head_ref");
    const result = runGit(["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", `${base}...${head}`, "--"]);
    changedText = result.stdout;
    comparison = `${base}...${head}`;
  } else {
    const result = runGit(["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "HEAD", "--"]);
    changedText = result.stdout;
    comparison = "working tree vs HEAD";
  }

  const changedFiles = parseNameStatus(changedText);
  const references = extractFileReferences(log);
  const symbols = symbolsFromLog(log);
  const likelyChangedFiles = await scoreChangedFiles(workspace, changedFiles, references, symbols, log);
  const failure = classifyFailure(log);
  const failureLines = extractFailureLines(log);
  const directFileMatches = likelyChangedFiles.filter((item) => item.evidence.includes("path appears in a stack trace"));

  let summary;
  if (likelyChangedFiles.length) {
    summary = `${failure.summary} ${directFileMatches.length ? "Stack-trace paths overlap the changed files." : "Changed files contain symbols named in the failure stack, or their filenames appear in the log."}`;
  } else if (changedFiles.length) {
    summary = `${failure.summary} No changed file has a direct stack-trace or symbol match, so the connection to this change is weak.`;
  } else {
    summary = `${failure.summary} No changed files were found for ${comparison}; supply base_ref and head_ref for the CI commit range if needed.`;
  }

  return {
    repository: path.basename(workspace),
    comparison,
    failure_category: failure.category,
    summary,
    changed_file_count: changedFiles.length,
    changed_files: changedFiles.slice(0, 100),
    likely_related_changed_files: likelyChangedFiles,
    stack_trace_files: references,
    failure_evidence: failureLines,
    limitations: [
      "This is deterministic, evidence-based triage—not an LLM diagnosis or proof of causation.",
      "Only the supplied CI log and local Git checkout are inspected; no GitHub API, CI service, or network is contacted."
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
    const failureRate = Math.round((failed / runs.length) * 1000) / 10;
    mixed.push({
      test_name: testName,
      runs: runs.length,
      passes: passed,
      failures: failed,
      failure_rate_percent: failureRate,
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
