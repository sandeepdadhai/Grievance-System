#!/usr/bin/env bash
# Smoke test for the authority/facility directory against a running API.
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:4100}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

echo "== public jurisdictions =="
curl -s "$BASE/api/public/jurisdictions" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d).jurisdictions.find(x=>x.code==="IN");console.log("authorities:",j.authorities.map(a=>a.id).join(", "));})'

echo "== admin login =="
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@mednotice.in","password":"Admin!2345"}' -o /dev/null -w 'login status %{http_code}\n'

echo "== directory listing =="
curl -s -b "$JAR" "$BASE/api/admin/directory/authorities" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d).authorities;console.log("count:",a.length);console.log(a.map(x=>`${x.id} | ${x.name} | ${x.region} | ${x.adapter} | ${x.status} | facilities=${x.facilityCount} | cases=${x.caseCount}`).join("\n"));})'

echo "== create authority =="
curl -s -b "$JAR" -X POST "$BASE/api/admin/directory/authorities" -H 'content-type: application/json' \
  -d '{"id":"IN-SHA-GJ","name":"Health and Family Welfare Department, Gujarat","region":"Gujarat","adapter":"IN-REST","contactEmail":"grievance.hfw@gujarat.gov.in","webhook":"https://sandbox.mednotice.in/in/gj/health/cases"}' \
  -w '\nstatus %{http_code}\n' | head -c 600

echo "== create facility =="
curl -s -b "$JAR" -X POST "$BASE/api/admin/directory/facilities" -H 'content-type: application/json' \
  -d '{"id":"FAC-IN-012","name":"Civil Hospital, Ahmedabad","authorityId":"IN-SHA-GJ","city":"Ahmedabad","letterheadKeywords":["Civil Hospital","Ahmedabad Civil"]}' \
  -w '\nstatus %{http_code}\n' | head -c 600

echo "== public selection =="
curl -s "$BASE/api/public/jurisdictions" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d).jurisdictions.find(x=>x.code==="IN");const a=j.authorities.find(x=>x.id==="IN-SHA-GJ");console.log("visible at intake:",a?`${a.id} -> ${a.name} (${a.region})`:"MISSING");})'
curl -s "$BASE/api/public/facilities?authority=IN-SHA-GJ" | head -c 400; echo

echo "== edit authority =="
curl -s -b "$JAR" -X PATCH "$BASE/api/admin/directory/authorities/IN-SHA-GJ" -H 'content-type: application/json' \
  -d '{"name":"Gujarat Health and Family Welfare Department"}' -w '\nstatus %{http_code}\n' | head -c 400

echo "== reviewer is denied =="
RJAR=$(mktemp)
curl -s -c "$RJAR" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"reviewer@mohfw.gov.in","password":"Review!2345"}' -o /dev/null
curl -s -b "$RJAR" -X POST "$BASE/api/admin/directory/authorities" -H 'content-type: application/json' \
  -d '{"id":"IN-SHA-XX","name":"Denied Authority","region":"Test","adapter":"IN-REST","contactEmail":"x@example.gov.in","webhook":"https://sandbox.mednotice.in/x"}' \
  -w '\nstatus %{http_code}\n' | head -c 300
rm -f "$RJAR"

echo "== cleanup =="
curl -s -b "$JAR" -X DELETE "$BASE/api/admin/directory/facilities/FAC-IN-012" -w ' facility status %{http_code}\n'
curl -s -b "$JAR" -X DELETE "$BASE/api/admin/directory/authorities/IN-SHA-GJ" -w ' authority status %{http_code}\n'

echo "== audit =="
curl -s -b "$JAR" "$BASE/api/admin/audit?limit=200" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const rows=JSON.parse(d).rows;const acts=rows.filter(r=>/AUTHORITY_|FACILITY_/.test(r.action)).map(r=>r.action);console.log([...new Set(acts)].join(", "));})'
curl -s -b "$JAR" "$BASE/api/admin/audit/verify" | head -c 200; echo
