#!/usr/bin/env python3
"""
Does TradeNote's trade history match the real MT5 account?

Read-only. Builds every CLOSED position from the terminal's own deals (the truth)
and checks each one against the trades stored in TradeNote's database:

  missing        in MT5, not in TradeNote
  duplicated     stored more than once (e.g. once at the right time, once shifted)
  time-shifted   stored with an entry time that is not the deal's
  P&L wrong      stored as still open, or with a different realised result

and prints the realised P&L of the window on both sides. Exits 1 when anything is
off, so it can be scripted.

The window is whatever the terminal exposes: on macOS the EA exports LookbackDays
(7 by default); on Windows the native package reaches the full history, narrowed
with --days.

The database is read through the running mongo container (`docker exec`), the same
way the backup scripts do, so this works wherever ./tradenote.sh start works.

Run:  python3 mt5-sync/reconcile.py [--days 7] [--container tradenote_mongo] [--verbose]
"""
import argparse
import collections
import datetime as dt
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mt5_sync as m  # noqa: E402

BKK = dt.timezone(dt.timedelta(hours=7))


def local(u):
    return dt.datetime.fromtimestamp(u, BKK).strftime("%m-%d %H:%M") if u else "-"


def mt5_positions(backend, days):
    now = dt.datetime.now()
    deals = backend.history_deals_get(now - dt.timedelta(days=days), now + dt.timedelta(days=2))
    if deals is None:
        sys.exit(f"Could not read deals from MT5: {backend.last_error()}")
    pos = collections.defaultdict(lambda: {"in": None, "out": None, "pnl": 0.0})
    for d in deals:
        if d.type not in (m.DEAL_TYPE_BUY, m.DEAL_TYPE_SELL):
            continue
        p = pos[str(d.position_id)]
        p["pnl"] += d.profit + d.swap + d.commission + getattr(d, "fee", 0.0)
        if d.entry == m.DEAL_ENTRY_IN:
            p["in"] = (d.time, d.price, "Buy" if d.type == m.DEAL_TYPE_BUY else "Sell", d.volume)
        else:
            p["out"] = (d.time, d.price)
    # A position whose entry fell before the window cannot be judged -- skip it.
    return {k: v for k, v in pos.items() if v["in"] and v["out"]}


def env_value(key):
    """A value from the repo's .env (the same file the app is started with)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    try:
        for line in open(path, encoding="utf-8"):
            if line.strip().startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def db_trades(container):
    db = env_value("TRADENOTE_DATABASE") or "tradenote"
    uri = env_value("BACKUP_MONGO_URI")
    if uri:
        # The same connection the R2 backup uses: Atlas (read-only user) or local.
        from pymongo import MongoClient
        out = []
        for d in MongoClient(uri, serverSelectionTimeoutMS=15000)[db]["trades"].find({}):
            for t in d.get("trades") or []:
                out.append({"pos": str(t.get("positionId") or ""), "entry": t.get("entryTime"),
                            "net": t.get("netProceeds"), "open": bool(t.get("openPosition")),
                            "account": t.get("account") or d.get("account") or ""})
        return out
    script = ("const out=[]; db.trades.find({}).forEach(d=>(d.trades||[]).forEach(t=>out.push("
              "{pos:String(t.positionId||''),entry:t.entryTime,net:t.netProceeds,open:!!t.openPosition,"
              "account:t.account||d.account||''})));print(JSON.stringify(out));")
    try:
        out = subprocess.run(["docker", "exec", container, "mongosh", "--quiet", db, "--eval", script],
                             capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        sys.exit("docker not found -- start the stack (./tradenote.sh start) and run this again.")
    if out.returncode != 0 or not out.stdout.strip():
        sys.exit(f"Could not read the database from container '{container}': {out.stderr.strip()[:300]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=7, help="how far back to check (default 7)")
    ap.add_argument("--container", default="tradenote_mongo", help="mongo container name")
    ap.add_argument("--verbose", action="store_true", help="also list positions that match")
    args = ap.parse_args()

    m.log = lambda msg: None              # the sync's own chatter is not this report
    cfg = m.load_config()
    backend = m.pick_backend(cfg)
    info = m.connect(cfg, backend)
    if backend.broker_offset() is None:
        sys.exit("MT5's clock offset is not trustworthy right now (the terminal has probably just "
                 "started). Wait a minute and run this again.")

    truth = mt5_positions(backend, args.days)
    if not truth:
        print("No closed positions in the window.")
        return 0
    account_label = f"{info.login}@{info.server}"
    stored = [t for t in db_trades(args.container) if not t["account"] or t["account"] == account_label]
    by_pos = collections.defaultdict(list)
    for t in stored:
        if t["pos"]:
            by_pos[t["pos"]].append(t)

    first = min(v["in"][0] for v in truth.values())
    print(f"Account {account_label}: {len(truth)} closed positions since {local(first)} (Bangkok time)\n")

    counts = collections.Counter()
    for k, v in sorted(truth.items(), key=lambda kv: kv[1]["in"][0]):
        recs = by_pos.get(k, [])
        issues = []
        if not recs:
            issues.append("MISSING from TradeNote")
        else:
            if len(recs) > 1:
                issues.append(f"stored {len(recs)} times")
                counts["duplicated"] += 1
            r = recs[0]
            if r["entry"] != v["in"][0]:
                issues.append(f"entry time off by {r['entry'] - v['in'][0]:+d}s")
                counts["time-shifted"] += 1
            if r["open"] or r["net"] is None or abs((r["net"] or 0) - v["pnl"]) > 0.011:
                issues.append(f"P&L {r['net']}{' (stuck open)' if r['open'] else ''} vs MT5 {v['pnl']:+.2f}")
                counts["P&L wrong"] += 1
        if not recs:
            counts["missing"] += 1
        if issues or args.verbose:
            print(f"  {k}  {v['in'][2]:4} {v['in'][3]:.2f} @ {v['in'][1]:<8.2f} {local(v['in'][0])} -> "
                  f"{local(v['out'][0])}  MT5 {v['pnl']:+7.2f}   {'; '.join(issues) or 'ok'}")
        if not issues:
            counts["ok"] += 1

    mt5_total = sum(v["pnl"] for v in truth.values())
    db_total = sum((t["net"] or 0) for t in stored if t["entry"] and t["entry"] >= first)
    print(f"\n  matched exactly: {counts['ok']}   missing: {counts['missing']}   duplicated: {counts['duplicated']}   "
          f"time-shifted: {counts['time-shifted']}   P&L wrong: {counts['P&L wrong']}")
    print(f"  realised P&L since {local(first)}:  MT5 {mt5_total:+.2f}   TradeNote {db_total:+.2f}   "
          f"difference {db_total - mt5_total:+.2f}")
    clean = counts["ok"] == len(truth) and abs(db_total - mt5_total) < 0.011
    print("\n  IN SYNC" if clean else "\n  OUT OF SYNC")
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
