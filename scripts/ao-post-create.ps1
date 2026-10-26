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
