#!/bin/bash
#
# Relociq pre-commit guard.
# Scans staged application files for secrets and internal paths, then runs
# the site integrity validator against staged index.html (if changed).
#
# Scoped to application files only (index.html, netlify/functions/).
# build/ and scripts/ are trusted tooling and excluded from secret scanning.
#
# Install:
#   cp scripts/pre-commit-guard.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or run manually:
#   ./scripts/pre-commit-guard.sh --working-tree

set -e

# Files to scan for secrets (application code only — excludes build tooling and this script)
APP_PATTERNS=("index.html" "netlify/functions/*.js")

# Secret patterns (grep -E). Require actual key material after prefixes to avoid
# matching format descriptions in comments (e.g. "sk_live_..." or "appXXX").
SECRETS=(
  "app[A-Za-z0-9]{14}[^A-Za-z0-9]"  # Airtable base ID (17 exact alphanum chars)
  "tbl[A-Za-z0-9]{14}[^A-Za-z0-9]"  # Airtable table ID
  "pat[A-Za-z0-9]{14}\.[A-Za-z0-9]{64}"  # Airtable personal access token
  "/mnt/user-data/"                   # Cloud agent filesystem paths
  "sk_live_[A-Za-z0-9]{10}"          # Stripe live secret key (real key, not a comment)
  "sk_test_[A-Za-z0-9]{10}"          # Stripe test secret key
)

scan_content() {
  local label="$1"
  local content="$2"
  local found=0

  for pattern in "${SECRETS[@]}"; do
    if echo "$content" | grep -qE "$pattern"; then
      if [ "$found" -eq 0 ]; then
        echo ""
        echo "════════════════════════════════════════════════════════════"
        echo "  COMMIT BLOCKED: secrets or internal paths found in $label"
        echo "════════════════════════════════════════════════════════════"
      fi
      echo "  ✗ Pattern: $pattern"
      echo "$content" | grep -nE "$pattern" | head -3 | sed 's/^/      /'
      found=1
    fi
  done

  return "$found"
}

if [ "${1}" = "--working-tree" ]; then
  # Manual mode: scan application files on disk
  BLOCKED=0
  for glob in "${APP_PATTERNS[@]}"; do
    for f in $glob; do
      [ -f "$f" ] || continue
      if ! scan_content "$f" "$(cat "$f")"; then
        BLOCKED=1
      fi
    done
  done
  if [ "$BLOCKED" -eq 1 ]; then
    echo ""
    echo "  Remove these before committing."
    echo ""
    exit 1
  fi
  echo "pre-commit-guard: working tree clean ✓"
  exit 0
fi

# Hook mode: scan staged application files only
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

BLOCKED=0
while IFS= read -r file; do
  # Only scan application files
  is_app_file=0
  for glob in "${APP_PATTERNS[@]}"; do
    case "$file" in
      $glob) is_app_file=1; break ;;
    esac
  done
  [ "$is_app_file" -eq 0 ] && continue

  CONTENT=$(git show ":${file}" 2>/dev/null) || continue
  [ -z "$CONTENT" ] && continue

  if ! scan_content "$file" "$CONTENT"; then
    BLOCKED=1
  fi
done <<< "$STAGED_FILES"

if [ "$BLOCKED" -eq 1 ]; then
  echo ""
  echo "  Remove these before committing. If they came from the cloud agent's"
  echo "  build output, strip them before staging."
  echo ""
  exit 1
fi

# If index.html is staged, also run the full site integrity validator
if echo "$STAGED_FILES" | grep -q '^index\.html$'; then
  if command -v node >/dev/null 2>&1 && [ -f "build/validate-site.js" ]; then
    node build/validate-site.js index.html
  fi
else
  echo "pre-commit-guard: staged files clean ✓"
fi

exit 0
