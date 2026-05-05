#!/bin/bash
# Vision tool - Gemini API image analysis
IMAGE_PATH="$1"
PROMPT="${2:-Describe this image in detail.}"
[ -z "$IMAGE_PATH" ] || [ ! -f "$IMAGE_PATH" ] && echo "Usage: vision.sh <image_path> [prompt]" && exit 1
export $(grep GEMINI_API_KEY /workspace/.env | xargs)
[ -z "$GEMINI_API_KEY" ] && echo "Error: GEMINI_API_KEY not set" && exit 1
python3 -c "
import requests, base64, os, json, sys
api_key = os.environ['GEMINI_API_KEY']
with open('$IMAGE_PATH', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()
mime = 'image/png' if '$IMAGE_PATH'.endswith('.png') else 'image/jpeg'
resp = requests.post(
    f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}',
    json={'contents':[{'parts':[{'text':sys.argv[1]},{'inline_data':{'mime_type':mime,'data':b64}}]}]}
)
data = resp.json()
if 'candidates' in data and data['candidates']:
    for p in data['candidates'][0].get('content',{}).get('parts',[]):
        if 'text' in p: print(p['text'])
else: print(json.dumps(data)[:300])
" "$PROMPT"