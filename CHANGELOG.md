# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-21

### Added
- `setup` command: prints ready-to-paste MCP config for pi, [CC], Codex CLI, OpenCode,
  OpenClaw, DeepSeek Harness, Gemini CLI, Cursor, Windsurf and VS Code
  (`setup --list`, `setup --client <name>`, `setup --generic`).
- Harness-agnostic integration descriptor (`setup --generic`) and the committed manifest
  `docs/clients.json`, kept in sync by a test.
- `AGENTS.md` (repo conventions for agents) and `docs/clients.md` (integration matrix).
- `server.json` describing the package for MCP registries.

### Changed
- Dependencies refreshed through Dependabot: TypeScript 7, `@internxt/sdk` 1.23,
  `@types/node` 26, `actions/checkout@v7`, `actions/setup-node@v7`.

## [0.2.0] - 2026-10-21

### Added
- Headless login for VPS/no-browser machines:
  - `login --remote` paste-back mode (URL opened anywhere; the failing redirect is
    pasted back on stdin — never echoed, never logged).
  - `login --port N` SSH-tunnel mode with the exact `ssh -L` command printed.
- MCP tools `inxt_login_remote` and `inxt_login_complete` (18 tools total).
- Credential store self-checks file permissions and fails closed on lax modes.

### Changed
- Repo layout flattened to the project root; README rewritten in English.
- Error sanitizer threshold tightened (32-char token-shaped strings redacted).

## [0.1.0] - 2026-10-21

### Added
- Browser login via Internxt's universal-link flow (password and 2FA never leave
  the browser); single-flight token refresh over web-surface endpoints only.
- End-to-end encrypted transfers: streaming uploads (multipart, presigned S3),
  downloads with AES-256-CTR decryption; key derivation identical to drive-web,
  verified byte-for-byte against a real account.
- Drive operations: ls (cursor pagination + TTL cache), mkdir (recursive), cp,
  get, mv, rename, rm (trash), trash list/restore, purge, empty-trash, quota,
  fuzzy search.
- CLI with a stable JSON contract and stable exit codes; destructive operations
  gated behind `--yes` / `confirm: true`.
- MCP stdio server with annotated tools (readOnly/destructive).
- 38 unit tests (fake HTTP servers) and a repeatable E2E sandbox script.
