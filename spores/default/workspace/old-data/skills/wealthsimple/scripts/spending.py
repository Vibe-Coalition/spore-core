#!/usr/bin/env python3
"""
Wealthsimple Credit Card Spending Analyzer.
Pulls transactions and categorizes spending.

Usage:
  spending.py                  # Full analysis
  spending.py --period 30      # Last N days only
  spending.py --json           # JSON output for programmatic use
"""
import sys
import os
import json
import re
from datetime import datetime, timedelta
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ws import get_ws

# ── Merchant category mapping ──
CATEGORY_MAP = {
    # Groceries
    r"save on foods|thrifty foods|safeway|superstore|no frills|costco|persia foods|whole foods|t&t": "🛒 Groceries",
    # Restaurants / Takeout
    r"mama said pizza|ramen butcher|jerusalem grill|kook's cooks|hard bean|sabor a mexico|a&w|jj bean|port moody.*sq|pizza|shawar|grill|restaurant|resto|burrito|sushi|thai|chicken|burger|taco|pho|noodle|wok|curry|kitchen|diner|cafe|bakery|brunch|starbucks|little beans play cafe|ubereats|uber.*eats": "🍽️ Restaurants & Takeout",
    # Uber rides
    r"uber.*trip|ubertrip": "🚗 Uber Rides",
    # Amazon
    r"amzn mktp|amazon\.ca": "📦 Amazon",
    # Convenience / Gas
    r"7-eleven|chevron|shell|petro|esso|circle k|gas|blundell chev": "⛽ Convenience & Gas",
    # Home Improvement
    r"rona|home depot|lowes|canadian tire|home hardware|heritage home": "🔨 Home Improvement",
    # Vape / Smoke
    r"alpha vapes|vape|westwood mixer|smoke": "🚬 Vape & Tobacco",
    # Subscriptions / Phone
    r"amazon\.ca prime|netflix|spotify|disney|apple\.com|google|youtube|fido": "📱 Subscriptions & Phone",
    # Plumbing / Services
    r"plumber|electrician|contractor|handyman|hvac": "🔧 Home Services",
    # Bills (kept separate from spending)
    r"icbc|hydro|fortis|telus|shaw": "🏦 Bills",
    # Parking
    r"indigo park|impark|easypark": "🅿️ Parking",
    # Kids / Education
    r"butterfly learn|little beans|glow play|toys|learn": "👶 Kids & Education",
    # Coffee
    r"gallagher.*coffee|starbucks|tim horton|jj bean|blenz": "☕ Coffee",
    # Alcohol
    r"jak's|wine|beer|spirit|liquor|bc liquor": "🍷 Alcohol",
    # Grocery (more)
    r"marketplace iga|iga|olive the best": "🛒 Groceries",
    # Shopping / Clothing
    r"oldnavy|old navy|gap|h&m|zara|winners|marshalls|dollars.*cents": "🛍️ Shopping & Clothing",
    # Other
    r"habitat|sp ": "🏷️ Other",
}


def categorize(merchant):
    merchant_lower = merchant.lower()
    for pattern, category in CATEGORY_MAP.items():
        if re.search(pattern, merchant_lower):
            return category
    return "❓ Uncategorized"


