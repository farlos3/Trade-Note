#!/usr/bin/env python3
"""
Live MT5 -> TradeNote feed (open positions, floating P&L, equity).

This is the REALTIME half of the sync, and is deliberately separate from
mt5_sync.py:

  mt5_sync.py   runs once a minute, reads CLOSED deals, writes them to MongoDB.
                That is the durable journal -- the record of what happened.
  mt5_live.py   runs continuously, reads OPEN positions + account equity, and
                POSTs them to /api/live, which keeps them in memory only.
                That is ephemeral state -- true for one second, then replaced.

Keeping them apart is the point: a tick-rate feed must never touch the journal's
database (millions of rows a week to describe a value that is already stale), and
the journal's once-a-minute cadence is far too slow to watch a position move.

Runs on the host, never in the app container, and reads MT5 through whichever of
the two backends mt5_sync.py picked (see pick_backend there -- this deliberately
reuses that module rather than keeping a second copy of the logic):

  MetaTrader5 package   Windows only. The wheel binds to terminal64.dll.
  TradeNoteExport EA    Everywhere, macOS included. The EA writes open positions
                        into its JSON bridge file and this reads them back out.
                        Refresh rate is the EA's ExportIntervalSeconds, so
                        polling faster than that just re-reads the same file.

It attaches to an already-open terminal and never launches one -- if MT5 is closed
it waits and retries rather than waking it.

Usage:
    python mt5-sync/mt5_live.py                # loop until stopped
    python mt5-sync/mt5_live.py --interval 2   # seconds between reads (default 1)
    python mt5-sync/mt5_live.py --once         # single read, for testing
"""
import argparse
import os
import subprocess
import sys
import time
from datetime import datetime

try:
    import requests
except ImportError:
    sys.exit("requests package missing. Run: pip install requests")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mt5_sync import load_config, pick_backend  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def read_live(backend):
    """One snapshot of the terminal, or None when it isn't reachable.

    Never launches MT5: mt5.initialize() starts the terminal when none is running,
    so in a once-a-second loop that would make the platform impossible to close --
    it would just reappear. No running terminal, no snapshot.
    """
    if not backend.terminal_running():
        return None
    if not backend.refresh():
        return None
    snap = backend.live_snapshot()
    if snap is None:
        # The terminal is open but this process is not attached to it: either it
        # started while MT5 was closed (main() skips initialize() then) or MT5 was
        # restarted under a long-lived agent. Without re-attaching here the agent
        # sits silent for days -- alive, so ./tradenote.sh start calls it healthy and starts
        # no replacement, while every read returns nothing. Only reached with a
        # terminal already running, so this cannot LAUNCH one.
        if backend.initialize():
            snap = backend.live_snapshot()
    return snap


def trigger_journal_sync():
    """Run the journal sync NOW, in the background.

    The scheduled task already runs mt5_sync.py once a minute, which means a trade
    you just closed can take up to a minute to appear anywhere in the app. This
    agent is already watching the terminal every second, so it can notice the close
    and kick the sync immediately -- turning that minute into about a second.

    Fire-and-forget on purpose: the sync takes a few seconds and this loop must
    keep streaming the live feed meanwhile. Re-running it is harmless (TradeNote
    dedups by dateUnix), so a spurious trigger costs nothing.
    """
    script = os.path.join(HERE, "mt5_sync.py")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen([sys.executable, script],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=creationflags)
        return True
    except OSError as e:
        log(f"Could not start the journal sync: {e}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between reads (default 1)")
    ap.add_argument("--once", action="store_true", help="single read then exit")
    ap.add_argument("--no-trigger", action="store_true",
                    help="don't kick mt5_sync.py when a position closes")
    args = ap.parse_args()

    cfg = load_config()
    url = cfg.get("tradenote", "url").rstrip("/") + "/api/live"
    api_key = cfg.get("tradenote", "api_key")
    headers = {"api-key": api_key, "Content-Type": "application/json"}

    # pick_backend, not connect(): connect() sys.exit()s when MT5 is unreachable,
    # which is right for a one-shot sync and wrong for an agent that is supposed to
    # sit and wait for the terminal to be opened.
    backend = pick_backend(cfg)
    log(f"Reading MT5 via {backend.name}.")
    if backend.terminal_running():
        if not backend.initialize():
            log(f"Could not attach: {backend.last_error()}")
            if args.once:
                sys.exit(1)
    else:
        log("MT5 terminal is closed — waiting for it to be opened (will not launch it).")
        if args.once:
            sys.exit(1)

    session = requests.Session()   # one keep-alive connection, not one per tick
    log(f"Live feed -> {url} every {args.interval}s. Ctrl+C to stop.")

    # Only log state CHANGES, never every tick: at 1/s this would otherwise write
    # ~86k lines a day and bury anything that matters.
    last_err = None
    last_count = None
    # Balance is the reliable "a deal settled" signal: it only moves when a
    # position closes (or on a deposit/withdrawal, which the journal wants too).
    # Watching the position count alone would miss a close that opens a
    # replacement in the same second, leaving the count unchanged.
    last_balance = None
    last_trigger_at = 0.0
    TRIGGER_COOLDOWN_S = 10   # closing a basket fires several times in a row
    try:
        while True:
            try:
                snap = read_live(backend)
                if snap is None:
                    if last_err != "no-terminal":
                        log("MT5 terminal not available — waiting (will not launch it). "
                            "If MT5 IS open, the TradeNoteExport EA may predate the "
                            "'positions' key: recompile it (F7) and re-attach.")
                        last_err = "no-terminal"
                else:
                    r = session.post(url, headers=headers, json=snap, timeout=5)
                    if r.status_code != 200:
                        if last_err != f"http{r.status_code}":
                            log(f"POST /api/live -> HTTP {r.status_code}: {r.text[:200]}")
                            last_err = f"http{r.status_code}"
                    else:
                        if last_err is not None:
                            log("Recovered — feed flowing again.")
                            last_err = None
                        n = len(snap["positions"])
                        if n != last_count:
                            log(f"{n} open position(s), equity {snap['equity']:.2f} "
                                f"(floating {snap['profit']:+.2f})")
                            last_count = n

                        # A settled deal moved the balance -> pull it into the
                        # journal right away instead of waiting for the minute
                        # timer. Skipped on the very first reading, which
                        # establishes the baseline rather than marking a change.
                        bal = snap["balance"]
                        if last_balance is not None and abs(bal - last_balance) > 1e-9:
                            now_s = time.monotonic()
                            if not args.no_trigger and (now_s - last_trigger_at) > TRIGGER_COOLDOWN_S:
                                log(f"Balance {last_balance:.2f} -> {bal:.2f}; syncing journal now.")
                                if trigger_journal_sync():
                                    last_trigger_at = now_s
                        last_balance = bal
            except requests.RequestException as e:
                if last_err != "net":
                    log(f"Cannot reach TradeNote ({e}) — retrying quietly.")
                    last_err = "net"

            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("Stopped.")
    finally:
        backend.shutdown()


if __name__ == "__main__":
    main()
