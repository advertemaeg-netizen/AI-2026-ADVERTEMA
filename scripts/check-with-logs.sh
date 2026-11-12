#!/usr/bin/env bash
# THE CHECK, WITH THE HARNESS'S LOGS, AND ITS VERDICT (moved here from a
# session scratchpad on 2026-11-10, after a session restart wiped it twice).
#
#   scripts/check-with-logs.sh <run number>                full `npm run check`
#   scripts/check-with-logs.sh <run number> --access-only  `npx vitest run --project access`
#
# Both write PostgREST's log and pglite-socket's log (HARNESS_LOG_DIR,
# HARNESS_SOCKET_LOG=1; tests/harness/stack.ts) to
# .scratch/check-failures/harness-run<n>-<time>/. A clean run deletes the
# socket logs (240 MB) and keeps the PostgREST logs. A failed full run prints
# the signature script's verdict (scripts/access-stuck-signature.mjs: only
# its STUCK earns a rerun, AGENTS.md), and both modes print the access
# project's `received T` count (pglite-socket's "Too many connections")
# against the socket's rejections: the parked mechanism's evidence.
#
# The full check's own log is check.sh's (.scratch/check-failures/check-*.log);
# the access-only mode keeps vitest's output as access-run<n>-<time>.log.
# Name every run, its verdict and its log in the commit message.
set -u
cd "$(dirname "$0")/.." || exit 1
n=${1:?usage: scripts/check-with-logs.sh <run number> [--access-only]}
mode=${2:-full}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
logs=".scratch/check-failures/harness-run$n-$stamp"
# pglite-socket's slot count, per project (tests/harness/stack.ts): leaks seen, and the state at stop
slot_lines() {
  for f in "$logs"/*-slots.log; do
    [ -f "$f" ] || continue
    echo "  $(basename "$f" .log): leaked-slot lines $(grep -c 'slot leaked' "$f"); $(grep 'at stop' "$f" | tail -1 | sed 's/^[^ ]* //')"
  done
}
mkdir -p .scratch/check-failures
before=$(ls .scratch/check-failures/check-*.log 2>/dev/null | sort | tail -1)
start=$(date +%s)
if [ "$mode" = "--access-only" ]; then
  out=".scratch/check-failures/access-run$n-$stamp.log"
  HARNESS_LOG_DIR="$logs" HARNESS_SOCKET_LOG=1 npx vitest run --project access > "$out" 2>&1
  code=$?
  label="vitest --project access"
else
  HARNESS_LOG_DIR="$logs" HARNESS_SOCKET_LOG=1 npm run check > /dev/null 2>&1
  code=$?
  label="npm run check"
fi
secs=$(( $(date +%s) - start ))
echo "run $n: $label exit $code after ${secs}s"
if [ "$code" -eq 0 ]; then
  rm -f "$logs"/*-socket.log
  [ "$mode" = "--access-only" ] && rm -f "$out"
  echo "  CLEAN: socket logs deleted; PostgREST logs kept in $logs"
  slot_lines
  exit 0
fi
if [ "$mode" = "--access-only" ]; then
  echo "  log: $out"
  echo "  $(grep -E '^ +Tests ' "$out" | tail -1 | sed 's/^ *//')"
else
  after=$(ls .scratch/check-failures/check-*.log 2>/dev/null | sort | tail -1)
  if [ "$after" != "$before" ]; then
    echo "  log: $after"
    echo "  $(grep -E '^ +Tests ' "$after" | tail -1 | sed 's/^ *//')"
    echo "  verdict: $(node scripts/access-stuck-signature.mjs "$after")"
  fi
fi
pg="$logs/access-postgrest.log"
t=$(grep -m1 'but received T' "$pg" 2>/dev/null | cut -c1-23)
echo "  access PostgREST: received T x$(grep -c 'but received T' "$pg" 2>/dev/null), first at ${t:-none}; waits: $(grep -oE 'reconnect to the database in [0-9]+ seconds' "$pg" 2>/dev/null | grep -oE '[0-9]+' | sort -n | uniq -c | tr '\n' ' ')"
for f in "$logs"/*-socket.log; do
  [ -f "$f" ] || continue
  echo "  $(basename "$f"): $(du -h "$f" | cut -f1), 'max connections reached, rejecting' x$(grep -c 'max connections reached, rejecting' "$f")"
  if [ -n "$t" ]; then
    sec=${t:0:19}
    echo "    rejections within the second of the first T ($sec): $(grep 'max connections reached, rejecting' "$f" | grep -c "^$sec")"
    echo "    first rejection: $(grep -m1 'max connections reached, rejecting' "$f" | cut -c1-23)"
  fi
done
echo "  logs kept: $logs"
slot_lines
exit "$code"
