#!/usr/bin/env python3
"""Import aspects, attributes, and edges for already-existing nodes."""
import sqlite3

OLD_DB = "/workspace/old-data/graphs/default.db"
NEW_DB = "/data/graphs/default.db"

old = sqlite3.connect(OLD_DB)
old.row_factory = sqlite3.Row
new = sqlite3.connect(NEW_DB)

existing = set(r[0] for r in new.execute("SELECT id FROM nodes").fetchall())
print(f"Existing nodes: {len(existing)}")

# Get existing aspects in new DB to avoid duplicates
existing_aspects = set()
for row in new.execute("SELECT node_id, name FROM aspects").fetchall():
    existing_aspects.add((row[0], row[1]))

imported_aspects = 0
imported_attrs = 0
imported_edges = 0
errors = []

for nid in existing:
    aspects = old.execute(
        "SELECT id, name, weight, extracted_with FROM aspects WHERE node_id = ?",
        (nid,)
    ).fetchall()
    
    aspect_id_map = {}
    
    for asp in aspects:
        key = (nid, asp['name'])
        if key in existing_aspects:
            # Get the existing aspect's ID in new DB
            row = new.execute(
                "SELECT id FROM aspects WHERE node_id = ? AND name = ?",
                (nid, asp['name'])
            ).fetchone()
            if row:
                aspect_id_map[asp['id']] = row[0]
            continue
            
        try:
            cursor = new.execute(
                "INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)",
                (nid, asp['name'], asp['weight'], asp['extracted_with'])
            )
            new_aid = cursor.lastrowid
            aspect_id_map[asp['id']] = new_aid
            imported_aspects += 1
        except Exception as e:
            errors.append(f"Aspect error node={nid}, name={asp['name']}: {e}")
            continue
        
        # Import attributes for this new aspect
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
                errors.append(f"Attr error node={nid}: {e}")
    
    # For existing aspects, also import any missing attributes
    for old_aid, new_aid in aspect_id_map.items():
        existing_attr_contents = set(
            r[0] for r in new.execute(
                "SELECT content FROM attributes WHERE aspect_id = ?", (new_aid,)
            ).fetchall()
        )
        attrs = old.execute(
            "SELECT content, weight, source, created_at, provenance, episode_id, fact_id FROM attributes WHERE aspect_id = ?",
            (old_aid,)
        ).fetchall()
        for attr in attrs:
            if attr['content'] not in existing_attr_contents:
                try:
                    new.execute(
                        "INSERT INTO attributes (aspect_id, content, weight, source, created_at, provenance, episode_id, fact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_aid, attr['content'], attr['weight'], attr['source'],
                         attr['created_at'], attr['provenance'], attr['episode_id'], attr['fact_id'])
                    )
                    imported_attrs += 1
                except Exception as e:
                    errors.append(f"Attr fill error node={nid}: {e}")

# Import edges
existing_edges = set()
for row in new.execute("SELECT source, target, type FROM edges").fetchall():
    existing_edges.add((row[0], row[1], row[2]))

edges = old.execute("SELECT source, target, type, weight, created_at, provenance FROM edges").fetchall()
for edge in edges:
    key = (edge['source'], edge['target'], edge['type'])
    if key in existing_edges:
        continue
    try:
        new.execute(
            "INSERT INTO edges (source, target, type, weight, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)",
            (edge['source'], edge['target'], edge['type'], edge['weight'],
             edge['created_at'], edge['provenance'])
        )
        imported_edges += 1
    except Exception as e:
        errors.append(f"Edge error {edge['source']}->{edge['target']}: {e}")

new.commit()

print(f"\n=== IMPORT RESULTS ===")
print(f"Aspects imported: {imported_aspects}")
print(f"Attributes imported: {imported_attrs}")
print(f"Edges imported: {imported_edges}")
print(f"Errors: {len(errors)}")
if errors:
    print("\nFirst 10 errors:")
    for e in errors[:10]:
        print(f"  {e}")

# Final counts
print(f"\nFinal DB stats:")
print(f"  Nodes: {new.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]}")
print(f"  Aspects: {new.execute('SELECT COUNT(*) FROM aspects').fetchone()[0]}")
print(f"  Attributes: {new.execute('SELECT COUNT(*) FROM attributes').fetchone()[0]}")
print(f"  Edges: {new.execute('SELECT COUNT(*) FROM edges').fetchone()[0]}")

old.close()
new.close()
