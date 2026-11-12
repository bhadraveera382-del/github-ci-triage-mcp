// Pure, bounded evidence formatting. No network, file writes, or model calls.
const RULES = [
  [/Cannot find module|Module not found|No module named|Could not resolve/i, "import_or_dependency", "The log contains a module-resolution or dependency error pattern."],
  [/Cannot read propert(?:y|ies) of (?:null|undefined)|undefined is not|NoneType|\bTypeError\b/i, "null_or_data_shape", "The log contains a type, null-value, or data-shape error pattern."],
  [/\bAssertionError\b|Expected .{0,80}(?:received|but)|expect\(|toEqual\(|toBe\(/i, "assertion_mismatch", "The log contains an assertion or expected-value mismatch pattern."],
  [/timed?\s*out|timeout|deadline exceeded/i, "timeout", "The log contains a timeout pattern; the underlying reason is not established."],
  [/\bSyntaxError\b|parse error|unexpected token|\bTS\d{4}\b/i, "syntax_or_typecheck", "The log contains a syntax, parsing, or type-checking error pattern."],
  [/ECONN(?:REFUSED|RESET)|network error|socket hang up|fetch failed/i, "external_service_or_network", "The log contains a network-error pattern; an external service is not proven responsible."]
];
const STACK_FILE_RE = /(?:^|[\s(])((?:\.{0,2}\/)?[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|rb|php|cs|cpp|h|hpp|sql|vue|svelte|swift|kt)):(\d+)(?::\d+)?/gim;
const normalized = (value) => String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasSymbol = (text, symbol) => new RegExp(`\\b${escape(symbol)}\\b`).test(text);
const changedLine = (line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line);

export function classifyFailure(log) {
  const lines = String(log).split(/\r?\n/);
  const matched = RULES.filter(([pattern]) => lines.some((line) => pattern.test(line)));
  const selected = matched[0];
  return { category: selected?.[1] || "unclear",
    summary: selected?.[2] || "No supported error-pattern classification was found in the analyzed log.",
    rule_id: selected?.[1] || null, matched_categories: matched.map(([, category]) => category),
    selection_method: "first_matching_rule_in_fixed_order_not_severity_or_cause",
    rule_precedence: RULES.map(([, category]) => category) };
}

function pathInStack(line, path) {
  const wanted = normalized(path);
  return [...line.matchAll(STACK_FILE_RE)].some((match) => {
    const found = normalized(match[1]);
    return found === wanted || found.endsWith(`/${wanted}`) || wanted.endsWith(`/${found}`);
  });
}

// The line locator is deliberately an excerpt/patch locator, never a fabricated
// GitHub log anchor or source-file line number. Existing legacy fields are kept.
export function buildEvidence({ scope = "primary", documents, comparisonSource, changedFiles, rankedFiles, failure }) {
  const collectedAt = new Date().toISOString();
  const sources = documents.map(({ text, ...source }) => ({ ...source, collected_at: collectedAt }));
  sources.push({ ...comparisonSource, collected_at: collectedAt });
  const items = [];
  const claims = [];
  const keys = new Map();
  const add = (key, value) => {
    if (keys.has(key)) return keys.get(key);
    const id = `${scope}:E${items.length + 1}`;
    items.push({ id, ...value });
    keys.set(key, id);
    return id;
  };
  const quoteLog = (document, line, index) => {
    const text = line;
    return add(`${document.id}:L${index + 1}`, {
      kind: "log_excerpt", source_id: document.id,
      locator: { line: index + 1, line_number_scope: document.line_number_scope },
      quote: text.slice(0, 400), quote_truncated: text.length > 400
    });
  };
  const classificationIds = [];
  const matchedPatterns = [];
  for (const rule of RULES.filter(([, category]) => (failure.matched_categories || [failure.category]).includes(category))) {
    const patternIds = [];
    for (const document of documents) {
      for (const [index, line] of document.text.split(/\r?\n/).entries()) {
        if (rule[0].test(line)) patternIds.push(quoteLog(document, line, index));
        if (patternIds.length >= 3) break;
      }
      if (patternIds.length >= 3) break;
    }
    matchedPatterns.push({ rule_id: rule[1], evidence_ids: patternIds });
    if (rule[1] === failure.category) classificationIds.push(...patternIds);
  }
  claims.push({
    id: `${scope}:C1`, kind: "log_pattern_classification", statement: failure.summary,
    assessment: classificationIds.length ? "heuristic_supported_by_quoted_pattern" : "insufficient_evidence",
    rule_id: failure.rule_id, evidence_ids: classificationIds, matched_patterns: matchedPatterns,
    selection_method: failure.selection_method, rule_precedence: failure.rule_precedence,
    does_not_establish: ["specific_root_cause", "change_caused_failure", "current_ci_state"]
  });

  const enrichedFiles = rankedFiles.map((ranked, fileIndex) => {
    const file = changedFiles.find((item) => item.path === ranked.path) || ranked;
    const evidenceIds = [add(`${comparisonSource.id}:${file.path}`, {
      kind: "changed_file_entry", source_id: comparisonSource.id,
      locator: { path: file.path }, observed_value: { path: file.path, status: file.status }
    })];
    const symbols = ranked.matching_symbols || [];
    const name = file.path.split("/").at(-1).toLowerCase();
    let logQuotes = 0;
    for (const document of documents) {
      for (const [index, line] of document.text.split(/\r?\n/).entries()) {
        if (pathInStack(line, file.path) || (name.length > 3 && line.toLowerCase().includes(name)) || symbols.some((symbol) => hasSymbol(line, symbol))) {
          evidenceIds.push(quoteLog(document, line, index));
          logQuotes++;
        }
        if (logQuotes >= 3) break;
      }
      if (logQuotes >= 3) break;
    }
    let hunk = null;
    let diffQuotes = 0;
    for (const [index, line] of String(file.patch || "").split(/\r?\n/).entries()) {
      if (line.startsWith("@@")) hunk = line.slice(0, 200);
      if (!changedLine(line) || (symbols.length && !symbols.some((symbol) => hasSymbol(line, symbol)))) continue;
      evidenceIds.push(add(`${comparisonSource.id}:${file.path}:P${index + 1}`, {
        kind: "diff_excerpt", source_id: comparisonSource.id,
        locator: { path: file.path, patch_line: index + 1, hunk_header: hunk, line_number_scope: "returned_patch_excerpt_not_source_file" },
        quote: line.slice(0, 400), quote_truncated: line.length > 400
      }));
      if (++diffQuotes >= 3) break;
    }
    const claimId = `${scope}:C${fileIndex + 2}`;
    claims.push({ id: claimId, kind: "changed_file_correlation", path: file.path,
      statement: `${file.path} is an investigation candidate because the returned change list overlaps log paths, filenames, or symbols.`,
      assessment: "correlation_only", evidence_ids: [...new Set(evidenceIds)],
      match_kinds: ranked.match_kinds || [], matching_symbols: symbols,
      path_match_semantics: "exact_or_suffix_path_overlap_not_validated_source_location",
      ranking_score: ranked.score, score_meaning: "heuristic_ranking_points_not_probability",
      does_not_establish: ["file_contains_bug", "changed_line_executed", "change_caused_failure"] });
    return { ...ranked, claim_id: claimId, evidence_ids: [...new Set(evidenceIds)] };
  });
  return {
    evidence: { schema_version: "1.0", collected_at: collectedAt, sources, items,
      interpretation: "Cite evidence IDs with their sources. Quotes are observations; classifications and file rankings are hypotheses. Excerpt/patch line locators are not GitHub UI line anchors. Named refs can move; inspect the source's ref metadata." },
    diagnostic_claims: claims,
    likely_related_changed_files: enrichedFiles,
    root_cause_established: false
  };
}

export function githubComparisonSource({ scope = "primary", owner, repo, base, head, data, basis }) {
  const files = Array.isArray(data.files) ? data.files : [];
  return {
    id: `${scope}:comparison`, type: "github_compare", repository: `${owner}/${repo}`,
    url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    requested_base_ref: base, requested_head_ref: head, selection_basis: basis,
    refs_are_full_commit_shas: /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(base) && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(head),
    api_base_commit_sha: data.base_commit?.sha || null, api_merge_base_sha: data.merge_base_commit?.sha || null,
    comparison_status: data.status || null, files_received: files.length,
    file_list_may_be_capped: files.length >= 300,
    missing_patch_files: files.filter((file) => typeof file.patch !== "string" || !file.patch).map((file) => file.filename),
    note: "GitHub compare is a three-dot/merge-base comparison. A path overlap does not prove a changed line executed or caused the error. Named refs are not immutable permalinks."
  };
}
