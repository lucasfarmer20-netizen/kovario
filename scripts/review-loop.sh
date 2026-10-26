#!/usr/bin/env bash
# Local PR reviewer + merger. Runs Claude Code headless (your Max/Pro subscription, no API key)
# against every open, non-draft PR whose latest commit CustomSeafoods hasn't reviewed yet,
# using scripts/review-prompt.md. Approves / requests changes as the REVIEWER account via
# GH_TOKEN so the author (your gh login) and the reviewer are different identities, and
# arms GitHub auto-merge on approved non-critical PRs (merges once CI is green).
# AO's own autoReview is complementary: its findings go back to the worker session; this
# loop is what produces the GitHub approval and the merge, which AO does not do.
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
When CRITICAL=false finish by running exactly one of:
  gh pr review $num --approve --body \"<summary>\" && gh pr merge $num --auto --squash
  gh pr review $num --request-changes --body \"<numbered findings>\"
When CRITICAL=true post findings with: gh pr comment $num --body \"...\" and do NOT approve."
  echo "== PR #$num ($head) critical=$critical"
  GH_TOKEN="$REVIEWER_PAT" claude -p "$prompt" \
    --allowedTools "Bash(gh:*),Read,Grep,Glob" --max-turns 40 --output-format text \
    | tail -20 || echo "!! review of #$num failed"
}

pass() {
  gh pr list -R "$REPO" --state open --json number,isDraft,headRefOid,labels,body \
  | jq -c '.[] | select(.isDraft|not)' | while read -r pr; do
    num=$(jq -r .number <<<"$pr"); head=$(jq -r .headRefOid <<<"$pr")
    labels=$(jq -r '[.labels[].name]|join(",")' <<<"$pr")
    issue=$(jq -r .body <<<"$pr" | grep -oiE '(closes|fixes|resolves) #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
    critical=false
    [[ "$labels" == *area:critical* ]] && critical=true
    if [ -n "$issue" ] && gh issue view "$issue" -R "$REPO" --json labels -q '.labels[].name' | grep -q area:critical; then critical=true; fi
    # already reviewed this exact commit by the reviewer account?
    if gh api "repos/$REPO/pulls/$num/reviews" --paginate \
       | jq -e --arg u "$REVIEWER_LOGIN" --arg h "$head" '.[] | select(.user.login==$u and .commit_id==$h)' >/dev/null; then
      continue
    fi
    # CI must have finished (green or red) for this commit before we spend a review
    state=$(gh api "repos/$REPO/commits/$head/check-runs" -q '[.check_runs[]|select(.name=="check")|.conclusion][0]' 2>/dev/null || echo null)
    [ "$state" = "null" ] && { echo "-- #$num: CI still running, skip"; continue; }
    review_one "$num" "$head" "$critical"
  done
}

if [ "${1:-}" = "--once" ]; then pass; exit 0; fi
while true; do pass; sleep "$INTERVAL"; done
