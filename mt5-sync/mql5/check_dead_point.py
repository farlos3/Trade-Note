#!/usr/bin/env python3
"""
Independent check of the two closed-form prices in TradeNoteBreakEven.mq5.

The indicator solves a straight line analytically (no search). This file does NOT
reuse that algebra: it simulates the account the way the terminal values it -- longs
close at the bid, shorts at the ask, swap included -- and finds the price by
bisection. If the closed form and the simulation agree across long, short, mixed
and hedged baskets, the derivation is right.

MQL5 itself cannot be compiled or run from here (MetaEditor's /compile does not work
under the Wine build MT5 for Mac ships), so this checks the MATH, not the syntax.
It mirrors the formulas by hand: if you change them in the .mq5, change them here.

Run: python3 mt5-sync/mql5/check_dead_point.py
"""
import sys

failures = 0
def check(name, cond):
    global failures
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond: failures += 1

class Pos:
    def __init__(self, side, vol, open_, swap=0.0, commission=0.0):
        self.side, self.vol, self.open, self.swap, self.commission = side, vol, open_, swap, commission

VPP = 100.0   # account currency per lot per whole unit of price (gold, 100 oz)

def floating(positions, bid, spread):
    """What the terminal would show as open P&L at this bid, swap included."""
    total = 0.0
    for p in positions:
        if p.side == 'buy':  total += (bid - p.open) * p.vol * VPP + p.swap
        else:                total += (p.open - (bid + spread)) * p.vol * VPP + p.swap
    return total

def equity_at(balance, positions, bid, spread):
    return balance + floating(positions, bid, spread)

# ---- the closed forms, exactly as written in the indicator --------------------
def break_even(positions, bid, spread, exit_cost_per_lot=0.0):
    k = net = costs = 0.0
    for p in positions:
        cost = p.swap + p.commission - exit_cost_per_lot * p.vol
        if p.side == 'buy': net += p.vol; k -= p.vol * p.open
        else:               net -= p.vol; k += p.vol * (p.open - spread)
        costs += cost
    if abs(net) < 0.005: return None
    return -(k + costs / VPP) / net

def dead_point(equity, margin, so_level, percent, positions, bid):
    so_eq = margin * so_level / 100.0 if percent else margin + so_level
    room = equity - so_eq
    net = sum(p.vol if p.side == 'buy' else -p.vol for p in positions)
    if margin <= 0: return ('no-margin', None)
    if room <= 0:   return ('reached', None)
    if abs(net) < 0.005: return ('flat', None)
    return ('ok', bid - room / (VPP * net))

def bisect(f, lo, hi, n=200):
    flo, fhi = f(lo), f(hi)
    if flo * fhi > 0: return None
    for _ in range(n):
        mid = (lo + hi) / 2; fm = f(mid)
        if flo * fm <= 0: hi = mid
        else: lo, flo = mid, fm
    return (lo + hi) / 2

SPREAD = 0.20
BID = 4100.00
cases = {
    'net long, in drawdown':      [Pos('buy', 0.10, 4120.0, swap=-0.4)],
    'net short, in drawdown':     [Pos('sell', 0.10, 4080.0, swap=-0.3)],
    'long averaged down':         [Pos('buy', 0.05, 4130.0), Pos('buy', 0.07, 4110.0, swap=-0.2)],
    'long with a short hedge':    [Pos('buy', 0.10, 4125.0), Pos('sell', 0.04, 4105.0)],
    'short with a long recovery': [Pos('sell', 0.08, 4090.0), Pos('buy', 0.03, 4098.0, swap=-0.1)],
}

print("--- break-even: closed form vs simulation ---")
for name, ps in cases.items():
    be = break_even(ps, BID, SPREAD)
    sim = bisect(lambda b: floating(ps, b, SPREAD), 3000, 5200)
    # The indicator's floating also deducts entry commission; none here, so compare directly.
    check(f"{name}: break-even {be:.4f} == simulated {sim:.4f}", be is not None and abs(be - sim) < 1e-6)

print("--- dead point: closed form vs simulation ---")
# Each basket is funded so that equity sits comfortably ABOVE the stop-out level
# today (150 against a 40 / 110 threshold). A basket already past stop-out has no
# price to find, and an earlier version of this test used baskets like that and so
# compared almost nothing -- every case fell into the 'reached' branch.
EQUITY_NOW = 150.0
margin = 80.0
compared = 0
for name, ps in cases.items():
    balance = EQUITY_NOW - floating(ps, BID, SPREAD)
    eq = equity_at(balance, ps, BID, SPREAD)
    for percent, so in ((True, 50.0), (False, 30.0)):
        state, price = dead_point(eq, margin, so, percent, ps, BID)
        so_eq = margin * so / 100.0 if percent else margin + so
        sim = bisect(lambda b: equity_at(balance, ps, b, SPREAD) - so_eq, 2500, 5600)
        label = f"{name} [{'percent' if percent else 'money'} {so:g}]"
        ok = state == 'ok' and sim is not None and abs(price - sim) < 1e-6
        if ok: compared += 1
        check(f"{label}: dead {price if price is None else round(price, 4)} == simulated {sim if sim is None else round(sim, 4)}", ok)
check(f"every basket was actually compared ({compared} of {len(cases) * 2})", compared == len(cases) * 2)
balance = 160.0

print("--- direction ---")
long_ps = [Pos('buy', 0.10, 4100.0)]
short_ps = [Pos('sell', 0.10, 4100.0)]
_, dl = dead_point(equity_at(balance, long_ps, BID, SPREAD), 80.0, 50.0, True, long_ps, BID)
_, ds = dead_point(equity_at(balance, short_ps, BID, SPREAD), 80.0, 50.0, True, short_ps, BID)
check(f"net long: dead point {dl:.2f} is BELOW the market {BID}", dl < BID)
check(f"net short: dead point {ds:.2f} is ABOVE the market {BID}", ds > BID)

print("--- the cases that must not invent a price ---")
flat = [Pos('buy', 0.10, 4120.0), Pos('sell', 0.10, 4090.0)]
eq_flat = 150.0     # a locked hedge, funded so that it is above stop-out
check("hedged flat: no dead point", dead_point(eq_flat, 80.0, 50.0, True, flat, BID)[0] == 'flat')
check("hedged flat: equity really is the same at every price",
      abs(equity_at(balance, flat, 3000, SPREAD) - equity_at(balance, flat, 5000, SPREAD)) < 1e-9)
check("hedged flat but already below stop-out is 'reached', not 'flat' (room is tested first)",
      dead_point(30.0, 80.0, 50.0, True, flat, BID)[0] == 'reached')
check("hedged flat: no break-even either", break_even(flat, BID, SPREAD) is None)
check("equity already below stop-out: reported as reached, not a price",
      dead_point(30.0, 80.0, 50.0, True, long_ps, BID)[0] == 'reached')
check("no margin in use: n/a", dead_point(160.0, 0.0, 50.0, True, long_ps, BID)[0] == 'no-margin')

print("--- sanity on a worked example ---")
# 0.10 lot long from 4100, balance 160, margin 80, stop-out 50% -> fires at equity 40,
# i.e. a 120 loss at 10 per unit of price = 12 units below the (zero-profit) market.
st, pr = dead_point(160.0, 80.0, 50.0, True, long_ps, 4100.0)
check(f"worked example: dead {pr:.2f} == 4088.00", st == 'ok' and abs(pr - 4088.0) < 1e-9)

print(f"\n{'ALL PASSED' if failures == 0 else str(failures) + ' FAILED'}")
sys.exit(0 if failures == 0 else 1)
