#!/usr/bin/env bash
# usage: edit_image.sh <input image> <output png> <prompt file>
set -euo pipefail
source "$(dirname "$0")/mistral_failover.sh"
IN="$1"; OUT="$2"; PROMPT_FILE="$3"
# MISTRAL_KEY=A|B|C picks the workspace; each workspace has its own agent
case "${MISTRAL_KEY:-B}" in
  C) CONF="$HOME/.vibe/mistral_curl_keyC.conf"; AGENT="ag_01a0f2bc01d4739880edc0be391ad765" ;;
  A) CONF="$HOME/.vibe/mistral_curl_keyA.conf"; AGENT="ag_01a0f2153a017375ae140eab15522710" ;;
  B) CONF="$HOME/.vibe/mistral_curl_keyB.conf"; AGENT="ag_01a0f2702e31768a9bde515228083588" ;;
  *) echo "MISTRAL_KEY must be A, B or C" >&2; exit 2 ;;
esac
TMP="${TMPDIR:-/tmp}/mistral_edit_$$"; mkdir -p "$TMP"

curl -s --config "$CONF" https://api.mistral.ai/v1/files \
  -F purpose=image_generation -F "file=@$IN" > "$TMP/upload.json"
FID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).id)' "$TMP/upload.json")
curl -s --config "$CONF" "https://api.mistral.ai/v1/files/$FID/url?expiry=24" > "$TMP/url.json"
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).url)' "$TMP/url.json")

node -e '
const fs=require("fs");
const [url,pf,agent,out]=process.argv.slice(1);
const p=fs.readFileSync(pf,"utf8");
const inputs=`Call the image_generation tool function edit_image with these exact arguments.\nimage_url: ${url}\nprompt: ${p}`;
fs.writeFileSync(out, JSON.stringify({agent_id:agent, inputs}));
' "$URL" "$PROMPT_FILE" "$AGENT" "$TMP/req.json"

curl -s --config "$CONF" https://api.mistral.ai/v1/conversations \
  -H "Content-Type: application/json" --data @"$TMP/req.json" > "$TMP/resp.json"

IMG=$(node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1]));
if(!r.outputs){console.error(JSON.stringify(r));process.exit(1)}
for(const o of r.outputs){ if(o.type==="tool.execution"){ const s=JSON.stringify(o.info||{}); const m=s.match(/https:[^"\\]+/); if(m){console.log(m[0]);process.exit(0)} } }
console.error(JSON.stringify(r.outputs).slice(0,2000)); process.exit(1)
' "$TMP/resp.json")
curl -s -o "$OUT" "$IMG"
ls -l "$OUT"
