#!/usr/bin/env bash
# e2e-sandbox.sh — end-to-end verification against the REAL account, inside a sandbox folder.
# Creates a sandbox folder, uploads a file, downloads it back, compares sha256, exercises
# rename/mv/trash/restore, and leaves the account CLEAN (sandbox folder trashed+purged).
set -euo pipefail
CLI="$(dirname "$0")/../dist/cli/index.js"
S="e2e-sandbox-$$"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
head -c 300000 /dev/urandom > "$TMP/blob.bin"
step() { printf '\n=== %s ===\n' "$*"; }

step "1. mkdir sandbox"
node "$CLI" mkdir "$S" --json >/dev/null

step "2. upload (E2EE)"
node "$CLI" cp "$TMP/blob.bin" "$S/blob.bin" --json >/dev/null

step "3. download + sha256 compare"
node "$CLI" get "$S/blob.bin" "$TMP/blob-back.bin" --json >/dev/null
a=$(sha256sum "$TMP/blob.bin" | cut -d' ' -f1)
b=$(sha256sum "$TMP/blob-back.bin" | cut -d' ' -f1)
[ "$a" = "$b" ] || { echo "FAIL: sha mismatch"; exit 1; }
echo "roundtrip identical ($a)"

step "4. rename + mv"
node "$CLI" rename "$S/blob.bin" blob2.bin --json >/dev/null
node "$CLI" mv "$S/blob2.bin" "$S/blob.bin" --json >/dev/null

step "5. trash + restore"
node "$CLI" rm "$S/blob.bin" --yes --json >/dev/null
node "$CLI" trash restore blob.bin --yes --json >/dev/null

step "6. cleanup: trash + purge everything"
node "$CLI" rm "$S/blob.bin" --yes --json >/dev/null
node "$CLI" purge blob.bin --yes --json >/dev/null
node "$CLI" rm "$S" --yes --json >/dev/null
node "$CLI" purge "$S" --yes --json >/dev/null

step "ALL E2E CHECKS PASSED (account left clean)"
