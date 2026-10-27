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

# One pass at a time. When Task Scheduler kills a pass at its time limit it ends pwsh, but the
# Git Bash and claude children can live on, and IgnoreNew only sees the task. So each --once
# pass takes a lock dir holding its pid; a later pass skips while that pid is alive, and takes
# over a lock older than 45 min (that pass is hung).
LOCK="$LOG.lock"
take_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  local pid; pid=$(cat "$LOCK/pid" 2>/dev/null || echo)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +45)" ]; then
    return 1
  fi
  echo "--- $(date -u +%FT%TZ) taking over stale lock (pid ${pid:-?})"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  rm -rf "$LOCK" && mkdir "$LOCK" && echo $$ > "$LOCK/pid"
}

if [ "${1:-}" = "--once" ]; then
  take_lock || exit 0
  trap 'rm -rf "$LOCK"' EXIT
  one_pass; exit 0
fi
while true; do one_pass; sleep "$INTERVAL"; done
