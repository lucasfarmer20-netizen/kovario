# Kovario — Claude Code instructions

@AGENTS.md

## Permissions
- You may run git (branch, commit, push to your feature branch) and open PRs with `gh`
  without asking. Never push to `main`.
- You may install packages, run `supabase start/reset`, run tests and dev servers.
- You may create and edit files anywhere in this repository.

## Claude-specific notes
- Read the issue's **Read first** docs with the Read tool before writing code; do not
  rely on memory of the CSP Odoo project — Kovario has its own model.
- Prefer `Edit` over rewriting files; keep diffs reviewable.
- For SQL functions, write the test (`supabase/tests/*.sql` or vitest against local
  Supabase) before the function; name tests after invariants.
- When a doc is ambiguous and `docs/08-DECISIONS.md` has no default, stop and comment
  `BLOCKED:` on the issue rather than guessing.
