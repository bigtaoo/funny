#!/usr/bin/env bash
# usage: generate_image.sh <output file> <prompt file>
# Text-to-image: start a conversation with the image agent and download the signed URL from tool.execution
set -euo pipefail
source "$(dirname "$0")/mistral_failover.sh"
OUT="$1"; PROMPT_FILE="$2"
# MISTRAL_KEY=A|B|C picks the workspace; each workspace has its own agent
case "${MISTRAL_KEY:-B}" in
  C) CONF="$HOME/.vibe/mistral_curl_keyC.conf"; AGENT="ag_01a0f2bc01d4739880edc0be391ad765" ;;
  A) CONF="$HOME/.vibe/mistral_curl_keyA.conf"; AGENT="ag_01a0f2153a017375ae140eab15522710" ;;
  B) CONF="$HOME/.vibe/mistral_curl_keyB.conf"; AGENT="ag_01a0f2702e31768a9bde515228083588" ;;
  *) echo "MISTRAL_KEY must be A, B or C" >&2; exit 2 ;;
esac
TMP="${TMPDIR:-/tmp}/mistral_gen_$$"; mkdir -p "$TMP"

node -e '
const fs=require("fs");
const [pf,agent,out]=process.argv.slice(1);
const p=fs.readFileSync(pf,"utf8");
fs.writeFileSync(out, JSON.stringify({agent_id:agent, inputs:`Call the image_generation tool function generate_image with this exact prompt:\n${p}`}));
' "$PROMPT_FILE" "$AGENT" "$TMP/req.json"

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
