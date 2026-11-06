#!/usr/bin/env python3
"""
Re-file every MetaTrader 5 trade under its day in the TRADE timezone.

Until 2026-11-06 the importer filed an MT5 deal under the date written in its time
string -- the broker's date in older imports, the UTC date in newer ones -- so a
Bangkok trade between midnight and 07:00 sat on the previous day. The importer now
uses the trade timezone's day; this moves the trades already stored.

It does NOT edit day documents by hand. It rebuilds the MT5 deal report from the
executions TradeNote already stores (each execution is one MT5 deal: time, price,
volume, side, position, costs, profit), removes the MT5 day documents, and feeds the
report back through the app's own importer -- the same /api/trades path the sync
uses every minute -- so blotters, P&L and trades are recomputed by the code that
normally computes them.

Safety, in order:
  * default is a DRY RUN: it builds the reports and checks them, changes nothing;
  * --apply first saves the whole `trades` collection to backup/pre-restore/;
  * afterwards it checks that every position (per account) still exists exactly
    once with the same net P&L, that the execution count is unchanged, and that each
    trade now sits on its trade-timezone day -- and RESTORES the backup on any failure.
Days holding non-MT5 trades (e.g. a manually added one) are left exactly as they are.
Execution timestamps themselves are not changed.

Two sources:
  --source executions (default)  rebuild from what TradeNote stores. Refuses if the
                                 stored executions do not reproduce the stored trades
                                 -- older imports mis-paired some deals, and a rebuild
                                 would silently change those positions' P&L.
  --source mt5                   re-import the terminal's CURRENT account straight
                                 from MT5, the truth. Needs the EA to export the whole
                                 period (LookbackDays) back to the account's first
                                 stored trade; refuses otherwise. It also switches the
                                 backend to trade-timezone days (MT5_DAY_BUCKETS) in the
                                 same step, and switches it back on failure.

Run:  python3 mt5-sync/rebucket_days.py                          # dry run
      python3 mt5-sync/rebucket_days.py --source mt5             # dry run from MT5
      python3 mt5-sync/rebucket_days.py --source mt5 --apply     # do it
      python3 mt5-sync/rebucket_days.py --target utc             # undo: back to UTC days, flag off
"""
import argparse
import collections
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mt5_sync as m  # noqa: E402

ROOT = os.path.dirname(HERE)


def env_value(key):
    try:
        for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
            if line.strip().startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


class Mongo:
    def __init__(self, container, db):
        self.container, self.db = container, db

    def eval(self, script):
        out = subprocess.run(["docker", "exec", self.container, "mongosh", "--quiet", self.db, "--eval", script],
                             capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip()[:500] or "mongosh failed")
        return out.stdout.strip()

    def dump_trades(self):
        """Canonical EJSON, so a restore puts back exactly the same types."""
        return self.eval("print(EJSON.stringify(db.trades.find({}).toArray(), {relaxed:false}))").splitlines()[-1]

    def restore_trades(self, ejson_text):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            f.write(ejson_text)
            local = f.name
        subprocess.run(["docker", "cp", local, f"{self.container}:/tmp/trades-restore.json"], check=True)
        os.unlink(local)
        return self.eval("const docs = EJSON.parse(require('fs').readFileSync('/tmp/trades-restore.json','utf8'));"
                         "db.trades.deleteMany({}); const r = db.trades.insertMany(docs);"
                         "print(Object.keys(r.insertedIds).length)")


