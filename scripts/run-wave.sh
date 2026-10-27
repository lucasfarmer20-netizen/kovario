#!/usr/bin/env bash
# Spawn every issue in wave N whose blockers are all closed. Re-run as blockers merge.
# Usage: scripts/run-wave.sh 1 [--dry-run]   (extra args are passed to `ao spawn`)
set -euo pipefail
cd "$(dirname "$0")/.."
WAVE="${1:?wave number}"; shift || true
DRY=0; AGENT_ARGS=()
for a in "$@"; do case "$a" in --dry-run) DRY=1;; *) AGENT_ARGS+=("$a");; esac; done
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
PROJECT="${AO_PROJECT:-kovario}"
[ -f issues/map.json ] || { echo "run scripts/seed-issues.sh first"; exit 1; }
# Windows ships a python3 Store stub that just errors; fall back to python.
PY=python3; "$PY" -c '' 2>/dev/null || PY=python
"$PY" - "$REPO" "$WAVE" <<'PY' > /tmp/kv-wave-spawn.txt
import json, subprocess, sys
sys.stdout.reconfigure(newline='\n')  # no CRLF into the bash read loop
repo, wave = sys.argv[1], int(sys.argv[2])
wpmap = json.load(open('issues/map.json', encoding='utf-8'))
issues = json.loads(subprocess.check_output(['gh','issue','list','-R',repo,'--state','all','--limit','500','--json','number,state,labels']))
prs = json.loads(subprocess.check_output(['gh','pr','list','-R',repo,'--state','open','--limit','200','--json','body,headRefName']))
import re
inflight = set()
for p in prs:
    # only closing keywords count: a PR that merely mentions "#21" (a cross-reference to
    # another WP) must not mark issue 21 as in flight
    inflight |= {int(x) for x in re.findall(r'(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)', p.get('body') or '')}
    hm = re.match(r'feat/(\d+)-', p.get('headRefName') or '')
    if hm: inflight.add(int(hm.group(1)))
state = {i['number']: i['state'] for i in issues}
labels = {i['number']: [l['name'] for l in i['labels']] for i in issues}
for wp, num in sorted(wpmap.items()):
    ls = labels.get(num, [])
    if f'wave:{wave}' not in ls or state.get(num) != 'OPEN': continue
    blockers = [l.split(':',1)[1] for l in ls if l.startswith('blocked-by:')]
    open_blockers = [b for b in blockers if state.get(wpmap.get(b, -1)) == 'OPEN']
    if open_blockers: print(f'# skip {wp} (#{num}) blocked by {open_blockers}'); continue
    if num in inflight: print(f'# skip {wp} (#{num}) already has an open PR'); continue
    heavy = {'area:critical','area:db','area:rules','area:payments'}
    agent = 'codex' if any(l in ls for l in ('area:ui','area:labels')) and not (heavy & set(ls)) else 'claude-code'
    print(f'{num} {agent} {wp}')
PY
cat /tmp/kv-wave-spawn.txt
while read -r num agent wp; do
  [[ "$num" == \#* || -z "$num" ]] && continue
  prompt="Work GitHub issue #$num ($wp) per AGENTS.md: read the issue and its Read first docs, implement it on this branch, and open a PR with the issue's labels and 'Closes #$num'."
  cmd=(ao spawn --project "$PROJECT" --name "$wp" --issue "$num" --harness "$agent" --branch "feat/$num-${wp,,}" --prompt "$prompt" ${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"})
  echo "+ ${cmd[*]}"; [ "$DRY" = 1 ] || { "${cmd[@]}"; sleep 1; }
done < /tmp/kv-wave-spawn.txt
