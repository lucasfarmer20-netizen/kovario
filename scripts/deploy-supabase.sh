#!/usr/bin/env bash
# Deploys this checkout to one hosted Supabase project (docs/11-DEPLOY.md): migrations
# (`db push`), every Edge Function, then config.toml settings incl. the auth hook
# (`config push`). Called by .github/workflows/deploy.yml and the CI migration dry-run.
#
#   bash scripts/deploy-supabase.sh <staging|production> [--dry-run]
#
# Env (values come from GitHub secrets/variables; never commit them):
#   SUPABASE_ACCESS_TOKEN  SUPABASE_PROJECT_REF  SUPABASE_DB_PASSWORD   required
#   SITE_URL       hosted auth site_url. Without it `config push` is skipped (with a warning):
#                  config.toml's site_url is the local one and must never reach a hosted project.
#   REDIRECT_URLS  optional, comma-separated extra auth redirect URLs (globs allowed)
# --dry-run runs `supabase db push --dry-run` only; nothing is written.
# No `supabase link`: every command takes --project-ref, so the token needs no API-key scopes.
# Token scopes (`supabase <cmd> --help`): db push — database pooling config read, database
# write (migrations); functions deploy — edge functions read-write; config push — the auth /
# database / data-api / storage / realtime config read scopes plus auth_config_write and
# project_admin_write.
# Seed files are never run against a hosted project.
set -euo pipefail

target=${1:-}
mode=${2:-}
case $target in
  staging | production) ;;
  *) echo "usage: deploy-supabase.sh <staging|production> [--dry-run]" >&2; exit 2 ;;
esac
: "${SUPABASE_ACCESS_TOKEN:?missing}" "${SUPABASE_PROJECT_REF:?missing}" "${SUPABASE_DB_PASSWORD:?missing}"
export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD # read by the CLI; never passed as arguments

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Work on a copy of supabase/: the hosted auth URLs go into a [remotes] block appended
# below, so the committed config.toml keeps its local values. Local link state and the
# per-worktree port file stay behind.
cp -R "$root/supabase" "$work/supabase"
rm -rf "$work/supabase/.temp" "$work/supabase/.env"
sb() { supabase --workdir "$work" "$@"; }
ref=(--project-ref "$SUPABASE_PROJECT_REF")
# GitHub runners have no IPv6, so db push needs the IPv4 pooler address, which the CLI reads
# from the API. Without that scope it falls back to the IPv6 host and suggests `link`.
pool_hint() {
  echo "::error::db push failed. 'IPv6 is not supported' means the token lacks the database pooling config read scope (docs/11-DEPLOY.md §1)"
  exit 1
}

if [ "$mode" = "--dry-run" ]; then
  sb db push "${ref[@]}" --dry-run || pool_hint
  exit 0
elif [ -n "$mode" ]; then
  echo "unknown option $mode" >&2
  exit 2
fi

if [ -n "${SITE_URL:-}" ]; then
  urls="\"${SITE_URL%/}/**\""
  IFS=',' read -ra extra <<<"${REDIRECT_URLS:-}"
  for url in "${extra[@]}"; do
    url=$(echo "$url" | xargs)
    if [ -n "$url" ]; then urls+=", \"$url\""; fi
  done
  cat >>"$work/supabase/config.toml" <<EOF

# Appended by scripts/deploy-supabase.sh for $target; applies only to this project ref.
[remotes.$target]
project_id = "$SUPABASE_PROJECT_REF"

[remotes.$target.auth]
site_url = "$SITE_URL"
additional_redirect_urls = [$urls]
EOF
fi

sb db push "${ref[@]}" --yes || pool_hint
# --prune: a function that is not in supabase/functions on this commit does not stay deployed.
sb functions deploy "${ref[@]}" --use-api --prune --yes
if [ -n "${SITE_URL:-}" ]; then
  sb config push "${ref[@]}" --yes
else
  echo "::warning::$target: SITE_URL not set, auth config (hook, URLs) not pushed; see docs/11-DEPLOY.md §1"
fi
echo "deployed $(git -C "$root" rev-parse --short HEAD) to $target"
