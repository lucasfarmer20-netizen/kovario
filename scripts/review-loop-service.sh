#!/usr/bin/env bash
# Wrapper for review-loop.sh, run by the scheduled task (scripts/install-review-service.ps1).
# Each pass moves its own worktree to the latest origin/main, so the reviewer always runs the
# merged review-loop.sh and review-prompt.md, then runs one review pass.
#   --once  one pass and exit: the scheduled task's mode. Task Scheduler repeats it and kills
#           a pass that hangs (a long-lived Git Bash loop hung after the laptop slept).
#   (none)  loop forever, one pass every REVIEW_INTERVAL_SECS.
#   Token:  ${REVIEWER_PAT_FILE:-~/.kovario-reviewer-pat}  (reviewer-account PAT, one line)
#   Log:    ${REVIEW_LOG:-~/.ao/kovario-review-loop.log}
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="${REVIEW_LOG:-$HOME/.ao/kovario-review-loop.log}"
INTERVAL="${REVIEW_INTERVAL_SECS:-180}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

one_pass() {
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
}

if [ "${1:-}" = "--once" ]; then one_pass; exit 0; fi
while true; do one_pass; sleep "$INTERVAL"; done
