#!/usr/bin/env python3
"""
MT5 -> TradeNote auto-sync bridge.

Pulls closed deals from a running MetaTrader 5 terminal, rebuilds them into the
"Trade History Report" XLSX layout that TradeNote's MetaTrader5 importer expects,
and pushes them to the TradeNote /api/trades endpoint.

Designed to be run on a schedule (Windows Task Scheduler) on the same machine
as the MT5 terminal. See README.md.
"""

import base64
import configparser
import datetime as dt
import io
import json
import os
import smtplib
import sys
from email.message import EmailMessage

import requests

try:
    import MetaTrader5 as mt5
except ImportError:
    sys.exit("MetaTrader5 package missing. Run: pip install MetaTrader5 openpyxl requests")

import openpyxl


HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.ini")
STATE_PATH = os.path.join(HERE, "state.json")


def log(msg):
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def load_config():
    if not os.path.exists(CONFIG_PATH):
        sys.exit(f"Missing {CONFIG_PATH}. Copy config.example.ini -> config.ini and fill it in.")
    cfg = configparser.ConfigParser()
    cfg.read(CONFIG_PATH, encoding="utf-8")
    return cfg


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def connect(cfg):
    """Attach to the MT5 terminal. Uses credentials if provided, otherwise the
    already-logged-in terminal session."""
    login = cfg.get("mt5", "login", fallback="").strip()
    password = cfg.get("mt5", "password", fallback="").strip()
    server = cfg.get("mt5", "server", fallback="").strip()
    path = cfg.get("mt5", "terminal_path", fallback="").strip()

    kwargs = {}
    if path:
        kwargs["path"] = path
    if login and password and server:
        kwargs.update(login=int(login), password=password, server=server)

    ok = mt5.initialize(**kwargs)
    if not ok:
        sys.exit(f"mt5.initialize failed: {mt5.last_error()} "
                 "(open MT5 and log in, or set login/password/server in config.ini)")
    info = mt5.account_info()
    log(f"Connected to MT5 account {info.login} @ {info.server} ({info.currency})")
    return info


def fetch_deals(frm, to):
    deals = mt5.history_deals_get(frm, to)
    if deals is None:
        log(f"history_deals_get returned None: {mt5.last_error()}")
        return []
    # Keep only actual trade deals (buy/sell). Skip balance/credit/correction entries.
    return [d for d in deals if d.type in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL)]


