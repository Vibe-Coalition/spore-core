#!/usr/bin/env python3
"""
Wealthsimple API via ws-api + curl_cffi (Chrome impersonation to bypass Cloudflare).
Usage:
    python3 ws.py login                    # Login (triggers SMS)
    python3 ws.py otp <6-digit-code>       # Submit OTP code
    python3 ws.py accounts                 # List accounts
    python3 ws.py balances                 # Get balances
    python3 ws.py holdings                 # Get holdings
    python3 ws.py history                  # Historical value & gains
    python3 ws.py transactions [account]   # Recent transactions
"""
import json, sys, os

SESSION_FILE = "/workspace/skills/wealthsimple/scripts/ws_session.json"
EMAIL = "yam@yamlevitd.com"
PASSWORD = "DeusExMech1n42000!"

# --- Monkey-patch requests with curl_cffi BEFORE importing ws_api ---
import curl_cffi.requests as cffi_requests
import types

class CffiResponse:
    """Wrapper to make curl_cffi response look like requests.Response."""
    def __init__(self, resp):
        self._resp = resp
        self.status_code = resp.status_code
        self.text = resp.text
        self.content = resp.content
        # Merge set-cookie into headers dict properly
        self.headers = {}
        for k, v in resp.headers.items():
            if k.lower() in self.headers:
                self.headers[k.lower()] += f", {v}"
            else:
                self.headers[k.lower()] = v
        # Also keep original case
        for k, v in resp.headers.items():
            self.headers[k] = v
    def json(self):
        return self._resp.json()

_cffi_session = cffi_requests.Session(impersonate="chrome")

def _patched_request(method, url, json=None, headers=None, **kwargs):
    resp = _cffi_session.request(method, url, json=json, headers=headers or {}, **kwargs)
    return CffiResponse(resp)

# Patch the requests module that ws_api imports
import requests as _real_requests
_real_requests.request = _patched_request
_real_requests.exceptions = _real_requests.exceptions  # keep exceptions

from ws_api import WealthsimpleAPI, WSAPISession, OTPRequiredException, LoginFailedException
import re

def bootstrap_ws():
    """Create a WealthsimpleAPI with wssdi + client_id fetched via curl_cffi."""
    # Fetch login page to get wssdi cookie
    resp = _cffi_session.get("https://my.wealthsimple.com/app/login")
    wssdi = None
    for k, v in resp.headers.items():
        if 'set-cookie' in k.lower() and 'wssdi=' in v:
            match = re.search(r'wssdi=([a-f0-9-]+)', v)
            if match:
                wssdi = match.group(1)
    
    if not wssdi:
        wssdi = resp.cookies.get('wssdi')
    
    if not wssdi:
        raise Exception(f"No wssdi cookie found")
    
    # Extract client_id from app JS
    client_id = None
    for match in re.finditer(r'<script[^>]+src="([^"]*app-[a-f0-9]+\.js)"', resp.text):
        js_url = match.group(1)
        if not js_url.startswith('http'):
            js_url = 'https://my.wealthsimple.com' + js_url
        js_resp = _cffi_session.get(js_url)
        # Production clientId comes after sandbox one
        m = re.search(r'env:"production",clientId:"([a-f0-9]+)"', js_resp.text)
        if m:
            client_id = m.group(1)
            break
    
    print(f"Bootstrap: wssdi={wssdi}, client_id={client_id}")
    sess = WSAPISession(client_id=client_id, wssdi=wssdi)
    return WealthsimpleAPI(sess=sess)

