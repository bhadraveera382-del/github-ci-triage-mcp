import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildEvidence, classifyFailure } from "./evidence.js";

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function changedPatchLines(patch) {
  return String(patch || "").split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line));
}

function scoreChangedFiles(changedFiles, references, symbols, log) {
  const scores = [];
  for (const item of changedFiles) {
    let score = 0;
    const evidence = [];
    const matchKinds = [];
    if (matchesReference(item.path, references)) {
      score += 100;
      evidence.push("path appears in a stack trace");
      matchKinds.push("stack_path_overlap");
    }
    const base = path.basename(item.path).toLocaleLowerCase();
    if (base.length > 3 && log.toLocaleLowerCase().includes(base)) {
      score += 20;
      evidence.push("filename is mentioned in the failure log");
      matchKinds.push("filename_mention");
    }
    const changedLines = changedPatchLines(item.patch).join("\n");
    const hits = symbols.filter((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(changedLines));
    if (hits.length) {
      score += Math.min(hits.length * 8, 32);
      evidence.push(`changed diff lines contain stack-frame symbol${hits.length === 1 ? "" : "s"}: ${hits.join(", ")}`);
      matchKinds.push("changed_line_symbol_overlap");
    }
    if (score > 0) scores.push({
      path: item.path, status: item.status, score, evidence, match_kinds: matchKinds,
      matching_symbols: hits, score_interpretation: "heuristic_ranking_points_not_probability",
      log_quotes: [], diff_snippets: changedPatchLines(item.patch).filter((line) => hits.some((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line))).slice(0, 3),
      log_quote_line_number_scope: "combined_analyzed_excerpt_not_original_log", legacy_snippets_may_be_truncated: true
    });
  }
  scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scores.slice(0, 15);
}

function parsePatchByPath(text) {
  const patches = new Map();
  let unmappable = false;
  const sections = String(text || "").split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const header = section.split(/\r?\n/, 1)[0];
    const match = header.match(/^a\/(.+) b\/(.+)$/);
    if (!match || match[1] !== match[2] || /["\\]/.test(match[1])) {
      unmappable = true;
      continue;
    }
    patches.set(normalizeRelative(match[1]), `diff --git ${section}`.trimEnd());
  }
  return { patches, unmappable };
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
  let patchText;
  let comparison;
  let comparisonRefs;
  if (baseRef && headRef) {
    const base = validateRef(baseRef, "base_ref");
    const head = validateRef(headRef, "head_ref");
    comparisonRefs = { base, head };
    comparison = `${base}...${head}`;
    const result = runGit(["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", comparison, "--"]);
    changedText = result.stdout;
    patchText = runGit(["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", comparison, "--"]).stdout;
  } else {
    comparison = "working tree vs HEAD";
    comparisonRefs = { base: "HEAD", head: "working-tree" };
    const result = runGit(["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", "HEAD", "--"]);
    changedText = result.stdout;
    patchText = runGit(["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "HEAD", "--"]).stdout;
  }

  const changedFiles = parseNameStatus(changedText);
  const patchInfo = parsePatchByPath(patchText);
  for (const file of changedFiles) file.patch = patchInfo.patches.get(file.path) || "";
  const references = extractFileReferences(log);
  const symbols = symbolsFromLog(log);
  const likelyChangedFiles = scoreChangedFiles(changedFiles, references, symbols, log);
  const failure = classifyFailure(log);
  const failureLines = extractFailureLines(log);
  const directFileMatches = likelyChangedFiles.filter((item) => item.match_kinds.includes("stack_path_overlap"));
  const callerDocument = { id: "provided_log", type: "caller_supplied_log", text: log, url: null,
    authenticity: "not_independently_verified", line_number_scope: "caller_supplied_excerpt_not_original_ci_log" };
  const comparisonSource = { id: "local:comparison", type: "local_git_diff", repository: path.basename(workspace), url: null,
    requested_base_ref: comparisonRefs.base, requested_head_ref: comparisonRefs.head, comparison,
    scope: comparison === "working tree vs HEAD" ? "working_tree_vs_refs" : "refs_comparison",
    no_ext_diff: true, no_textconv: true, patches_incomplete: patchInfo.unmappable || changedFiles.some((file) => !file.patch),
    note: "Local Git diff is bounded and read-only; ambiguous or unmappable patches are not used as symbol evidence." };

  let summary;
  if (likelyChangedFiles.length) {
    summary = `${failure.summary} ${directFileMatches.length ? "Stack-trace paths overlap the changed files." : "Added/removed diff lines contain stack-frame symbols, or changed-file names appear in the log."}`;
  } else if (changedFiles.length) {
    summary = `${failure.summary} No overlap was found in inspected evidence; incomplete or unmappable patches may hide a connection.`;
  } else {
    summary = `${failure.summary} No changed files were found for ${comparison}; supply base_ref and head_ref for the CI commit range if needed.`;
  }

  return {
    repository: path.basename(workspace),
    comparison,
    failure_category: failure.category,
    summary,
    changed_file_count: changedFiles.length,
    changed_files: changedFiles.slice(0, 100).map(({ status, path: filePath }) => ({ status, path: filePath })),
    likely_related_changed_files: likelyChangedFiles,
    stack_trace_files: references,
    failure_evidence: failureLines,
    ...buildEvidence({ scope: "local", documents: [callerDocument], comparisonSource,
      changedFiles, rankedFiles: likelyChangedFiles, failure }),
    analysis_coverage: {
      changed_file_count_scope: "files returned by local Git name-status",
      patches_incomplete: comparisonSource.patches_incomplete,
      ranking_log_scope: "caller_supplied_excerpt",
      extraction_limits: { stack_references: 40, stack_symbols: 20, legacy_failure_lines: 12, ranked_files: 15, quotes_per_file_per_kind: 3, classification_quotes_per_pattern: 3 },
      negative_result_meaning: "No match found in inspected evidence, not proof no related change exists; omitted or unmappable patches can hide signals."
    },
    limitations: [
      "This is deterministic, evidence-based triage—not an LLM diagnosis or proof of causation.",
      "Only the supplied CI log and local Git checkout are inspected; no GitHub API, CI service, or network is contacted.",
      "Unmappable, omitted, or bounded Git patches are not scored as changed-line symbol evidence."
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
