#!/bin/bash
BFL_KEY=$(cat /tmp/.env-ANIMA_PROVIDER_BFL_KEY-1776354754794)
MODELS="glm-5.1-fp8 Qwen3.5-397B-A17B-FP8 qwen3-vl-235b-a22b-instruct qwen3-vl-30b-a3b-instruct qwen3-30b-a3b pixtral-12b llama3-1-70b-quantized"

for m in $MODELS; do
  echo -n "$m: "
  resp=$(curl -s --max-time 30 https://review-3398.us3.bfl.ai/v1/llm/chat/completions \
    -H "x-key: $BFL_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in 5 words\"}],\"max_tokens\":20}" 2>&1)
  if echo "$resp" | grep -q '"content"'; then
    content=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'][:80])" 2>/dev/null)
    echo "ONLINE - $content"
  else
    err=$(echo "$resp" | head -c 200)
    echo "OFFLINE - $err"
  fi
done
