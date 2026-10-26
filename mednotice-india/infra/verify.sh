#!/bin/bash
set -uo pipefail

IP="${1:?usage: verify.sh <public-ip> [pem]}"
PEM="${2:-terraform-key.pem}"
U="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -i $PEM ubuntu@$IP"

echo "=== waiting for SSH ==="
for i in $(seq 1 100); do
  if $U "true" >/dev/null 2>&1; then echo "SSH up after $((i*5))s"; break; fi
  sleep 5
done

echo "=== app health on instance ==="
$U "curl -fsS http://127.0.0.1:4100/api/health || echo 'HEALTH FAILED'"
echo "=== services ==="
$U "systemctl is-active mednotice || echo mednotice-inactive"
$U "systemctl is-active caddy || echo caddy-inactive"
echo "=== data volume ==="
$U "findmnt -n /var/lib/mednotice || echo 'not a separate mount'"

echo "=== public HTTP (Caddy :80) ==="
curl -sS -m 20 -w "\nHTTP %{http_code}\n" "http://$IP/api/health" || echo "public :80 failed"

echo "=== public direct app port :4100 ==="
curl -sS -m 20 -w "\nHTTP %{http_code}\n" "http://$IP:4100/api/health" || echo "direct :4100 failed"

echo "=== sign in as facility.aiims ==="
rm -f /tmp/mn-cookies.txt
curl -sS -m 20 -c /tmp/mn-cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"facility.aiims@mednotice.in","password":"Facility!2345"}' \
  "http://$IP/api/auth/login" -o /tmp/mn-login.json -w "login HTTP %{http_code}\n"
head -c 250 /tmp/mn-login.json; echo

echo "=== facility workspace ==="
curl -sS -m 20 -b /tmp/mn-cookies.txt "http://$IP/api/admin/facility" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('facility:', d['facility']['id'], d['facility']['name'])
print('counts  :', d['counts'])
print('cases   :', [(c['id'], c['status'], c['verificationStatus']) for c in d['cases']])
" 2>/dev/null || echo "facility workspace read failed"

echo "=== restart service, re-check persistence ==="
$U "systemctl restart mednotice && sleep 6 && systemctl is-active mednotice"
$U "curl -fsS http://127.0.0.1:4100/api/health"
echo
$U "ls -la /var/lib/mednotice | head"
