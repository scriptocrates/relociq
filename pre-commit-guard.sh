#!/bin/bash
#
# Relociq pre-commit guard.
# Strips known credential patterns from index.html, then blocks the commit
# if any are still found. Saves you from accidentally pushing Airtable IDs,
# cloud-agent filesystem paths, or other secrets from regenerated builds.
#
# Install:
#   cp scripts/pre-commit-guard.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or run manually before committing:
#   ./scripts/pre-commit-guard.sh

set -e

FILE="${1:-index.html}"
if [ ! -f "$FILE" ]; then
  echo "pre-commit-guard: $FILE not found, skipping"
  exit 0
fi

# --- Patterns to scrub (best-effort cleanup before blocking) ---
# These are HTML comments that the cloud agent occasionally embeds.

# 1. Airtable base/table IDs in HTML comments
sed -i.bak -E '/<!--.*app[A-Za-z0-9]{14}.*-->/d' "$FILE"
sed -i.bak -E '/<!--.*tbl[A-Za-z0-9]{14}.*-->/d' "$FILE"

# 2. Cloud agent filesystem paths
sed -i.bak 's|/mnt/user-data/outputs/||g' "$FILE"
sed -i.bak 's|/mnt/user-data/uploads/||g' "$FILE"

# Cleanup backup
rm -f "$FILE.bak"

# --- Block list: hard fail if any of these still appear anywhere in the file ---
PATTERNS=(
  "appM0O6xRifFXtMa6"            # Relociq Airtable base ID
  "tblIQsKbzGPBH59dT"            # Guide Steps table ID
  "/mnt/user-data/"              # Cloud agent paths
  "AIRTABLE_API_KEY"             # Just in case
  "patXXXXXXXX"                  # Airtable personal access tokens (rough prefix)
  "sk_live_"                     # Stripe live secret keys
  "sk_test_"                     # Stripe test secret keys (shouldn't be in HTML either)
)

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  if grep -q "$pattern" "$FILE"; then
    if [ "$FOUND" -eq 0 ]; then
      echo ""
      echo "════════════════════════════════════════════════════════════"
      echo "  COMMIT BLOCKED: secrets or internal paths found in $FILE"
      echo "════════════════════════════════════════════════════════════"
    fi
    echo "  ✗ Pattern: $pattern"
    grep -n "$pattern" "$FILE" | head -3 | sed 's/^/      /'
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

echo "pre-commit-guard: $FILE clean ✓"
exit 0