def build_report_xlsx(account_login, deals):
    """Recreate the minimal MT5 'Trade History Report' structure TradeNote parses.
    Column order matters (positional): Time, Deal, Symbol, Type, Direction,
    Volume, Price, Order, Commission, Fee, Swap, Profit, Balance, Comment."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Trade History Report"])
    ws.append([])
    ws.append(["Account:", f"{account_login} TradeNote USD"])
    ws.append([])
    ws.append(["Deals"])
    ws.append(["Time", "Deal", "Symbol", "Type", "Direction", "Volume", "Price",
               "Order", "Commission", "Fee", "Swap", "Profit", "Balance", "Comment"])

    for d in deals:
        ts = dt.datetime.fromtimestamp(d.time).strftime("%Y.%m.%d %H:%M:%S")
        side = "buy" if d.type == mt5.DEAL_TYPE_BUY else "sell"
        direction = "in" if d.entry == mt5.DEAL_ENTRY_IN else "out"
        ws.append([ts, str(d.ticket), d.symbol, side, direction,
                   float(d.volume), float(d.price), str(d.order),
                   float(d.commission), float(d.fee), float(d.swap),
                   float(d.profit), 0, d.comment or ""])

    # Terminator: column A empty but column B filled so SheetJS keeps the row and
    # TradeNote's deal loop stops cleanly (empty rows get dropped by sheet_to_json).
    ws.append([None, "end"])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def push(cfg, xlsx_bytes):
    url = cfg.get("tradenote", "url").rstrip("/") + "/api/trades"
    api_key = cfg.get("tradenote", "api_key")
    body = {
        "selectedBroker": "metaTrader5",
        "uploadMfePrices": False,
        "data": base64.b64encode(xlsx_bytes).decode(),
    }
    r = requests.post(url, headers={"api-key": api_key, "Content-Type": "application/json"},
                      data=json.dumps(body), timeout=120)
    r.raise_for_status()
    return r.text.strip()


def notify_email(cfg, deals, resp):
    """Send a reminder email after new deals were synced. Non-fatal: any failure
    is logged and swallowed so it never breaks the sync itself.

    Secrets come from the [notify] section of config.ini; the Gmail app password
    can also be supplied via the GMAIL_APP_PASSWORD environment variable."""
    if not cfg.has_section("notify"):
        return
    if not cfg.getboolean("notify", "enabled", fallback=False):
        return

    sender = cfg.get("notify", "sender", fallback="").strip()
    recipient = cfg.get("notify", "recipient", fallback=sender).strip() or sender
    host = cfg.get("notify", "smtp_host", fallback="smtp.gmail.com").strip()
    port = cfg.getint("notify", "smtp_port", fallback=587)
    app_password = cfg.get("notify", "app_password", fallback="").strip()
    if not app_password:
        app_password = os.environ.get("GMAIL_APP_PASSWORD", "")
    # Gmail shows app passwords in 4-char groups; the spaces are cosmetic.
    app_password = app_password.replace(" ", "")

    if not sender or not app_password:
        log("notify: sender/app_password not set, skipping email")
        return

    # Summarise the synced deals for the reminder body.
    symbols = {}
    total_profit = 0.0
    for d in deals:
        symbols[d.symbol] = symbols.get(d.symbol, 0) + 1
        total_profit += float(d.profit)
    sym_line = ", ".join(f"{s} ({n})" for s, n in sorted(symbols.items())) or "-"
    count = len(deals)
    tradenote_url = cfg.get("tradenote", "url", fallback="").rstrip("/")

    subject = f"TradeNote: {count} new MT5 deal(s) synced - update your journal"
    body = "\n".join([
        f"{count} new deal(s) were just synced from MetaTrader 5 into TradeNote.",
        "",
        f"Symbols: {sym_line}",
        f"Total profit (raw deals): {total_profit:.2f}",
        "",
        "Reminder - open TradeNote and finish these trades:",
        "  - add screenshots of your setups",
        "  - write your notes / journaling",
        "  - tag your strategy and satisfaction",
        "",
        f"TradeNote: {tradenote_url}" if tradenote_url else "",
        f"Server response: {resp}",
    ]).strip()

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    msg.set_content(body)

    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            s.login(sender, app_password)
            s.send_message(msg)
        log(f"notify: reminder email sent to {recipient}")
    except Exception as e:  # noqa: BLE001 - never let email break the sync
        log(f"notify: failed to send email: {e}")


def main():
    cfg = load_config()
    state = load_state()

    lookback_days = cfg.getint("sync", "lookback_days", fallback=7)
    to = dt.datetime.now()
    if state.get("last_sync"):
        frm = dt.datetime.fromisoformat(state["last_sync"])
    else:
        frm = to - dt.timedelta(days=lookback_days)
    log(f"Sync window: {frm:%Y-%m-%d %H:%M} -> {to:%Y-%m-%d %H:%M}")

    connect(cfg)
    try:
        deals = fetch_deals(frm, to)
        log(f"Fetched {len(deals)} trade deal(s)")
        if not deals:
            log("Nothing to sync.")
            state["last_sync"] = to.isoformat()
            save_state(state)
            return
        account = mt5.account_info().login
        xlsx = build_report_xlsx(account, deals)
        resp = push(cfg, xlsx)
        log(f"TradeNote response: {resp}")
        # Only advance the watermark once the push succeeded.
        state["last_sync"] = to.isoformat()
        save_state(state)
        notify_email(cfg, deals, resp)
        log("Done.")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
