# GitHub + CI Triage MCP

Read-only tools for investigating CI failures, available as a local stdio server or a hosted Streamable HTTP connector for Claude.

The hosted server uses a server-side GitHub credential and a separate connector access key. It requires all three settings—credential, connector key, and `GITHUB_ALLOWED_REPOS`—and fails closed when any is missing or invalid. The repository setting can name selected repositories, or use the sole value `*` as an explicit all-repositories-accessible-to-this-server-credential mode. No GitHub credential is accepted in tool inputs or returned to Claude.

## Tools

- **`search_codebase`** — literal, case-insensitive-by-default search in source and text files. The hosted server scans up to 30 eligible files in path order per call and reports partial scans.
- **`list_failed_workflow_runs`** — lists recent completed failed GitHub Actions runs, optionally filtered by branch.
- **`triage_ci_failure`** — compares a supplied CI failure log or automatically fetched logs from a selected/latest failed Actions run with changed-file paths, stack traces, and available GitHub diff snippets. For fetched runs it uses a linked pull request's base/head commits, or the run commit's first parent when available.
- **`flag_intermittent_tests`** — identifies tests with both passing and failing outcomes in supplied history. Mixed outcomes are candidates, not proof of flakiness; skipped runs are excluded.

The failure classification and file ranking are deterministic heuristics, not proof of cause. A direct stack-trace overlap is stronger evidence than a filename or diff-symbol match. The hosted server can retrieve logs only for failed jobs in completed failed runs; it never reruns, cancels, dispatches, or edits workflows. The local stdio tool remains credential-free and accepts supplied logs.

## Hosted connector setup

### GitHub access

Use a fine-grained GitHub personal access token with **Contents: Read-only**, **Metadata: Read-only**, and **Actions: Read-only** only. Actions read access is used only to list failed runs, list their jobs, and download failed-job logs. Choose a short, explicit expiry and rotate it before expiration. Do not grant write, administration, or account permissions.

`GITHUB_ALLOWED_REPOS` supports either selected `owner/repo` slugs or the exact sole value `*`. The wildcard is an explicit opt-in: it allows this shared connector key to read every repository that the server-side GitHub credential can read, including private repositories. GitHub organization policies and approval still apply. A fine-grained PAT is limited to one resource owner, so wildcard mode does not literally cover all collaborators or repositories across different owners.

### Encrypted Worker secrets

Configure these secret bindings in Cloudflare, not in source files or plaintext Worker variables:

| Secret | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Fine-grained read-only GitHub credential. Never sent to Claude. |
| `MCP_ACCESS_TOKEN` | Separate cryptographically random connector key, at least 32 characters. Claude uses this key, not the GitHub token. |
| `GITHUB_ALLOWED_REPOS` | Selected comma-separated `owner/repo` names, or the exact sole value `*` for all repositories accessible to the server credential. |

To develop locally, copy `.dev.vars.example` to `.dev.vars` and fill the values. `.dev.vars` is ignored by Git.

```sh
npm install
npm test
npm run worker:dev
```

For a permanent deployment, authenticate to Cloudflare and deploy the code, then add the encrypted secret bindings:

```sh
npx wrangler login
npm run worker:deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put MCP_ACCESS_TOKEN
npx wrangler secret put GITHUB_ALLOWED_REPOS
```

Until the complete secret configuration is present, `/mcp` returns `503` and no tool can run. A missing or incorrect connector key returns `401`. The `/health` endpoint shows readiness without exposing credentials or repository names.

Wrangler also supports `npm run worker:deploy:temporary` without a prior login. This requires accepting Cloudflare's ordinary service terms, creates a claimable preview account, and must be claimed by the intended user within 60 minutes or Cloudflare deletes it. A claimed, permanent account is preferable for a Claude connector.

### Add it to Claude

Add a custom remote connector in **Customize → Connectors** using the public Worker URL ending in `/mcp`.

This implementation uses a fixed request header rather than an OAuth authorization server. Configure **No sign in** for OAuth and add an **Authorization** request header whose value is `Bearer <connector-access-key>`. Use only the separate `MCP_ACCESS_TOKEN` here—never the GitHub credential. Claude supports fixed credentials in custom connector request headers.

Claude connects from its cloud infrastructure, so the endpoint must be reachable over the public internet. The Worker validates incoming origins and accepts its own origin, Claude's web origins, or requests without an `Origin` header.

## Local stdio server

The original local mode remains credential-free and does not make network requests. It requires Node.js 20+, a checkout on the same computer, and Git for CI comparisons.

```sh
npm install
npm test
TRIAGE_REPO_ROOT=/absolute/path/to/checkout npm start
```

Set `TRIAGE_REPO_ROOT` to restrict calls to one checkout. Local tools accept `repo_path` instead of the hosted mode's `owner` and `repo`. The local CI tool compares the supplied refs, or the working tree against `HEAD` when refs are omitted. Local source searches scan up to 20,000 candidate files.

## Safety and limits

- No write tools, commits, workflow dispatches/reruns/cancellations, GitHub mutations, or file edits are exposed.
- The hosted endpoint requires its own access key, a server-side GitHub token, and a valid repository configuration. Private code is not exposed through an unauthenticated URL; wildcard mode is an explicit shared-key opt-in.
- The GitHub token is sent only in authorization headers to `api.github.com`. The server refuses redirects and never places the token in a URL or tool result.
- Temporary job-log download URLs are fetched without the GitHub authorization header, only over HTTPS from approved GitHub Actions/GitHub/AWS download hosts, and are never returned to the caller.
- Hosted code, supplied CI logs, and test history are processed by the Worker and returned to the authenticated caller. The application does not persist request bodies or log them; the hosting provider still processes network requests under its policies.
- Source search reads at most 30 eligible files per call, skips dependency/generated directories, hidden paths other than `.github`, binary files, and files over 1 MB. Check `scan_limit_reached` before treating results as complete.
- GitHub API rate limits still apply to authenticated requests. Job logs are fetched only for up to five failed jobs per run and bounded to 1 MB each; comparison file lists and patches may be capped or omitted for large changes, so evidence may be incomplete.
- This is a single-owner connector with a shared connector key, not a multi-user OAuth application. Anyone given that key can read the configured repositories through these tools; with wildcard mode that means every repository the server-side credential can read, including private repositories. Keep the key private and rotate it if shared unintentionally. A fine-grained PAT remains limited to its one resource owner and does not span all collaborators or organization repositories across owners.

## Development

```sh
npm test
npm run worker:dev
```

Tests cover local checkout behavior, authenticated GitHub reads, allowlist enforcement, missing/invalid connector keys, origin checks, and MCP initialization/tool discovery. Fixtures use synthetic data and temporary directories; they do not require account credentials.
