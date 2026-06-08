#!/bin/bash
#
# Relociq pre-commit guard.
# Checks the STAGED content of index.html (not the working tree) for secrets
# and internal paths. Blocks the commit if any are found.
#
# Install:
#   cp scripts/pre-commit-guard.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or run manually against the working tree:
#   ./scripts/pre-commit-guard.sh --working-tree

set -e

# Determine what to scan: staged blob (default, used as hook) or working tree (manual run).
if [ "${1}" = "--working-tree" ]; then
  # Manual mode: read file from disk
  FILE="index.html"
  if [ ! -f "$FILE" ]; then
    echo "pre-commit-guard: $FILE not found, skipping"
    exit 0
  fi
  CONTENT=$(cat "$FILE")
else
  # Hook mode: read the staged blob so working-tree changes don't interfere.
  # If index.html isn't staged, nothing to check.
  if ! git diff --cached --name-only | grep -q '^index\.html$'; then
    exit 0
  fi
  CONTENT=$(git show ":index.html")
fi

# --- Block list: hard fail if any pattern appears in staged content ---
# Uses grep -E so patterns can be real regexes.
PATTERNS=(
  "appM0O6xRifFXtMa6"               # Known Relociq Airtable base ID
  "tblIQsKbzGPBH59dT"               # Known Guide Steps table ID
  "app[A-Za-z0-9]{14}"              # Any Airtable base ID shape
  "tbl[A-Za-z0-9]{14}"              # Any Airtable table ID shape
  "pat[A-Za-z0-9]{14}\.[A-Za-z0-9]{64}"  # Airtable personal access token shape
  "/mnt/user-data/"                  # Cloud agent filesystem paths
  "AIRTABLE_API_KEY"
  "sk_live_"                         # Stripe live secret key
  "sk_test_"                         # Stripe test secret key
)

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE "$pattern"; then
    if [ "$FOUND" -eq 0 ]; then
      echo ""
      echo "════════════════════════════════════════════════════════════"
      echo "  COMMIT BLOCKED: secrets or internal paths found in index.html (staged)"
      echo "════════════════════════════════════════════════════════════"
    fi
    echo "  ✗ Pattern: $pattern"
    echo "$CONTENT" | grep -nE "$pattern" | head -3 | sed 's/^/      /'
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "  Remove these before committing. If they came from the cloud agent's"
  echo "  build output, regenerate or hand-edit index.html to strip them."
  echo ""
  exit 1
fi

echo "pre-commit-guard: index.html (staged) clean ✓"
exit 0
