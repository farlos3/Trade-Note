#!/usr/bin/env python3
"""
Regression tests for the sync bugs found on 2026-11-06 and 2026-11-07, against a
fake bridge file and a fake MetaTrader5 module -- no terminal, no database, no network.

  1. A stale tick clock produced an offset 12h52m wrong (gmt_offset -39120 instead
     of 7200) and one sync filed 23 trades 46,320 s late.
  2. A position opened before the sliding window and closed inside it was pushed as
     a lone exit deal, which the importer stored as an open trade with zero P&L.
  3. The terminal was started on a Saturday, logged into a server with nothing on
     file. The newest tick was Friday's, so the "offset" read -49,500 -- a plausible
     quarter hour -- and was trusted, shifting every deal pushed by 15h45m.

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

# --- the native backend, with quotes stopped (the 2026-11-07 incident) ---------------
import time  # noqa: E402
from types import SimpleNamespace  # noqa: E402

class FakeMt5:
    """Just the three calls broker_offset() makes. `tick_time` returns the broker-clock
    time of the newest tick; a frozen one is a market that is shut."""
    def __init__(self, tick_time, server="HF-Live16"):
        self.tick_time, self.server, self.tick_calls = tick_time, server, 0
    def account_info(self): return SimpleNamespace(server=self.server)
    def symbols_get(self): return [SimpleNamespace(name="XAUUSD", select=True)]
    def symbol_info_tick(self, name):
        self.tick_calls += 1
        return SimpleNamespace(time=self.tick_time())

def native(tick_time):
    m.mt5 = FakeMt5(tick_time)
    return m.NativeBackend()

real_mt5, m.LIVE_PROBE_SECONDS = m.mt5, 1.2
t0 = int(time.time())
live = lambda: int(time.time()) + 7200                  # ticking: broker clock = UTC+2
# A shut market is a FIXED last tick, so it must not move between calls. Each is
# the reading it produces at the moment the sync asks (age = seconds since the tick):
frozen_saturday = lambda: t0 + 7200 - 56700             # the incident: reads -49,500
frozen_1h = lambda: t0 + 7200 - 3600                    # the daily break's last minutes: reads +3,600

reset_cache()
check("market open, nothing on file: the live reading is trusted", native(live).broker_offset() == 7200)
check("...and remembered", json.load(open(m.OFFSET_CACHE_PATH)) == {"HF-Live16": 7200})

reset_cache()
check("the incident's reading (-49,500) is a plausible quarter hour...", m.plausible_offset(-49500))
check("...yet with the market shut and nothing on file: no offset, the caller skips instead of importing",
      native(frozen_saturday).broker_offset() is None)
check("...and nothing was written for the stale reading", not os.path.exists(m.OFFSET_CACHE_PATH))

reset_cache(); json.dump({"HF-Live16": 7200}, open(m.OFFSET_CACHE_PATH, "w"))
check("market shut, 7200 on file: keeps 7200", native(frozen_saturday).broker_offset() == 7200)
check("an hour of staleness is not mistaken for a DST switch",
      native(frozen_1h).broker_offset() == 7200 and json.load(open(m.OFFSET_CACHE_PATH)) == {"HF-Live16": 7200})

reset_cache(); json.dump({"HF-Live16": 3600}, open(m.OFFSET_CACHE_PATH, "w"))
check("a real DST switch (reading differs by 1h, quotes live) is still accepted",
      native(live).broker_offset() == 7200)

reset_cache(); json.dump({"HF-Live16": 7200}, open(m.OFFSET_CACHE_PATH, "w"))
b = native(lambda: int(time.time()) + 7200)
check("a reading equal to the trusted one needs no liveness probe (one tick read)",
      b.broker_offset() == 7200 and m.mt5.tick_calls == 1)
m.mt5 = real_mt5


# --- catch-up window after the machine was off ----------------------------------------
NOW = dt.datetime(2026, 11, 8, 12, 0)
ago = lambda **kw: int((NOW - dt.timedelta(**kw)).timestamp())
base = NOW - dt.timedelta(days=7)
check("TradeNote is current: the plain 7-day window",
      m.catchup_from(NOW, 7, ago(hours=1), 90) == base)
check("a 3-day gap fits inside the window: unchanged", m.catchup_from(NOW, 7, ago(days=3), 90) == base)
check("off for 20 days: starts a day before TradeNote's newest trade",
      m.catchup_from(NOW, 7, ago(days=20), 90) == NOW - dt.timedelta(days=21))
check("off for a year: capped at 90 days, not the whole history",
      m.catchup_from(NOW, 7, ago(days=365), 90) == NOW - dt.timedelta(days=90))
check("nothing stored for the account yet: the cap", m.catchup_from(NOW, 7, None, 90) == NOW - dt.timedelta(days=90))
check("cap no larger than the base window: base window", m.catchup_from(NOW, 7, ago(days=20), 5) == base)
check("a window from 5 Nov back to 20 Oct crosses the EU switch (25 Oct)",
      m.crosses_dst_switch(dt.datetime(2026, 10, 20), dt.datetime(2026, 11, 5)))
check("a window wholly after the switches does not",
      not m.crosses_dst_switch(dt.datetime(2026, 11, 3), dt.datetime(2026, 11, 8)))


# --- offsets in the past (broker DST) ---------------------------------------------
def utc(y, mo, d, h=12):
    return int(dt.datetime(y, mo, d, h, tzinfo=dt.timezone.utc).timestamp())
check("EU switch 2026 is Sun 25 Oct, US switch Sun 1 Nov",
      m._last_sunday(2026, 10) == dt.date(2026, 10, 25) and m._nth_sunday(2026, 11, 1) == dt.date(2026, 11, 1))
check("EU summer time: in force on 24 Oct, over on 26 Oct", m.eu_dst_active(utc(2026, 10, 24)) and not m.eu_dst_active(utc(2026, 10, 26)))
check("US DST: still in force on 30 Oct, over on 2 Nov", m.us_dst_active(utc(2026, 10, 30)) and not m.us_dst_active(utc(2026, 11, 2)))
now_nov = utc(2026, 11, 6)
m.BROKER_DST = "eu"
check("eu: an October deal gets +3h although today's offset is +2h",
      m.offset_at(utc(2026, 10, 7) + 7200, 7200, now=now_nov) == 10800)
check("eu: a deal after the switch keeps +2h", m.offset_at(utc(2026, 10, 29) + 7200, 7200, now=now_nov) == 7200)
check("eu: in summer, a winter deal gets one hour LESS", m.offset_at(utc(2026, 2, 10) + 10800, 10800, now=utc(2026, 7, 1)) == 7200)
m.BROKER_DST = "none"
check("none: every deal keeps today's offset (the old behaviour)", m.offset_at(utc(2026, 10, 7), 7200, now=now_nov) == 7200)
check("an untrusted offset stays None whatever the rule", m.offset_at(utc(2026, 10, 7), None) is None)

print(f"\n{'ALL PASSED' if failures == 0 else str(failures) + ' FAILED'}")
sys.exit(0 if failures == 0 else 1)
