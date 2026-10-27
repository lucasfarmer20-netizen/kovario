#!/usr/bin/env bash
# Local PR reviewer + merger. Runs Claude Code headless (your Max/Pro subscription, no API key)
# against every open, non-draft PR whose latest commit CustomSeafoods hasn't reviewed yet,
# using scripts/review-prompt.md. Approves / requests changes as the REVIEWER account via
# GH_TOKEN so the author (your gh login) and the reviewer are different identities, then
# merges approved non-critical PRs itself: auto-merge if CI is still pending, else a direct
# squash merge. Branch protection on main (required "check" + 1 approval) gates both; an
# approved PR that didn't merge is retried on the next pass.
# AO's own autoReview is complementary: its findings go back to the worker session; this
# loop is what produces the GitHub approval and the merge, which AO does not do. AO does not
# forward this loop's GitHub reviews, so after requesting changes (or, on a critical PR,
# posting findings) the loop sends the owning AO session a pointer to the review.
# AO gate: for a PR whose branch belongs to an AO session, wait until AO's reviewer has a
# completed, non-"changes requested" verdict on the exact head commit (read from AO's
# local DB). Otherwise an approval here can merge over a review AO is still running. If
# every AO run on the commit failed, nothing is running, so the loop reviews without it.
# AO_GATE=0 disables it; PRs not opened by an AO session are not gated.
#
# Usage:  REVIEWER_PAT=ghp_... scripts/review-loop.sh            # loop forever, every 3 min
#         REVIEWER_PAT=ghp_... scripts/review-loop.sh --once     # single pass
# Requires: gh (authed as the authoring account), claude (Claude Code CLI, logged in), jq.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${REVIEWER_PAT:?set REVIEWER_PAT to the reviewer-account classic token (repo scope)}"
INTERVAL="${REVIEW_INTERVAL_SECS:-180}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
REVIEWER_LOGIN="$(GH_TOKEN="$REVIEWER_PAT" gh api user -q .login)"
echo "Reviewing $REPO as $REVIEWER_LOGIN"

review_one() {
  local num="$1" head="$2" critical="$3"
  local prompt
  prompt="You are the reviewer for PR #$num in $REPO. CRITICAL=$critical
Follow scripts/review-prompt.md exactly. Read AGENTS.md, the linked issue (gh issue view),
the docs the issue names, and the diff (gh pr diff $num). Do not edit files.
When CRITICAL=false finish by running exactly one of (do not merge; the loop does that):
  gh pr review $num --approve --body \"<summary>\"
  gh pr review $num --request-changes --body \"<numbered findings>\"
When CRITICAL=true post findings with: gh pr review $num --comment --body \"...\" and do NOT approve
(a review comment, not gh pr comment: it records the commit, so this commit is not reviewed again)."
  echo "== PR #$num ($head) critical=$critical"
  # stdin from /dev/null: otherwise claude reads the rest of the PR list off the pass's pipe
  GH_TOKEN="$REVIEWER_PAT" claude -p "$prompt" \
    --allowedTools "Bash(gh:*),Read,Grep,Glob" --max-turns 40 --output-format text < /dev/null \
    | tail -20 || echo "!! review of #$num failed"
}

# Latest review state (APPROVED, CHANGES_REQUESTED, COMMENTED) by the reviewer on this commit.
my_review() {
  gh api "repos/$REPO/pulls/$1/reviews" --paginate --slurp \
    | jq -r --arg u "$REVIEWER_LOGIN" --arg h "$2" '[.[][] | select(.user.login==$u and .commit_id==$h) | .state] | last // empty'
}

# Merge an approved non-critical PR. GitHub refuses auto-merge on a PR that is already
# mergeable, so a PR whose merge state is CLEAN (required check green + approved) is
# squash-merged directly; anything else gets auto-merge. The reviewer account has write
# access only (no admin or bypass), so branch protection on main still gates both.
merge_approved() {
  local num="$1" mstate
  mstate=$(gh pr view "$num" -R "$REPO" --json mergeStateStatus -q .mergeStateStatus)
  if [ "$mstate" = CLEAN ]; then
    GH_TOKEN="$REVIEWER_PAT" gh pr merge "$num" -R "$REPO" --squash
  else
    GH_TOKEN="$REVIEWER_PAT" gh pr merge "$num" -R "$REPO" --auto --squash
  fi || echo "!! merge of #$num ($mstate) failed; retrying next pass"
}

