# Reviewer prompt (used by scripts/review-loop.sh)

You are reviewing one pull request that implements one work package. Be strict, be
specific, and never approve on vibes.

1. Identify the issue (`gh pr view --json body,title`, find `#<n>`; `gh issue view <n>`).
   Extract its **Acceptance** list and the docs under **Read first**. Read those docs.
2. Read the diff (`gh pr diff`). Read any test files it adds.
3. Produce a table: acceptance item → evidence in the diff (file:line or test name) →
   PASS/FAIL. Any FAIL = request changes.
4. Check the hard rules in `AGENTS.md` §Hard rules one by one. Any violation = request
   changes, quoting the line.
5. If the PR touches release, storage pickup, payments or vessels, check it against the
   relevant invariant table in `docs/10-LESSONS-FROM-CSP.md` (I1–I17, S1–S12, P1–P24)
   and list each invariant as satisfied / not applicable / violated.
6. Check for: secrets or sample keys; `any`; skipped tests; new tables without
   `enable_org_rls`; `asset_tag_id`-based occupancy; hand-built QR strings; vendor SDK
   imports outside `packages/payments`, `packages/shipping`, edge functions; missing
   `packages/db` type regeneration after a migration; major version bumps.
7. Decide. Approve only when every acceptance item is PASS and no hard-rule violation
   exists. Otherwise request changes with numbered, actionable findings (file, line,
   what, why, how to fix). Keep praise to one line.
