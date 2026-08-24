#!/bin/bash
# Give the pod the uncommitted work the measuring harness needs to see.
#
# Screens 04 and 12 draw a file list and a diff, and screen 05 draws a change count. With a clean
# working tree they correctly draw none of those, and `measure.mjs` reports a dozen selectors
# missing - which looks exactly like a rendering regression and is not one. That happened after a
# round of verifiers committed their scratch work and left the tree clean.
#
# So the fixture is part of the harness, not something a run can assume. This writes one modified
# tracked file and one new file, which between them produce an added row, a removed row and an
# untracked entry.
#
# `undo` puts it back. Run it when you are done, or the next person to open the Studio sees a
# change nobody made.
set -euo pipefail
POD='deploy/barn-base-extension'
MARK='harness fixture: delete this line'
# The queue only lists work that has been handed over for review, so with no packet it correctly
# renders no rows - and the harness then reports every row selector missing, which reads exactly
# like a rendering regression. It is not one: it is the queue telling the truth. So the fixture
# has to include a handed-over packet, the same way it has to include uncommitted work.
REVIEW_CM='barn-review-base'

case "${1:-seed}" in
  seed)
    kubectl -n barn exec $POD -- sh -c "cd /app/pkg/*/ && \
      printf '\n// %s\n' '$MARK' >> product.ts && \
      printf '# Harness fixture\n\nA new file, so the file list has an untracked row.\n' > HARNESS.md"
    sha=$(kubectl -n barn exec $POD -- sh -c 'cd /app/pkg/base && git rev-parse --short HEAD' 2>/dev/null | tr -d '\r\n')
    now=$(kubectl -n barn exec $POD -- sh -c 'date -u +%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null | tr -d '\r\n')
    # Merge into whatever the record already holds: other people's looks and comments stay.
    kubectl -n barn get cm $REVIEW_CM -o jsonpath='{.data.review\.json}' 2>/dev/null > /tmp/barn-review-cur.json || true
    [ -s /tmp/barn-review-cur.json ] || echo '{}' > /tmp/barn-review-cur.json
    SHA="$sha" NOW="$now" python3 - <<'PYEOF' > /tmp/barn-review-next.json
import json, os
cur = json.load(open('/tmp/barn-review-cur.json'))
cur.setdefault('signoffs', {}); cur.setdefault('looks', {}); cur.setdefault('comments', [])
cur['packets'] = cur.get('packets') or {}
cur['packets']['1'] = {
    'n': 1, 'ref': 'refs/barn/packets/1', 'branch': 'barn/base/1',
    'sha': os.environ['SHA'], 'base': os.environ['SHA'], 'at': os.environ['NOW'],
    'by': 'local://user-btc48', 'byName': 'Default Admin', 'brief': True,
}
print(json.dumps(cur))
PYEOF
    kubectl -n barn create configmap $REVIEW_CM --from-file=review.json=/tmp/barn-review-next.json \
      --dry-run=client -o yaml | kubectl -n barn apply -f - >/dev/null
    rm -f /tmp/barn-review-cur.json /tmp/barn-review-next.json
    # The ref as well as the record. Without it the fixture contradicts itself: the queue and
    # screen 12 read the ConfigMap and show packet 1, while distributionGate() resolves the ref
    # and reads the extension as never handed over. A verifier lost time to that disagreement
    # before working out it was the fixture and not the product.
    kubectl -n barn exec $POD -- sh -c "cd /app/pkg/base && git update-ref refs/barn/packets/1 HEAD" >/dev/null 2>&1
    echo "seeded: product.ts modified, HARNESS.md added, packet 1 handed over (record + ref)"
    ;;
  undo)
    kubectl -n barn exec $POD -- sh -c "cd /app/pkg/*/ && \
      git checkout -- product.ts 2>/dev/null ; rm -f HARNESS.md ; git reset -q -- HARNESS.md 2>/dev/null ; true"
    kubectl -n barn get cm $REVIEW_CM -o jsonpath='{.data.review\.json}' 2>/dev/null > /tmp/barn-review-cur.json || true
    if [ -s /tmp/barn-review-cur.json ]; then
      python3 - <<'PYEOF' > /tmp/barn-review-next.json
import json
cur = json.load(open('/tmp/barn-review-cur.json'))
(cur.get('packets') or {}).pop('1', None)
print(json.dumps(cur))
PYEOF
      kubectl -n barn create configmap $REVIEW_CM --from-file=review.json=/tmp/barn-review-next.json \
        --dry-run=client -o yaml | kubectl -n barn apply -f - >/dev/null
      rm -f /tmp/barn-review-cur.json /tmp/barn-review-next.json
    fi
    kubectl -n barn exec $POD -- sh -c "cd /app/pkg/base && git update-ref -d refs/barn/packets/1" >/dev/null 2>&1
    echo "removed"
    ;;
  *) echo "usage: seed-fixture.sh [seed|undo]" >&2; exit 2 ;;
esac
kubectl -n barn exec $POD -- sh -c 'cd /app/pkg/*/ && git status --porcelain'