# Prints AO's verdict for (pr url, branch, head sha): none (not an AO PR) | pending | failed |
# changes_requested | <other completed verdict>. A PR is AO's if AO tracks its URL (pr table)
# or its branch is a session's branch.
PY=python3; "$PY" -c '' 2>/dev/null || PY=python   # Windows python3 Store stub
ao_verdict() {
  "$PY" -I - "$1" "$2" "$3" <<'PY'
import os, sqlite3, sys
url, branch, sha = sys.argv[1], sys.argv[2], sys.argv[3]
db = os.path.expanduser(os.environ.get("AO_DB", "~/.ao/data/ao.db"))
if not os.path.exists(db): print("none"); sys.exit()
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
s = (c.execute("select session_id from pr where url = ? and session_id != ''", (url,)).fetchone()
     or c.execute("select id from sessions where branch = ? order by created_at desc", (branch,)).fetchone())
if not s: print("none"); sys.exit()
rows = c.execute("select status, verdict from review_run where session_id = ? and target_sha = ?"
                 " order by created_at desc", (s[0], sha)).fetchall()
done = [v for st, v in rows if st == "complete"]
if done: print(done[0] or "approved")
elif any(st not in ("failed",) for st, _ in rows) or not rows: print("pending")
else: print("failed")
PY
}

# The AO session that owns a PR (same lookup as ao_verdict), or nothing.
ao_session() {
  "$PY" -I - "$1" "$2" <<'PY'
import os, sqlite3, sys
url, branch = sys.argv[1], sys.argv[2]
db = os.path.expanduser(os.environ.get("AO_DB", "~/.ao/data/ao.db"))
if not os.path.exists(db): sys.exit()
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
s = (c.execute("select session_id from pr where url = ? and session_id != ''", (url,)).fetchone()
     or c.execute("select id from sessions where branch = ? order by created_at desc", (branch,)).fetchone())
if s: print(s[0])
PY
}

# AO forwards its own reviewer's findings to the worker, but not this loop's GitHub review, so
# a worker otherwise sits idle on a change request. Tell the owning session where to read it.
notify_worker() {
  local num="$1" branch="$2" head="$3" what="$4" sid
  sid=$(ao_session "https://github.com/$REPO/pull/$num" "$branch" | tr -d '\r')
  [ -z "$sid" ] && return 0
  timeout 120 ao send --session "$sid" --message "The GitHub reviewer ($REVIEWER_LOGIN) $what on PR #$num at ${head:0:7}. Read it with: gh pr view $num --json reviews,comments, then address every required finding, re-run the checks in AGENTS.md, and push." \
    </dev/null >/dev/null 2>&1 && echo "-- #$num: told $sid about the review" || echo "!! could not notify $sid about #$num"
}

pass() {
  gh pr list -R "$REPO" --state open --json number,isDraft,headRefOid,headRefName,labels,body,autoMergeRequest \
  | jq -c '.[] | select(.isDraft|not)' | while read -r pr; do
    num=$(jq -r .number <<<"$pr"); head=$(jq -r .headRefOid <<<"$pr")
    branch=$(jq -r .headRefName <<<"$pr")
    labels=$(jq -r '[.labels[].name]|join(",")' <<<"$pr")
    issue=$(jq -r .body <<<"$pr" | grep -oiE '(closes|fixes|resolves) #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
    critical=false
    [[ "$labels" == *area:critical* ]] && critical=true
    if [ -n "$issue" ] && gh issue view "$issue" -R "$REPO" --json labels -q '.labels[].name' | grep -q area:critical; then critical=true; fi
    # already reviewed this exact commit by the reviewer account?
    mine=$(my_review "$num" "$head")
    if [ -n "$mine" ]; then
      # approved but not merged or queued (e.g. an earlier merge call failed): merge now
      if [ "$mine" = APPROVED ] && [ "$critical" = false ] && [ "$(jq -r '.autoMergeRequest == null' <<<"$pr")" = true ]; then
        echo "-- #$num: approved but not merged, merging"
        merge_approved "$num"
      fi
      continue
    fi
    # CI must have finished (green or red) for this commit before we spend a review
    state=$(gh api "repos/$REPO/commits/$head/check-runs" -q '[.check_runs[]|select(.name=="check")|.conclusion][0]' 2>/dev/null || echo null)
    [ "$state" = "null" ] && { echo "-- #$num: CI still running, skip"; continue; }
    if [ "${AO_GATE:-1}" != 0 ]; then
      verdict=$(ao_verdict "https://github.com/$REPO/pull/$num" "$branch" "$head" | tr -d '\r')
      case "$verdict" in
        none) ;;
        pending) echo "-- #$num: AO review of ${head:0:7} not finished, skip"; continue ;;
        # every AO run on this commit failed (AO gives up after a few and the CLI can't
        # re-trigger one): nothing is still running, so review without AO's verdict
        failed) echo "-- #$num: AO review of ${head:0:7} failed; reviewing without it" ;;
        changes_requested) echo "-- #$num: AO requested changes on ${head:0:7}, skip"; continue ;;
      esac
    fi
    review_one "$num" "$head" "$critical"
    result=$(my_review "$num" "$head")
    if [ "$critical" = true ]; then
      notify_worker "$num" "$branch" "$head" "posted review findings as a PR comment (area:critical: a human merges)"
    elif [ "$result" = APPROVED ]; then
      merge_approved "$num"
    elif [ "$result" = CHANGES_REQUESTED ]; then
      notify_worker "$num" "$branch" "$head" "requested changes"
    fi
  done
}

if [ "${1:-}" = "--once" ]; then pass; exit 0; fi
while true; do pass; sleep "$INTERVAL"; done
