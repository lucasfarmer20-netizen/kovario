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
# the *.db.test.ts fixtures use. Workspace kovario-N gets stack kovarioN on ports B3xx,
# B = 55 + N % 10 (55..64); the main clone (no trailing number) keeps the 543xx defaults.
$name = Split-Path -Leaf (Get-Location)
if ((Test-Path supabase/config.toml) -and -not (Test-Path supabase/.env) -and $name -match '-(\d+)$') {
  $n = [int]$Matches[1]
  $b = 55 + ($n % 10)
  @(
    "SUPABASE_PROJECT_ID=kovario$n"
    "SUPABASE_API_PORT=${b}321"
    "SUPABASE_DB_PORT=${b}322"
    "SUPABASE_DB_SHADOW_PORT=${b}320"
    "SUPABASE_DB_POOLER_PORT=${b}329"
    "SUPABASE_STUDIO_PORT=${b}323"
    "SUPABASE_LOCAL_SMTP_PORT=${b}324"
    "SUPABASE_ANALYTICS_PORT=${b}327"
    "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT=${b}083"
  ) | Set-Content -Encoding utf8NoBOM supabase/.env
  # `pnpm dev` in this worktree talks to its own stack (anon key is the same local default).
  if (-not (Test-Path apps/web/.env.local) -and (Test-Path apps/web)) {
    "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${b}321" | Set-Content -Encoding utf8NoBOM apps/web/.env.local
  }
  Write-Host "local Supabase stack: kovario$n on ports ${b}3xx"
}
