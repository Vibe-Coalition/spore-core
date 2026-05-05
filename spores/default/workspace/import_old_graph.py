#!/usr/bin/env python3
"""Import old Anima knowledge graph into the current instance via graph_update calls."""

import sqlite3
import json
import subprocess
import sys
import time

DB_PATH = "/workspace/old-data/graphs/default.db"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# Get all nodes
nodes = conn.execute("SELECT id, label, type, description FROM nodes").fetchall()
node_ids = {n['id'] for n in nodes}

# Get all aspects with their attributes
aspects = conn.execute("SELECT id, node_id, name, weight as importance FROM aspects").fetchall()
aspect_map = {}
for a in aspects:
    if a['node_id'] not in aspect_map:
        aspect_map[a['node_id']] = []
    attrs = conn.execute("SELECT content FROM attributes WHERE aspect_id = ?", (a['id'],)).fetchall()
    attr_list = [attr['content'] for attr in attrs]
    aspect_map[a['node_id']].append({
        "name": a['name'],
        "importance": a['importance'],
        "attributes": attr_list
    })

# Get all edges
edges = conn.execute("SELECT source, target, type FROM edges").fetchall()
edge_map = {}
for e in edges:
    if e['source'] not in edge_map:
        edge_map[e['source']] = []
    edge_map[e['source']].append({"target": e['target'], "type": e['type']})

# Skip self/system nodes - those are read-only in the current graph
skip_types = {'self', 'system'}
imported = 0
skipped = 0
errors = []

for node in nodes:
    nid = node['id']
    ntype = node['type']
    label = node['label']
    desc = node['description'] or ''
    
    if ntype in skip_types:
        print(f"SKIP (type={ntype}): {nid}")
        skipped += 1
        continue
    
    # Build aspects
    node_aspects = []
    if nid in aspect_map:
        for asp in aspect_map[nid]:
            node_aspects.append({
                "name": asp['name'],
                "importance": asp.get('importance', 5),
                "attributes": asp['attributes']
            })
    
    # Build edges
    node_edges = []
    if nid in edge_map:
        for edge in edge_map[nid]:
            # Only include edges where both nodes exist
            if edge['target'] in node_ids:
                node_edges.append({
                    "target": edge['target'],
                    "type": edge['type']
                })
    
    # Write a JSON file for this node that we'll import via a shell script
    entry = {
        "nodeId": nid,
        "label": label,
        "type": ntype,
        "description": desc,
    }
    if node_aspects:
        entry["aspects"] = node_aspects
    if node_edges:
        entry["edges"] = node_edges
    
    # Write to a file for batch processing
    with open(f"/workspace/import_nodes/{nid}.json", "w") as f:
        json.dump(entry, f, indent=2)
    
    imported += 1

print(f"\nExported {imported} nodes to /workspace/import_nodes/ ({skipped} skipped)")
print(f"Total aspects: {sum(len(v) for v in aspect_map.values())}")
print(f"Total edges: {sum(len(v) for v in edge_map.values())}")

conn.close()
