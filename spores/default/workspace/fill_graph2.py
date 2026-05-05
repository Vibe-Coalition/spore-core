#!/usr/bin/env python3
"""Import aspects, attributes, and edges for already-existing nodes."""
import sqlite3

OLD = sqlite3.connect("/workspace/old-data/graphs/default.db")
OLD.row_factory = sqlite3.Row
NEW = sqlite3.connect("/data/graphs/default.db")

existing_nodes = set(r[0] for r in NEW.execute("SELECT id FROM nodes").fetchall())

# Get existing aspects in new DB
existing_aspects = set()
for row in NEW.execute("SELECT node_id, name FROM aspects").fetchall():
    existing_aspects.add((row[0], row[1]))

imp_asp = imp_attr = imp_edge = 0
errors = []

for nid in existing_nodes:
    aspects = OLD.execute("SELECT id, name, weight, extracted_with FROM aspects WHERE node_id = ?", (nid,)).fetchall()
    aid_map = {}
    
    for asp in aspects:
        key = (nid, asp['name'])
        if key in existing_aspects:
            row = NEW.execute("SELECT id FROM aspects WHERE node_id = ? AND name = ?", (nid, asp['name'])).fetchone()
            if row: aid_map[asp['id']] = row[0]
            continue
        try:
            cur = NEW.execute("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)",
                              (nid, asp['name'], asp['weight'], asp['extracted_with']))
            aid_map[asp['id']] = cur.lastrowid
            imp_asp += 1
        except Exception as e:
            errors.append(f"Asp {nid}/{asp['name']}: {e}")
            continue

    # Import attributes for all mapped aspects
    for old_aid, new_aid in aid_map.items():
        existing_contents = set(r[0] for r in NEW.execute("SELECT content FROM attributes WHERE aspect_id = ?", (new_aid,)).fetchall())
        attrs = OLD.execute("SELECT content, importance, source, created, extracted_with, event_date, document_date, source_excerpt FROM attributes WHERE aspect_id = ?", (old_aid,)).fetchall()
        for a in attrs:
            if a['content'] in existing_contents:
                continue
            try:
                NEW.execute("INSERT INTO attributes (aspect_id, content, importance, source, created, extracted_with, event_date, document_date, source_excerpt) VALUES (?,?,?,?,?,?,?,?,?)",
                            (new_aid, a['content'], a['importance'], a['source'], a['created'], a['extracted_with'], a['event_date'], a['document_date'], a['source_excerpt']))
                imp_attr += 1
            except Exception as e:
                errors.append(f"Attr {nid}: {e}")

# Import edges
existing_edges = set((r[0], r[1], r[2]) for r in NEW.execute("SELECT source, target, type FROM edges").fetchall())
for e in OLD.execute("SELECT source, target, type, weight, created, extracted_with FROM edges").fetchall():
    if (e['source'], e['target'], e['type']) in existing_edges:
        continue
    try:
        NEW.execute("INSERT INTO edges (source, target, type, weight, created, extracted_with) VALUES (?,?,?,?,?,?)",
                    (e['source'], e['target'], e['type'], e['weight'], e['created'], e['extracted_with']))
        imp_edge += 1
    except Exception as ex:
        errors.append(f"Edge: {ex}")

NEW.commit()
print(f"Aspects: {imp_asp}, Attributes: {imp_attr}, Edges: {imp_edge}")
print(f"Errors: {len(errors)}")
for e in errors[:5]: print(f"  {e}")
print(f"\nFinal: nodes={NEW.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]}, aspects={NEW.execute('SELECT COUNT(*) FROM aspects').fetchone()[0]}, attrs={NEW.execute('SELECT COUNT(*) FROM attributes').fetchone()[0]}, edges={NEW.execute('SELECT COUNT(*) FROM edges').fetchone()[0]}")
OLD.close(); NEW.close()
