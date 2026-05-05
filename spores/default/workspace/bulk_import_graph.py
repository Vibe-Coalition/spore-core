#!/usr/bin/env python3
"""Bulk import nodes from old graph DB into current graph DB."""
import sqlite3
import json
import os

OLD_DB = "/workspace/old-data/graphs/default.db"
NEW_DB = "/data/graphs/default.db"

old = sqlite3.connect(OLD_DB)
old.row_factory = sqlite3.Row
new = sqlite3.connect(NEW_DB)

# Get existing node IDs in new DB
existing = set(r[0] for r in new.execute("SELECT id FROM nodes").fetchall())
print(f"Existing nodes in new DB: {len(existing)}")

# Get all nodes from old DB (skip self/system types)
old_nodes = old.execute(
    "SELECT id, label, type, description FROM nodes WHERE type NOT IN ('self', 'system')"
).fetchall()
print(f"Nodes to import: {len(old_nodes)}")

imported_nodes = 0
imported_aspects = 0
imported_attrs = 0
imported_edges = 0
skipped = 0
errors = []

for node in old_nodes:
    nid = node['id']
    if nid in existing:
        skipped += 1
        continue
    
    try:
        # Insert node
        new.execute(
            "INSERT INTO nodes (id, label, type, description) VALUES (?, ?, ?, ?)",
            (nid, node['label'], node['type'], node['description'])
        )
        imported_nodes += 1
        
        # Get aspects for this node
        aspects = old.execute(
            "SELECT id, name, weight, extracted_with FROM aspects WHERE node_id = ?",
            (nid,)
        ).fetchall()
        
        aspect_id_map = {}  # old aspect id -> new aspect id
        
        for asp in aspects:
            cursor = new.execute(
                "INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)",
                (nid, asp['name'], asp['weight'], asp['extracted_with'])
            )
            new_aid = cursor.lastrowid
            aspect_id_map[asp['id']] = new_aid
            imported_aspects += 1
            
            # Get attributes for this aspect
            attrs = old.execute(
                "SELECT content, weight, source, created_at, provenance, episode_id, fact_id FROM attributes WHERE aspect_id = ?",
                (asp['id'],)
            ).fetchall()
            
            for attr in attrs:
                try:
                    new.execute(
                        "INSERT INTO attributes (aspect_id, content, weight, source, created_at, provenance, episode_id, fact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_aid, attr['content'], attr['weight'], attr['source'], 
                         attr['created_at'], attr['provenance'], attr['episode_id'], attr['fact_id'])
                    )
                    imported_attrs += 1
                except Exception as e:
                    errors.append(f"Attr error for node={nid}, aspect={asp['name']}: {e}")
        
        # Get edges FROM this node
        edges = old.execute(
            "SELECT source, target, type, weight, created_at, provenance FROM edges WHERE source = ?",
            (nid,)
        ).fetchall()
        
        for edge in edges:
            try:
                new.execute(
                    "INSERT INTO edges (source, target, type, weight, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)",
                    (edge['source'], edge['target'], edge['type'], edge['weight'], 
                     edge['created_at'], edge['provenance'])
                )
                imported_edges += 1
            except Exception as e:
                errors.append(f"Edge error {nid}->{edge['target']}: {e}")
        
    except Exception as e:
        errors.append(f"Node error {nid}: {e}")

new.commit()

# Also import aliases
aliases = old.execute("SELECT node_id, alias FROM aliases").fetchall()
imported_aliases = 0
for a in aliases:
    if a['node_id'] not in existing:
        try:
            new.execute("INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)", 
                       (a['node_id'], a['alias']))
            imported_aliases += 1
        except:
            pass
new.commit()

# Also import episodes (different schema)
try:
    episodes = old.execute("SELECT id, session_id, turn_idx, content, observed_at, embedding, created FROM episodes").fetchall()
    imported_episodes = 0
    for ep in episodes:
        try:
            new.execute(
                "INSERT OR IGNORE INTO episodes (id, session_id, turn_idx, content, observed_at, embedding, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ep['id'], ep['session_id'], ep['turn_idx'], ep['content'], ep['observed_at'], ep['embedding'], ep['created'])
            )
            imported_episodes += 1
        except Exception as e:
            errors.append(f"Episode error {ep['id']}: {e}")
    new.commit()
except Exception as e:
    print(f"Episodes import skipped: {e}")
    imported_episodes = 0

print(f"\n=== IMPORT RESULTS ===")
print(f"Nodes imported: {imported_nodes}")
print(f"Nodes skipped (already exist): {skipped}")
print(f"Aspects imported: {imported_aspects}")
print(f"Attributes imported: {imported_attrs}")
print(f"Edges imported: {imported_edges}")
print(f"Aliases imported: {imported_aliases}")
print(f"Episodes imported: {imported_episodes}")
print(f"Errors: {len(errors)}")
if errors:
    print("\nFirst 10 errors:")
    for e in errors[:10]:
        print(f"  {e}")

# Verify
final_count = new.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
print(f"\nTotal nodes in new DB: {final_count}")

old.close()
new.close()
