#!/usr/bin/env bash
# Seed labels, milestones and the 24 work-package issues into the current GitHub repo.
# Requires: gh (authenticated, write access), python3. Idempotent: skips issues whose
# title already exists. Writes issues/map.json  { "WP-01": 1, ... }.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
echo "Seeding $REPO"

label() { gh label create "$1" --color "$2" --description "$3" -R "$REPO" --force >/dev/null; }
label work-package 0E8A16 "One AO session, one PR"
label area:infra 1D76DB "Repo, CI, hosting"; label area:db 5319E7 "Schema, SQL, RLS"
label area:security B60205 "Auth, tenancy, secrets"; label area:rules FBCA04 "packages/rules"
label area:ui C2E0C6 "Station and admin screens"; label area:integrations 0052CC "Printers, scale, Shippo"
label area:labels 0052CC "ZPL/PDF templates"; label area:payments D93F0B "Card-present payments"
label area:billing D93F0B "Stripe Billing"; label area:test 006B75 "Test suites"
label area:critical B60205 "Human approval required before merge"; label post-v1 EEEEEE "Not in v1"
for w in 0 1 2 3 4 5; do label "wave:$w" BFD4F2 "Dependency wave $w"; done
for n in $(seq -w 1 24); do label "blocked-by:WP-$n" FEF2C0 "Blocked until WP-$n is merged"; done
for w in 0 1 2 3 4 5; do gh api -X POST "repos/$REPO/milestones" -f title="Wave $w" >/dev/null 2>&1 || true; done

python3 - "$REPO" <<'PY'
import json, re, subprocess, sys, glob, os
repo = sys.argv[1]
existing = {i['title']: i['number'] for i in json.loads(subprocess.check_output(
    ['gh','issue','list','-R',repo,'--state','all','--limit','500','--json','title,number']))}
mapping = {}
for fn in sorted(glob.glob('issues/WP-*.md')):
    text = open(fn).read()
    fm_raw, body = text.split('---\n',2)[1:]
    fm = json.loads(fm_raw)
    wp = fm['title'].split(':')[0]
    if fm['title'] in existing:
        mapping[wp] = existing[fm['title']]; print('exists', wp, existing[fm['title']]); continue
    args = ['gh','issue','create','-R',repo,'--title',fm['title'],'--body',body,
            '--milestone',f"Wave {fm['wave']}"]
    for l in fm['labels']: args += ['--label', l]
    url = subprocess.check_output(args).decode().strip()
    num = int(url.rstrip('/').split('/')[-1]); mapping[wp] = num
    print('created', wp, num)
json.dump(mapping, open('issues/map.json','w'), indent=2)
PY
echo "Wrote issues/map.json"