def get_transactions():
    ws = get_ws()
    if not ws:
        print("Not authenticated", file=sys.stderr)
        sys.exit(1)
    
    # Spending accounts: credit card + Moriyam debit
    SPENDING_ACCOUNTS = ['credit-card', 'moriyam']
    # Skip these transaction types (internal transfers, not spending)
    SKIP_PATTERNS = [
        'credit card payment', 'money transfer', 'withdrawal: eft',
        'deposit: eft', 'deposit: interac', 'pre-authorized debit: to icbc',
        'pre-authorized debit: to b.c. hydro', 'interest',
    ]
    
    txns = []
    for acc in ws.get_accounts():
        aid = acc.get('id', '')
        desc_acc = acc.get('description', '')
        
        # Check if this is a spending account
        is_spending = any(s in aid.lower() or s in desc_acc.lower() for s in SPENDING_ACCOUNTS)
        if not is_spending:
            continue
        
        source = "💳 Credit Card" if 'credit-card' in aid else "🏠 Moriyam Debit"
        acts = ws.get_activities(aid)
        
        for a in acts:
            if a.get('amountSign') != 'negative':
                continue  # Skip payments/credits/deposits
            
            raw_desc = a.get('description', '')
            
            # Skip internal transfers and bills that aren't "spending"
            if any(skip in raw_desc.lower() for skip in SKIP_PATTERNS):
                continue
            
            # Clean up merchant name
            desc = raw_desc.replace('Credit card purchase: ', '').replace('Debit purchase: ', '')
            merchant = a.get('spendMerchant', '') or desc
            
            # Handle negative negative amounts (WS quirk on debit)
            amount = float(a.get('amount', 0))
            if amount < 0:
                amount = abs(amount)
            
            txns.append({
                "date": a.get('occurredAt', '')[:10],
                "amount": amount,
                "merchant": merchant,
                "category": categorize(merchant),
                "source": source,
                "raw_description": raw_desc,
            })
    
    return sorted(txns, key=lambda x: x['date'], reverse=True)


def analyze(txns, days=None):
    if days:
        cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        txns = [t for t in txns if t['date'] >= cutoff]
    
    if not txns:
        return {"error": "No transactions found", "transactions": []}
    
    total = sum(t['amount'] for t in txns)
    
    # By category
    by_cat = defaultdict(lambda: {"total": 0, "count": 0, "transactions": []})
    for t in txns:
        cat = t['category']
        by_cat[cat]['total'] += t['amount']
        by_cat[cat]['count'] += 1
        by_cat[cat]['transactions'].append(t)
    
    # Sort categories by spend
    sorted_cats = sorted(by_cat.items(), key=lambda x: x[1]['total'], reverse=True)
    
    # By merchant (top spenders)
    by_merchant = defaultdict(lambda: {"total": 0, "count": 0})
    for t in txns:
        by_merchant[t['merchant']]['total'] += t['amount']
        by_merchant[t['merchant']]['count'] += 1
    
    top_merchants = sorted(by_merchant.items(), key=lambda x: x[1]['total'], reverse=True)[:10]
    
    # Date range
    dates = [t['date'] for t in txns]
    
    return {
        "period": f"{min(dates)} to {max(dates)}",
        "days": days,
        "total_spend": round(total, 2),
        "transaction_count": len(txns),
        "categories": [
            {
                "name": cat,
                "total": round(data['total'], 2),
                "count": data['count'],
                "pct": round(data['total'] / total * 100, 1),
            }
            for cat, data in sorted_cats
        ],
        "top_merchants": [
            {
                "name": name,
                "total": round(data['total'], 2),
                "count": data['count'],
            }
            for name, data in top_merchants
        ],
        "transactions": txns,
    }


def print_report(result):
    print(f"💳 Spending Report ({result['period']})")
    print(f"{'─' * 45}")
    print(f"Total: ${result['total_spend']:,.2f} ({result['transaction_count']} transactions)")
    print()
    
    print("📊 By Category:")
    for cat in result['categories']:
        bar = "█" * int(cat['pct'] / 3)
        print(f"  {cat['name']}: ${cat['total']:,.2f} ({cat['count']}x) {cat['pct']}% {bar}")
    print()
    
    print("🏪 Top Merchants:")
    for m in result['top_merchants']:
        print(f"  ${m['total']:,.2f} ({m['count']}x) — {m['name']}")
    print()
    
    # Recent transactions
    print("📋 Recent Transactions:")
    for t in result['transactions'][:15]:
        print(f"  {t['date']}  ${t['amount']:>8.2f}  {t['merchant'][:40]}")


if __name__ == "__main__":
    days = None
    as_json = False
    
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--json":
            as_json = True
        elif arg == "--period" and i < len(sys.argv) - 1:
            days = int(sys.argv[i + 1])
        elif sys.argv[i - 1] == "--period":
            continue  # skip the number after --period
    
    txns = get_transactions()
    result = analyze(txns, days=days)
    
    if as_json:
        # Don't include full transactions in JSON to keep it small
        out = {k: v for k, v in result.items() if k != 'transactions'}
        out['recent_transactions'] = result['transactions'][:10]
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print_report(result)
