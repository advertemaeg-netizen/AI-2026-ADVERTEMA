#!/usr/bin/env bash
# npm run check: types (test files included), lint, tests — before every commit (AGENTS.md).
#
# Everything the run prints also goes to a log. A clean run deletes it; a failed
# run keeps it in .scratch/check-failures/ (never committed). The multi-message
# webhook tests have a real ordering defect that shows up as a rare failure, and
# each one is evidence about its mechanism: a flake during unrelated work must
# leave that evidence behind without anyone having to remember to save it.
set -uo pipefail

dir=".scratch/check-failures"
mkdir -p "$dir"
log="$dir/check-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit).log"

{
  echo "# npm run check — $(date -u +%Y-%m-%dT%H:%M:%SZ) — HEAD $(git rev-parse HEAD 2>/dev/null)"
  git status --short 2>/dev/null | sed 's/^/# /'
} > "$log"

status=0
for step in "tsc --noEmit" "eslint" "vitest run"; do
  echo "## $step" >> "$log"
  npx $step 2>&1 | tee -a "$log"
  code=${PIPESTATUS[0]}
  if [ "$code" -ne 0 ]; then
    status=$code
    echo "## $step exited $code" >> "$log"
    break
  fi
done

if [ "$status" -eq 0 ]; then
  rm -f "$log"
else
  echo
  echo "check failed: the full output is kept in $log"
fi
exit "$status"
