#!/usr/bin/env python3
import subprocess, sys
result = subprocess.run(["/workspace/.venv/bin/python3", "/workspace/skills/amazon/scripts/amazon.py"] + sys.argv[1:], capture_output=True, text=True)
print(result.stdout)
if result.stderr:
    print(result.stderr, file=sys.stderr)
sys.exit(result.returncode)