# --- Session persistence ---
def save_session(session_json):
    if isinstance(session_json, str):
        data = json.loads(session_json)
    else:
        data = session_json
    with open(SESSION_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def load_session():
    if os.path.exists(SESSION_FILE):
        with open(SESSION_FILE) as f:
            return json.load(f)
    return None

def get_ws():
    session_data = load_session()
    if not session_data or 'access_token' not in session_data:
        print("❌ NOT_LOGGED_IN: No WS session found. Tell Yam to run: python3 ws.py login")
        print("Then have him send the 6-digit SMS code and run: python3 ws.py otp <code>")
        return None
    try:
        sess = WSAPISession(
            client_id=session_data.get('client_id'),
            access_token=session_data.get('access_token'),
            refresh_token=session_data.get('refresh_token'),
            session_id=session_data.get('session_id'),
            wssdi=session_data.get('wssdi'),
        )
        ws = WealthsimpleAPI(sess=sess)
        ws.check_oauth_token(persist_session_fct=lambda s: save_session(s))
        return ws
    except Exception as e:
        print(f"❌ SESSION_EXPIRED: WS session invalid ({e}). Tell Yam to re-authenticate:")
        print("  python3 /workspace/skills/wealthsimple/scripts/ws.py login")
        print("  python3 /workspace/skills/wealthsimple/scripts/ws.py otp <code>")
        return None

def cmd_login():
    ws = bootstrap_ws()
    try:
        ws.login_internal(
            username=EMAIL, password=PASSWORD,
            persist_session_fct=lambda s: save_session(s)
        )
        print("✅ Logged in!")
    except OTPRequiredException:
        save_session(json.dumps({
            "wssdi": ws.session.wssdi,
            "client_id": ws.session.client_id,
            "pending_otp": True
        }))
        print(f"📱 OTP sent! Check phone.")
        print("Run: python3 ws.py otp <6-digit-code>")
    except LoginFailedException as e:
        print(f"❌ Login failed: {e}")
    except Exception as e:
        print(f"❌ {type(e).__name__}: {e}")

def cmd_otp(code):
    session_data = load_session()
    if not session_data or not session_data.get('wssdi'):
        print("No pending login. Run: python3 ws.py login first")
        return
    sess = WSAPISession(
        client_id=session_data.get('client_id'),
        wssdi=session_data.get('wssdi')
    )
    ws = WealthsimpleAPI(sess=sess)
    try:
        ws.login_internal(
            username=EMAIL, password=PASSWORD, otp_answer=code,
            persist_session_fct=lambda s: save_session(s)
        )
        print("✅ Logged in with OTP!")
    except Exception as e:
        print(f"❌ {type(e).__name__}: {e}")

def cmd_accounts():
    ws = get_ws()
    if not ws: return
    for acc in ws.get_accounts():
        desc = acc.get('description', '?')
        num = acc.get('number', 'N/A')
        cur = acc.get('currency', 'CAD')
        nlv = acc.get('financials', {}).get('currentCombined', {}).get('netLiquidationValue', {}).get('amount', 'N/A')
        print(f"  {desc} ({num}) [{cur}] — ${nlv}")

def cmd_balances():
    ws = get_ws()
    if not ws: return
    total = 0
    for acc in ws.get_accounts():
        desc = acc.get('description', '?')
        cur = acc.get('currency', 'CAD')
        aid = acc.get('id', '')
        if 'credit-card' in aid:
            try:
                bal = ws.get_creditcard_account(aid).get('balance', {}).get('current', 0)
                print(f"  💳 {desc}: -${bal} {cur}")
            except: pass
        else:
            nlv = float(acc.get('financials', {}).get('currentCombined', {}).get('netLiquidationValue', {}).get('amount', '0'))
            total += nlv
            print(f"  📊 {desc}: ${nlv:,.2f} {cur}")
    print(f"\n  💰 Total: ${total:,.2f}")

def cmd_holdings():
    ws = get_ws()
    if not ws: return
    for acc in ws.get_accounts():
        desc = acc.get('description', '?')
        aid = acc.get('id', '')
        cur = acc.get('currency', 'CAD')
        if 'credit-card' in aid: continue
        bals = ws.get_account_balances(aid)
        cash_key = 'sec-c-usd' if cur == 'USD' else 'sec-c-cad'
        cash = float(bals.get(cash_key, 0))
        print(f"  {desc}:")
        print(f"    💵 Cash: ${cash:,.2f} {cur}")
        for sec, bal in bals.items():
            if sec in ['sec-c-cad', 'sec-c-usd']: continue
            sec_clean = sec.strip('[]')
            try:
                mdata = ws.get_security_market_data(sec_clean)
                stock = mdata.get('stock', {})
                sym = stock.get('symbol', sec)
                name = stock.get('name', '')
                label = f"{sym} ({name})" if name else sym
            except:
                label = sec
            print(f"    📈 {label}: {bal}")
        print()

def cmd_history():
    ws = get_ws()
    if not ws: return
    ids = [a['id'] for a in ws.get_accounts()]
    print("Portfolio Historical Value & Gains:")
    for hf in ws.get_identity_historical_financials(ids):
        val = float(hf['netLiquidationValueV2']['amount'])
        dep = float(hf['netDepositsV2']['amount'])
        gain = val - dep
        pct = (gain / dep * 100) if dep else 0
        print(f"  {hf['date']}: ${val:,.0f} (deposits: ${dep:,.0f}, gains: ${gain:,.0f} / {pct:+.1f}%)")

def cmd_transactions(filt=None):
    ws = get_ws()
    if not ws: return
    for acc in ws.get_accounts():
        desc = acc.get('description', '?')
        aid = acc.get('id', '')
        if filt and filt.lower() not in aid.lower() and filt.lower() not in desc.lower(): continue
        if 'credit-card' in aid: continue
        acts = ws.get_activities(aid)
        if not acts: continue
        print(f"  {desc}:")
        acts.reverse()
        for a in acts[-20:]:
            d = a.get('occurredAt', '?')[:10]
            sign = '+' if a.get('amountSign') == 'positive' else '-'
            print(f"    {d} {a.get('description','?')} {sign}${a.get('amount','?')} {a.get('currency','CAD')}")
        print()

if __name__ == "__main__":
    if len(sys.argv) < 2: print(__doc__); sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "login":     cmd_login()
    elif cmd == "otp":     cmd_otp(sys.argv[2]) if len(sys.argv) > 2 else print("Usage: ws.py otp <code>")
    elif cmd == "accounts": cmd_accounts()
    elif cmd == "balances": cmd_balances()
    elif cmd == "holdings": cmd_holdings()
    elif cmd == "history":  cmd_history()
    elif cmd == "transactions": cmd_transactions(sys.argv[2] if len(sys.argv) > 2 else None)
    else: print(f"Unknown: {cmd}")
