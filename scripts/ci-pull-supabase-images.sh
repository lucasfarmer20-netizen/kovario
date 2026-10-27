#!/usr/bin/env bash
# CI helper: pre-pull the local-stack images `supabase start` needs, one at a time with
# retries, so start finds them locally instead of pulling ~10 in parallel. ghcr.io rate-limits
# each supabase/* image across all its users ("toomanyrequests: ... allowed: 44000/minute"),
# so a parallel burst fails even though a retry a moment later would succeed. An image ghcr.io
# keeps refusing is fetched from public.ecr.aws and retagged to the ghcr.io name the CLI
# expects (SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io).
#   Usage: scripts/ci-pull-supabase-images.sh [excluded service ...]   e.g. studio logflare
set -euo pipefail
skip=" $* "
attempts=6
pull_one() {
  local base="$1" tag="$2" target="ghcr.io/supabase/$1:$2" i
  for i in $(seq 1 "$attempts"); do
    docker pull -q "$target" >/dev/null 2>&1 && { echo "pulled $target"; return 0; }
    if docker pull -q "public.ecr.aws/supabase/$base:$tag" >/dev/null 2>&1; then
      docker tag "public.ecr.aws/supabase/$base:$tag" "$target"
      echo "pulled $target (via public.ecr.aws)"; return 0
    fi
    sleep $((i * 5))
  done
  echo "::warning::could not pre-pull $target after $attempts attempts; supabase start will try"
}
# `supabase services` lists the pinned image of every service as name/version pairs.
supabase services -o json | python3 -c '
import json, sys
d = json.load(sys.stdin)
for s in (d["services"] if isinstance(d, dict) else d):
    print(s["name"].split("/")[-1], s["local"])' | while read -r base tag; do
  case "$skip" in *" ${base} "*) continue ;; esac
  pull_one "$base" "$tag"
done
