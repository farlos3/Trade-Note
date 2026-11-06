#!/usr/bin/env python3
"""
Regression tests for the two sync bugs found on 2026-11-06, against a fake bridge
file -- no terminal, no database, no network.

  1. A stale tick clock produced an offset 12h52m wrong (gmt_offset -39120 instead
     of 7200) and one sync filed 23 trades 46,320 s late.
  2. A position opened before the sliding window and closed inside it was pushed as
     a lone exit deal, which the importer stored as an open trade with zero P&L.

Run: python3 mt5-sync/test_sync_guards.py
"""
import datetime as dt
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mt5_sync as m  # noqa: E402

failures = 0
def check(name, cond):
    global failures
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond:
        failures += 1

tmp = tempfile.mkdtemp(prefix="tn-sync-test-")
m.OFFSET_CACHE_PATH = os.path.join(tmp, "offset.json")
m.log = lambda msg: None      # keep the output to the checks

def reset_cache():
    if os.path.exists(m.OFFSET_CACHE_PATH):
        os.remove(m.OFFSET_CACHE_PATH)
    m._offset_rejections.clear()

# --- plausibility -------------------------------------------------------------
check("7200 (GMT+2) is plausible", m.plausible_offset(7200))
check("19800 (GMT+5:30) is plausible", m.plausible_offset(19800))
check("-39120 (the stale-tick reading) is not: not a quarter hour", not m.plausible_offset(-39120))
check("a value beyond 14h is not", not m.plausible_offset(15 * 3600))
check("None / strings / bools are not", not any(m.plausible_offset(v) for v in (None, "7200", True)))

# --- trusted_offset -------------------------------------------------------------
reset_cache()
check("first plausible reading is trusted", m.trusted_offset("S", 7200, "t") == 7200)
check("...and remembered on disk", json.load(open(m.OFFSET_CACHE_PATH)) == {"S": 7200})
check("the incident's reading falls back to the trusted 7200", m.trusted_offset("S", -39120, "t") == 7200)
check("a quarter-hour reading that jumps 5h is also refused", m.trusted_offset("S", 7200 + 5 * 3600, "t") == 7200)
check("a missing reading keeps the trusted value", m.trusted_offset("S", None, "t") == 7200)
check("exactly one hour (DST) is accepted", m.trusted_offset("S", 10800, "t") == 10800)
check("...and becomes the new trusted value", json.load(open(m.OFFSET_CACHE_PATH))["S"] == 10800)
check("servers are tracked separately", m.trusted_offset("Other", 0, "t") == 0 and m.trusted_offset("S", 10800, "t") == 10800)
reset_cache()
check("nothing trusted + implausible reading -> None (caller must not import)", m.trusted_offset("S", -39120, "t") is None)

# --- the bridge backend end to end -------------------------------------------
BROKER = 7200
now = int(dt.datetime(2026, 11, 6, 9, 0, tzinfo=dt.timezone.utc).timestamp())   # 16:00 BKK
def deal(ticket, utc, typ, entry, pos, price, profit=0.0):
    return {"ticket": ticket, "time": utc + BROKER, "type": typ, "entry": entry, "symbol": "XAUUSD",
            "volume": 0.01, "price": price, "position_id": pos, "commission": 0.0, "fee": 0.0,
            "swap": 0.0, "profit": profit, "comment": ""}
deals = [
    # position 1: opened 3 days ago, closed 1 hour ago -> straddles a 2-day window
    deal(1, now - 3 * 86400, 0, 0, 111, 4028.51), deal(2, now - 3600, 1, 1, 111, 4040.11, 11.60),
    # position 2: entirely inside the window
    deal(3, now - 7200, 0, 0, 222, 4045.89), deal(4, now - 600, 1, 1, 222, 4078.98, 33.09),
]
def bridge_with(gmt_offset):
    path = os.path.join(tmp, "tradenote_deals.json")
    json.dump({"account": {"login": 1, "server": "HF-Live16", "balance": 180.83, "equity": 180.83},
               "open_positions": [], "positions": [], "deals": deals, "balance_ops": [],
               "gmt_offset": gmt_offset, "exported_at": now + BROKER}, open(path, "w"))
    b = m.BridgeBackend(path); b.initialize(); return b

frm = dt.datetime.fromtimestamp(now - 2 * 86400)
to = dt.datetime.fromtimestamp(now + 2 * 86400)

reset_cache()
good = m.fetch_deals(bridge_with(7200), frm, to)
times = {d.ticket: d.time for d in good}
check("good offset: deal times are true UTC", times.get(4) == now - 600)
check("a position cut by the window comes back WHOLE (both legs)", {d.ticket for d in good} == {1, 2, 3, 4})
check("its entry leg keeps its real time, 3 days back", times.get(1) == now - 3 * 86400)

# the incident: trusted 7200 on disk, then the EA exports -39120 right after a restart
stale = m.fetch_deals(bridge_with(-39120), frm, to)
check("stale-tick offset is ignored: times are still correct, not +46,320 s",
      {d.ticket: d.time for d in stale} == times)

reset_cache()
b = bridge_with(-39120)
check("no trusted value yet + stale offset: the backend refuses", b.broker_offset() is None)
check("...history returns None, so nothing is fetched", m.fetch_deals(b, frm, to) == [])
check("...and the live feed reports why instead of streaming wrong times",
      b.live_snapshot() is None and "clock offset" in (b.last_reason or ""))

print(f"\n{'ALL PASSED' if failures == 0 else str(failures) + ' FAILED'}")
sys.exit(0 if failures == 0 else 1)
