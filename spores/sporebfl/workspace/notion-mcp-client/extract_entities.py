#!/usr/bin/env python3
import json, re
from collections import defaultdict

with open('/workspace/notion-mcp-client/crawled-pages.json') as f:
    pages = json.load(f)

def clean_content(content):
    if not content:
        return ""
    try:
        parsed = json.loads(content)
        text = parsed.get('text', '')
    except (json.JSONDecodeError, TypeError):
        text = content
    text = text.replace('\\n', '\n')
    text = text.replace('\\t', '\t')
    text = text.replace('\\"', '"')
    text = text.replace('\\\\', '\\')
    return text

flux_models = set()
products = {}
companies = set()
teams = {}
people = {}
hiring = {}
projects = {}

for i, page in enumerate(pages):
    title = page.get('title', '')
    page_id = page.get('id', '')
    content = clean_content(page.get('content', ''))
    
    for pat in [r'FLUX[\.\s]*(\d+(?:\.\d+)?(?:\s*\[[\w]+\])?)', r'Flux[\.\s]*(\d+(?:\.\d+)?(?:\s*\[[\w]+\])?)']:
        for m in re.findall(pat, title):
            flux_models.add(f"FLUX.{m.strip()}")
        for m in re.findall(pat, content):
            flux_models.add(f"FLUX.{m.strip()}")
    
    if 'VTO' in title or 'Virtual Try-On' in title:
        flux_models.add('FLUX VTO')
    if 'LoRA' in title:
        flux_models.add('FLUX LoRA')
    
    for co in ['Adobe', 'Amazon', 'Microsoft', 'Cloudflare', 'Snap']:
        if co.lower() in title.lower() or co.lower() in content[:3000].lower():
            companies.add(co)
    
    if any(ind in title.lower() for ind in ['team', 'sync', 'weekly', 'meeting']):
        if title not in teams:
            teams[title] = {'pages': [], 'members': set(), 'responsibilities': []}
        teams[title]['pages'].append(page_id)
    
    if any(word in title.lower() for word in ['hiring', 'interview', 'jd ', 'recruit']):
        hiring[title] = {'page_id': page_id, 'snippet': content[:500]}
    
    if any(word in title.lower() for word in ['tracker', 'roadmap', 'launch']):
        projects[title] = {'page_id': page_id, 'snippet': content[:500]}

for i, page in enumerate(pages):
    title = page.get('title', '')
    content = clean_content(page.get('content', ''))
    page_id = page.get('id', '')
    
    if 'FLUX.2' in title or 'Flux 2' in title:
        if 'klein' in title.lower():
            products['FLUX.2 [klein]'] = {'description': 'Smaller/efficient FLUX.2 variant', 'page_id': page_id}
        elif 'max' in title.lower():
            products['FLUX.2 [max]'] = {'description': 'Top-tier quality image generation and editing', 'page_id': page_id}
        elif 'ultra' in title.lower():
            products['FLUX.2 Ultra'] = {'description': 'Ultra quality FLUX.2 variant', 'page_id': page_id}
        else:
            products['FLUX.2'] = {'description': 'FLUX 2 image generation model', 'page_id': page_id}
    if 'FLUX.3' in title:
        products['FLUX.3'] = {'description': 'Next generation FLUX model', 'page_id': page_id}
    if 'FLUX 2.1' in title:
        products['FLUX.2.1'] = {'description': 'FLUX 2.1 model update', 'page_id': page_id}
    
    if 'org chart' in title.lower() or 'team directory' in title.lower():
        for name, role in re.findall(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*[-–:]\s*([^\n,]+)', content):
            name = name.strip()
            if len(name) > 3 and len(name.split()) >= 2 and name not in ['Black Forest', 'The Team']:
                if name not in people:
                    people[name] = {'roles': [], 'teams': set(), 'projects': set()}
                people[name]['roles'].append(role.strip())
    
    for pm in re.findall(r'@([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)', content):
        pm = pm.strip()
        if len(pm.split()) >= 2 and pm not in ['Black Forest', 'Notion Page']:
            if pm not in people:
                people[pm] = {'roles': [], 'teams': set(), 'projects': set()}
    
    for name, ctx in re.findall(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*\(([^)]+)\)', content):
        name = name.strip()
        if len(name.split()) >= 2 and name not in ['Black Forest', 'FLUX Model', 'Notion Page', 'Virtual Try', 'Use Case']:
            if name not in people:
                people[name] = {'roles': [], 'teams': set(), 'projects': set()}
            people[name]['roles'].append(ctx.strip())

print("=" * 60)
print("EXTRACTION SUMMARY")
print("=" * 60)
print(f"\nFLUX Models/Products ({len(flux_models)}):")
for m in sorted(flux_models): print(f"  {m}")
print(f"\nDetailed Products ({len(products)}):")
for n, info in sorted(products.items()): print(f"  {n}: {info.get('description','')[:80]}")
print(f"\nCompanies/Partners ({len(companies)}):")
for co in sorted(companies): print(f"  {co}")
print(f"\nTeams ({len(teams)}):")
for n, info in sorted(teams.items()): print(f"  {n}")
print(f"\nPeople ({len(people)}):")
for n, info in sorted(people.items()):
    roles = ', '.join(info['roles'][:3])
    print(f"  {n}: {roles if roles else 'unknown'}")
print(f"\nHiring ({len(hiring)}):")
for t in sorted(hiring): print(f"  {t}")
print(f"\nProjects ({len(projects)}):")
for n in sorted(projects): print(f"  {n}")

output = {
    'flux_models': sorted(flux_models),
    'products': {k: v for k, v in sorted(products.items())},
    'companies': sorted(companies),
    'teams': {k: {'pages': v['pages'], 'members': list(v['members'])} for k, v in sorted(teams.items())},
    'people': {k: {'roles': v['roles'], 'teams': list(v['teams']), 'projects': list(v['projects'])} for k, v in sorted(people.items())},
    'hiring': {k: v for k, v in sorted(hiring.items())},
    'projects': {k: v for k, v in sorted(projects.items())},
}
with open('/workspace/notion-mcp-client/extracted_entities.json', 'w') as f:
    json.dump(output, f, indent=2)
print(f"\nSaved to extracted_entities.json")
