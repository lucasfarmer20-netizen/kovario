#!/usr/bin/env bash
# Long-running wrapper for review-loop.sh, meant to be started at logon (see
# scripts/install-review-service.ps1). Each pass it moves its own worktree to the latest
# origin/main, so the reviewer always runs the merged review-loop.sh and review-prompt.md,
# then runs one review pass. A failed pass is logged and retried next interval.
#   Token:  ${REVIEWER_PAT_FILE:-~/.kovario-reviewer-pat}  (reviewer-account PAT, one line)
#   Log:    ${REVIEW_LOG:-~/.ao/kovario-review-loop.log}
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="${REVIEW_LOG:-$HOME/.ao/kovario-review-loop.log}"
INTERVAL="${REVIEW_INTERVAL_SECS:-180}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

while true; do
  echo "--- $(date -u +%FT%TZ) pass"
  if [ -n "$(git status --porcelain)" ]; then
    echo "worktree is dirty; not updating"
  else
    git fetch -q origin main && git checkout -q --detach origin/main || echo "update failed"
  fi
  REVIEWER_PAT="$(tr -d '\r\n ' < "${REVIEWER_PAT_FILE:-$HOME/.kovario-reviewer-pat}")" \
    scripts/review-loop.sh --once < /dev/null || echo "pass failed (exit $?)"
  # keep the log bounded: last ~5000 lines
  if [ "$(wc -l < "$LOG")" -gt 10000 ]; then tail -n 5000 "$LOG" > "$LOG.tmp" && cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"; fi
  sleep "$INTERVAL"
done