def container_env(container, key):
    out = subprocess.run(["docker", "exec", container, "printenv", key], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else ""


def set_env_flag(value, app_container):
    """Write MT5_DAY_BUCKETS into .env and recreate the app container so it is live.
    Keeps whatever NODE_ENV the container was started with."""
    path = os.path.join(ROOT, ".env")
    lines = [l for l in open(path, encoding="utf-8").read().splitlines() if not l.startswith("MT5_DAY_BUCKETS=")]
    if value:
        lines.append(f"MT5_DAY_BUCKETS={value}")
    open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    node_env = container_env(app_container, "NODE_ENV") or "dev"
    env = dict(os.environ, NODE_ENV=node_env, MT5_DAY_BUCKETS=value or "")
    subprocess.run(["docker", "compose", "-f", os.path.join(ROOT, "docker-compose-dev.yml"), "up", "-d", "tradenote"],
                   cwd=ROOT, env=env, check=True, capture_output=True)
    import time, urllib.request
    port = env_value("TRADENOTE_PORT") or "8080"
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://localhost:{port}/", timeout=3)
            if container_env(app_container, "MT5_DAY_BUCKETS") == (value or ""):
                return
        except Exception:  # noqa: BLE001 -- still starting
            pass
        time.sleep(2)
    raise RuntimeError("the app did not come back after switching MT5_DAY_BUCKETS")


# Canonical EJSON wraps numbers ({"$numberDouble": ...}); read them as plain values.
def plain(x):
    if isinstance(x, dict):
        if len(x) == 1:
            k, v = next(iter(x.items()))
            if k in ("$numberDouble", "$numberInt", "$numberLong", "$numberDecimal"):
                return float(v) if k in ("$numberDouble", "$numberDecimal") else int(v)
        return {k: plain(v) for k, v in x.items()}
    if isinstance(x, list):
        return [plain(v) for v in x]
    return x


def tz_day(unix, tz_hours):
    return (dt.datetime.fromtimestamp(unix, dt.timezone.utc) + dt.timedelta(hours=tz_hours)).date()


def plan(docs, account=None):
    """Split documents into MT5-only (rebuilt) and the rest (kept verbatim)."""
    rebuild, keep = [], []
    for d in docs:
        trades = d.get("trades") or []
        if account and d.get("account") != account:
            keep.append(d)
        elif trades and all(t.get("broker") == "metaTrader5" for t in trades):
            rebuild.append(d)
        else:
            keep.append(d)
    return rebuild, keep


def deals_from_executions(docs):
    """One MT5-shaped deal per stored execution, grouped by account."""
    per_account = collections.defaultdict(list)
    for d in docs:
        for e in d.get("executions") or []:
            side = e.get("side")
            per_account[e.get("account") or d.get("account")].append(m._Obj({
                "ticket": e.get("id", ""),
                "time": int(e["execTime"]),
                "type": m.DEAL_TYPE_BUY if side in ("B", "BC") else m.DEAL_TYPE_SELL,
                "entry": m.DEAL_ENTRY_IN if side in ("B", "SS") else 1,
                "symbol": e.get("symbolOriginal") or e.get("symbol"),
                "volume": float(e.get("quantity") or 0),
                "price": float(e.get("price") or 0),
                "position_id": e.get("positionId") or "",
                # TradeNote stores costs as positive charges; the report wants MT5's sign.
                "commission": -float(e.get("commission") or 0),
                "fee": -float(e.get("sec") or 0),
                "swap": -float(e.get("taf") or 0),
                "profit": float(e.get("grossProceeds") or 0),
                "comment": "",
            }))
    for deals in per_account.values():
        deals.sort(key=lambda x: (x.time, 0 if x.entry == m.DEAL_ENTRY_IN else 1))
    return per_account


def fingerprint(docs):
    """What must survive: every position once, with its net P&L, per account."""
    pos, execs, opened = collections.Counter(), collections.Counter(), 0
    net = {}
    for d in docs:
        for t in d.get("trades") or []:
            if t.get("broker") != "metaTrader5":
                continue
            key = (t.get("account") or d.get("account"), str(t.get("positionId") or t.get("id")))
            pos[key] += 1
            net[key] = round(net.get(key, 0) + float(t.get("netProceeds") or 0), 2)
            opened += 1 if t.get("openPosition") else 0
        for e in d.get("executions") or []:
            execs[e.get("account") or d.get("account")] += 1
    return pos, net, execs, opened


def misfiled(docs, tz_hours, doc_hours=None):
    """Trades whose entry day (in tz_hours) differs from their document's day label.
    A day document's dateUnix is midnight in the trade timezone, so it is always read
    with doc_hours (the trade timezone) even when trades are filed under UTC days."""
    if doc_hours is None:
        doc_hours = tz_hours
    bad = 0
    for d in docs:
        for t in d.get("trades") or []:
            if t.get("broker") == "metaTrader5" and t.get("entryTime") and \
                    tz_day(t["entryTime"], tz_hours) != tz_day(d["dateUnix"], doc_hours):
                bad += 1
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually move the trades (default: dry run)")
    ap.add_argument("--container", default="tradenote_mongo")
    ap.add_argument("--tz-hours", type=float, default=7.0, help="trade timezone offset (Asia/Bangkok = 7)")
    ap.add_argument("--source", choices=("executions", "mt5"), default="executions")
    ap.add_argument("--app-container", default="tradenote_app")
    ap.add_argument("--target", choices=("trade-tz", "utc"), default="trade-tz",
                    help="day to file trades under. utc = the importer's behaviour with MT5_DAY_BUCKETS "
                         "off (the date of the deal in UTC); it also switches that flag OFF")
    ap.add_argument("--account", help="only this account label (e.g. 198654453@HFMarketsGlobal-Live16); "
                                      "every other account's days are kept verbatim")
    args = ap.parse_args()
    args.doc_hours = args.tz_hours  # day documents are labelled in the trade timezone
    if args.target == "utc":
        if args.source == "mt5":
            sys.exit("--target utc works from the stored executions; leave --source at its default.")
        args.tz_hours = 0.0  # trades are checked against their UTC day

    mongo = Mongo(args.container, env_value("TRADENOTE_DATABASE") or "tradenote")
    raw = mongo.dump_trades()
    docs = json.loads(raw)
    docs = plain(docs)

    if args.source == "mt5":
        return from_mt5(args, mongo, raw, docs)

    rebuild, keep = plan(docs, args.account)
    per_account = deals_from_executions(rebuild)
    before = fingerprint(docs)
    print(f"day documents: {len(docs)}  (MT5-only, rebuilt: {len(rebuild)}; kept verbatim: {len(keep)})")
    print(f"MT5 trades filed on a day other than their trade-timezone day: {misfiled(docs, args.tz_hours, args.doc_hours)}"
          + (f" (in {args.account}: {misfiled(rebuild, args.tz_hours, args.doc_hours)})" if args.account else ""))
    for acct, deals in per_account.items():
        print(f"  {acct}: {len(deals)} deals -> report")

    # Dry-run check: the rebuilt deals must re-form exactly the stored positions.
    rebuilt = collections.defaultdict(float)
    for acct, deals in per_account.items():
        for x in deals:
            rebuilt[(acct, str(x.position_id))] += x.profit + x.commission + x.fee + x.swap
    stored = {k: v for k, v in before[1].items() if k[0] in per_account}
    mismatch = [k for k in stored if abs(round(rebuilt.get(k, 0), 2) - stored[k]) > 0.011]
    for acct in per_account:
        n = sum(1 for k in mismatch if k[0] == acct)
        print(f"  {acct}: positions whose stored deals do not add up to the stored trade: {n}")
    if mismatch:
        for k in mismatch[:10]:
            print(f"  {k}: stored {stored[k]} vs rebuilt {round(rebuilt.get(k, 0), 2)}")
        sys.exit("Refusing to continue: the stored executions do not reproduce the stored trades.")

    if not args.apply:
        print("\nDry run only. Nothing was changed. Re-run with --apply to move the trades.")
        return 0

    # ---- apply ------------------------------------------------------------------
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(ROOT, "backup", "pre-restore", f"trades-full-before-rebucket-{stamp}.json")
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    with open(backup, "w", encoding="utf-8") as f:
        f.write(raw)
    print(f"\nbackup: {os.path.relpath(backup, ROOT)}")

    cfg = m.load_config()
    ids = json.dumps([d["_id"] for d in rebuild])
    flag_before = container_env(args.app_container, "MT5_DAY_BUCKETS")
    flag_changed = False
    try:
        if args.target == "utc" and flag_before == "trade-tz":
            print("switching the backend back to UTC days (MT5_DAY_BUCKETS off) ...")
            set_env_flag("", args.app_container)
            flag_changed = True
        print("removed MT5 day documents:", mongo.eval(f"print(db.trades.deleteMany({{_id:{{$in:{ids}}}}}).deletedCount)"))
        for acct, deals in per_account.items():
            login, _, server = str(acct).partition("@")
            resp = m.push(cfg, m.build_report_xlsx(login, server, deals))
            print(f"  re-imported {acct}: {resp}")
        after_docs = plain(json.loads(mongo.dump_trades()))
        after = fingerprint(after_docs)
        problems = []
        if args.account:
            # trades of the untouched accounts are covered by the verbatim check below
            pass
        if after[0] != before[0]:
            problems.append("positions changed (lost, duplicated or added)")
        if after[1] != before[1]:
            problems.append("a position's net P&L changed")
        if after[2] != before[2]:
            problems.append("execution count changed")
        if after[3] > before[3]:
            problems.append(f"{after[3] - before[3]} more trades are now stuck open")
        left = misfiled([d for d in after_docs if not args.account or d.get("account") == args.account], args.tz_hours, args.doc_hours)
        if left:
            problems.append(f"{left} trades still on the wrong day")
        kept_after = {d["_id"]: d for d in after_docs}
        if any(kept_after.get(d["_id"]) != d for d in keep):
            problems.append("a kept (non-MT5) day document changed")
        if problems:
            raise RuntimeError("; ".join(problems))
    except Exception as e:  # noqa: BLE001 -- anything at all: put the data back
        print(f"\nCHECK FAILED: {e}\nRestoring the backup ...")
        print("restored documents:", mongo.restore_trades(raw))
        if flag_changed:
            set_env_flag(flag_before, args.app_container)
        return 1

    print(f"\nOK. {sum(before[0].values())} positions, same net P&L each; "
          f"every MT5 trade now on its {'UTC' if args.target == 'utc' else 'trade-timezone'} day.")
    return 0


def from_mt5(args, mongo, raw, docs):
    m.log = lambda msg: None
    cfg = m.load_config()
    backend = m.pick_backend(cfg)
    info = m.connect(cfg, backend)
    if backend.broker_offset() is None:
        sys.exit("MT5's clock offset is not trustworthy right now; wait a minute and retry.")
    account = f"{info.login}@{info.server}"
    if args.account and args.account != account:
        sys.exit(f"The terminal is logged into {account}, not {args.account}; --source mt5 can only "
                 "re-import the account the terminal is on.")
    rebuild, keep = plan(docs, account)
    stored_entries = [t["entryTime"] for d in rebuild for t in d.get("trades") or [] if t.get("entryTime")]
    if not stored_entries:
        sys.exit(f"No stored MT5 trades for {account}.")
    earliest = min(stored_entries)
    now = dt.datetime.now()
    all_deals = backend.history_deals_get(dt.datetime(2000, 1, 1), now + dt.timedelta(days=2)) or []
    trade_deals = [d for d in all_deals if d.type in (m.DEAL_TYPE_BUY, m.DEAL_TYPE_SELL)]
    if not trade_deals:
        sys.exit("MT5 returned no trade deals.")
    first_deal = min(d.time for d in trade_deals)
    print(f"{account}: {len(rebuild)} stored day documents, first stored trade "
          f"{dt.datetime.fromtimestamp(earliest):%Y-%m-%d}; MT5 exposes deals from "
          f"{dt.datetime.fromtimestamp(first_deal):%Y-%m-%d}")
    if first_deal > earliest:
        days = (now - dt.datetime.fromtimestamp(earliest)).days + 3
        sys.exit(f"MT5 does not reach back far enough. Set the EA's LookbackDays to at least {days} "
                 "(EA inputs, F7 not needed for that), wait for the next export, and run this again.")
    frm = dt.datetime.fromtimestamp(earliest) - dt.timedelta(days=1)
    deals = m.fetch_deals(backend, frm, now + dt.timedelta(days=2))
    positions = {str(d.position_id) for d in deals}
    print(f"MT5 closed positions to import: {len(positions)}; currently stored for this account: "
          f"{sum(len(d.get('trades') or []) for d in rebuild)}; filed on the wrong day: {misfiled(rebuild, args.tz_hours, args.doc_hours)}")
    if not args.apply:
        print("\nDry run only. Nothing was changed. Re-run with --apply.")
        return 0

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(ROOT, "backup", "pre-restore", f"trades-full-before-rebucket-{stamp}.json")
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    open(backup, "w", encoding="utf-8").write(raw)
    print(f"\nbackup: {os.path.relpath(backup, ROOT)}")
    flag_before = container_env(args.app_container, "MT5_DAY_BUCKETS")
    try:
        if flag_before != "trade-tz":
            print("switching the backend to trade-timezone days ...")
            set_env_flag("trade-tz", args.app_container)
        ids = json.dumps([d["_id"] for d in rebuild])
        print("removed day documents:", mongo.eval(f"print(db.trades.deleteMany({{_id:{{$in:{ids}}}}}).deletedCount)"))
        print("re-imported:", m.push(cfg, m.build_report_xlsx(info.login, info.server, deals)))
        after_raw = json.loads(mongo.dump_trades())
        after = plain(after_raw)
        problems = []
        mine = [t for d in after if d.get("account") == account for t in d.get("trades") or []]
        by_pos = collections.Counter(str(t.get("positionId")) for t in mine)
        if set(by_pos) != positions:
            problems.append(f"positions differ from MT5 (missing {len(positions - set(by_pos))}, extra {len(set(by_pos) - positions)})")
        if any(c > 1 for c in by_pos.values()):
            problems.append("some positions are stored twice")
        truth = collections.defaultdict(float)
        for d in deals:
            truth[str(d.position_id)] += d.profit + d.swap + d.commission + getattr(d, "fee", 0.0)
        wrong = [t for t in mine if abs(float(t.get("netProceeds") or 0) - round(truth.get(str(t.get("positionId")), 0), 2)) > 0.011]
        if wrong:
            problems.append(f"{len(wrong)} positions have a P&L different from MT5")
        if any(t.get("openPosition") for t in mine):
            problems.append("some trades are stuck open")
        bad_day = [t for d in after if d.get("account") == account for t in d.get("trades") or []
                   if tz_day(t["entryTime"], args.tz_hours) != tz_day(d["dateUnix"], args.tz_hours)]
        if bad_day:
            problems.append(f"{len(bad_day)} trades are not on their trade-timezone day")
        untouched = {d["_id"]: d for d in json.loads(raw) if d["_id"] not in json.loads(ids)}
        after_by_id = {d["_id"]: d for d in after_raw}
        if any(after_by_id.get(k) != v for k, v in untouched.items()):
            problems.append("another account's day documents changed")
        if problems:
            raise RuntimeError("; ".join(problems))
    except Exception as e:  # noqa: BLE001
        print(f"\nCHECK FAILED: {e}\nRestoring the backup and the previous day setting ...")
        print("restored documents:", mongo.restore_trades(raw))
        if flag_before != "trade-tz":
            set_env_flag(flag_before, args.app_container)
        return 1
    print(f"\nOK. {len(positions)} positions re-imported from MT5, each once, P&L equal to MT5, all on "
          f"their trade-timezone day. Other accounts untouched. New imports now use trade-timezone days.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
