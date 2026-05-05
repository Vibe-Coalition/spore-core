#!/usr/bin/env python3
"""Wealthsimple skill wrapper for Anima."""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Delegate to the main script
from scripts.ws import main
if __name__ == "__main__":
    main()