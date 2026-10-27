# AO postCreate hook: runs in each new session worktree (cwd = worktree root).
# pwsh so it behaves the same whatever shell AO hands postCreate to.
# Tolerates a pre-scaffold repo: WP-01 is the package that creates package.json.
$ErrorActionPreference = "Stop"
if (Test-Path package.json) {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { pnpm install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
} else {
  Write-Host "no package.json yet; skipping pnpm install"
}
if (-not (Test-Path .env) -and (Test-Path .env.example)) { Copy-Item .env.example .env }

# Per-workspace local Supabase stack. Parallel workers otherwise share project_id "kovario"
# and ports 543xx, so one worker's `db reset` wipes another's database. The CLI reads
# supabase/.env (gitignored) and applies SUPABASE_* overrides to every command in this
# worktree: start/stop, db reset, test db, gen types --local, and the `supabase status`
# the *.db.test.ts fixtures use. Workspace kovario-N gets stack kovarioN on a 100-port
# block at P = 20000 + (N % 290) * 100 (P+21 API, P+22 DB, ...): 290 distinct slots, all
# below Windows' dynamic range (49152+) and the Hyper-V/WSL reservations above 50000, and
# never the 543xx defaults the main clone (no trailing number) keeps.
# apps/web/.env.local is written by `node scripts/web-env.mjs` once the stack is running,
# so no key is stored in the repo.
$name = Split-Path -Leaf (Get-Location)
if ((Test-Path supabase/config.toml) -and -not (Test-Path supabase/.env) -and $name -match '-(\d+)$') {
  $n = [int]$Matches[1]
  $p = 20000 + ($n % 290) * 100
  @(
    "SUPABASE_PROJECT_ID=kovario$n"
    "SUPABASE_API_PORT=$($p + 21)"
    "SUPABASE_DB_PORT=$($p + 22)"
    "SUPABASE_DB_SHADOW_PORT=$($p + 20)"
    "SUPABASE_DB_POOLER_PORT=$($p + 29)"
    "SUPABASE_STUDIO_PORT=$($p + 23)"
    "SUPABASE_LOCAL_SMTP_PORT=$($p + 24)"
    "SUPABASE_ANALYTICS_PORT=$($p + 27)"
    "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT=$($p + 83)"
  ) | Set-Content -Encoding utf8NoBOM supabase/.env
  Write-Host "local Supabase stack: kovario$n on ports $p-$($p + 99)"
}
