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
import subprocess
import sys
import time
from email.message import EmailMessage

import requests

# Optional: the MetaTrader5 package is a Windows-only wheel bound to
# terminal64.dll, so it simply cannot be installed on macOS or Linux. Its absence
# is not fatal -- the bridge backend below reads the same data from a file the
# TradeNoteExport EA writes from inside the terminal, which works everywhere.
try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

import openpyxl


HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.ini")
STATE_PATH = os.path.join(HERE, "state.json")
BRIDGE_FILENAME = "tradenote_deals.json"
# How old the EA's file may be before the terminal counts as not running. The EA
# rewrites every 15s by default, so a minute of silence means it stopped.
BRIDGE_STALE_SECONDS = 90

# MT5 enum values, hard-coded so the rest of this file compares against them
# without needing the MetaTrader5 module imported. These are fixed parts of the
# MQL5 API (ENUM_DEAL_TYPE / ENUM_DEAL_ENTRY) and are what the EA writes out.
DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1
DEAL_TYPE_BALANCE = 2
DEAL_ENTRY_IN = 0
DEAL_ENTRY_OUT = 1


def log(msg):
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Backends
#
# Two ways to reach MT5, exposing the same handful of methods the rest of this
# file already calls on the MetaTrader5 module, so nothing downstream changes:
#
#   NativeBackend  Windows only. The MetaTrader5 package talking to the terminal
#                  directly. Unchanged behaviour.
#   BridgeBackend  Any platform. Reads the JSON that mql5/TradeNoteExport.mq5
#                  writes from inside the terminal. This is what makes macOS
#                  work at all: the Python package cannot be installed there, so
#                  the terminal pushes data out instead of Python reaching in.
# ---------------------------------------------------------------------------

class _Obj:
    """Attribute view over a dict, so bridge rows read like MetaTrader5's named
    tuples (d.time, d.type, d.profit, ...) and the existing code is agnostic."""

    def __init__(self, data):
        self.__dict__.update(data)


class NativeBackend:
    name = "MetaTrader5 package"

    def initialize(self, **kwargs):
        return mt5.initialize(**kwargs)

    def last_error(self):
        return mt5.last_error()

    def account_info(self):
        return mt5.account_info()

    def history_deals_get(self, frm, to):
        return mt5.history_deals_get(frm, to)

    def positions_get(self):
        return mt5.positions_get()

    def shutdown(self):
        mt5.shutdown()

    def terminal_running(self):
        return mt5_terminal_running()


class BridgeBackend:
    """Reads the EA's JSON export. Everything is served from the one file, so it
    is loaded once per run and then answered from memory."""

    name = "TradeNoteExport EA bridge file"

    def __init__(self, path=""):
        self._path = path
        self._data = None

    # -- discovery ---------------------------------------------------------
    @staticmethod
    def discover():
        """Find the EA's output file.

        Covers the layouts MT5 actually uses:
          - normal install: %APPDATA%/MetaQuotes/Terminal/<hash>/MQL5/Files
          - portable install (portable.txt): the data folder moves into the
            program folder, so MQL5/Files sits beside terminal64.exe and nothing
            lands under APPDATA at all
          - macOS: either of those, nested inside MT5's Wine bottle
          - the shared Terminal/Common/Files, if the EA is set to use it

        Newest mtime wins, so a live terminal beats a stale leftover copy."""
        import glob

        home = os.path.expanduser("~")
        patterns = []

        roots = []
        appdata = os.environ.get("APPDATA")
        if appdata:
            roots.append(appdata)
        roots += [
            os.path.join(home, "Library", "Application Support", "*", "drive_c",
                         "users", "*", "AppData", "Roaming"),
            os.path.join(home, ".wine", "drive_c", "users", "*", "AppData", "Roaming"),
        ]
        for root in roots:
            for tail in (("Terminal", "Common", "Files"), ("Terminal", "*", "MQL5", "Files")):
                patterns.append(os.path.join(root, "MetaQuotes", *tail, BRIDGE_FILENAME))

        # Portable installs: MQL5/Files lives under the program folder.
        for progs in (r"C:\Program Files", r"C:\Program Files (x86)",
                      os.path.join(home, "Library", "Application Support", "*",
                                   "drive_c", "Program Files"),
                      os.path.join(home, "Library", "Application Support", "*",
                                   "drive_c", "Program Files (x86)"),
                      os.path.join(home, ".wine", "drive_c", "Program Files")):
            patterns.append(os.path.join(progs, "*", "MQL5", "Files", BRIDGE_FILENAME))

        matches = []
        for pattern in patterns:
            matches.extend(glob.glob(pattern))
        return max(matches, key=os.path.getmtime) if matches else ""

    # -- MetaTrader5-shaped API -------------------------------------------
    def initialize(self, **kwargs):
        if not self._path:
            self._path = self.discover()
        if not self._path or not os.path.exists(self._path):
            return False
        try:
            with open(self._path, encoding="utf-8") as f:
                self._data = json.load(f)
        except (OSError, ValueError) as e:
            self._err = f"cannot read {self._path}: {e}"
            return False
        return True

    def last_error(self):
        return getattr(self, "_err", f"bridge file not found (looked for {BRIDGE_FILENAME})")

    def account_info(self):
        a = (self._data or {}).get("account") or {}
        return _Obj({
            "login": a.get("login", 0),
            "server": a.get("server", ""),
            "currency": a.get("currency", "USD"),
            "balance": float(a.get("balance", 0) or 0),
            "equity": float(a.get("equity", 0) or 0),
        })

    def history_deals_get(self, frm, to):
        """Same signature as the native call. The EA exports its own window, so
        this filters that down to the caller's range using the same broker-time
        stamps the native package returns."""
        frm_unix = frm.timestamp() if isinstance(frm, dt.datetime) else float(frm)
        to_unix = to.timestamp() if isinstance(to, dt.datetime) else float(to)
        out = []
        for d in (self._data or {}).get("deals", []):
            t = float(d.get("time", 0))
            if frm_unix <= t <= to_unix:
                out.append(_Obj({
                    "ticket": d.get("ticket", 0),
                    "time": int(t),
                    "type": int(d.get("type", -1)),
                    "entry": int(d.get("entry", -1)),
                    "symbol": d.get("symbol", ""),
                    "volume": float(d.get("volume", 0) or 0),
                    "price": float(d.get("price", 0) or 0),
                    "position_id": d.get("position_id", 0),
                    "commission": float(d.get("commission", 0) or 0),
                    "fee": float(d.get("fee", 0) or 0),
                    "swap": float(d.get("swap", 0) or 0),
                    "profit": float(d.get("profit", 0) or 0),
                    "comment": d.get("comment", ""),
                }))
        return out

    def positions_get(self):
        return [_Obj({"ticket": t, "identifier": t})
                for t in (self._data or {}).get("open_positions", [])]

    def shutdown(self):
        self._data = None

    def terminal_running(self):
        """The file's freshness IS the liveness signal: the EA rewrites it on a
        timer, so a stale file means the terminal (or the EA) is not running. A
        closed terminal must not look like an empty account, or the sync would
        push a snapshot showing zero balance."""
        if not self._path:
            self._path = self.discover()
        if not self._path or not os.path.exists(self._path):
            return False
        age = time.time() - os.path.getmtime(self._path)
        if age > BRIDGE_STALE_SECONDS:
            log(f"Bridge file is {int(age)}s old (limit {BRIDGE_STALE_SECONDS}s) "
                "-- MT5 or the TradeNoteExport EA is not running.")
            return False
        return True


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


def tradenote_up(cfg):
    """True if the TradeNote project (Docker/dev server) is running and reachable.
    Ties the whole sync to the app's lifecycle: when TradeNote is down we skip the
    run entirely -- before touching MT5 -- so nothing happens (and MT5 is never
    launched) unless the project is actually up."""
    try:
        url = cfg.get("tradenote", "url").rstrip("/")
        r = requests.get(url, timeout=5)
        return r.status_code < 500
    except Exception:  # noqa: BLE001 - any connection error means it's down
        return False


def mt5_terminal_running():
    """True if an MT5 terminal process is already open. Used to avoid mt5.initialize()
    auto-LAUNCHING the terminal on a schedule -- so closing MT5 actually stops the
    sync from popping it back open. If the check itself fails, assume running so a
    detection glitch never silently stops syncing."""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq terminal64.exe", "/NH"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return "terminal64.exe" in (out.stdout or "").lower()
    except Exception:  # noqa: BLE001
        return True


def pick_backend(cfg):
    """Native where the MetaTrader5 package exists (Windows), bridge file
    everywhere else. `[mt5] backend = native|bridge` in config.ini forces one --
    useful on Windows to test the bridge, or to point at a specific file."""
    choice = cfg.get("mt5", "backend", fallback="auto").strip().lower()
    bridge_file = cfg.get("mt5", "bridge_file", fallback="").strip()

    if choice == "native" or (choice in ("", "auto") and mt5 is not None):
        if mt5 is None:
            sys.exit("backend=native but the MetaTrader5 package is not installed "
                     "(it is Windows-only). Use backend=bridge with the "
                     "TradeNoteExport EA instead -- see mt5-sync/README.md.")
        return NativeBackend()
    return BridgeBackend(bridge_file)


def connect(cfg, backend):
    """Attach to MT5. Native: uses credentials if provided, otherwise the
    already-logged-in terminal session. Bridge: loads the EA's export."""
    login = cfg.get("mt5", "login", fallback="").strip()
    password = cfg.get("mt5", "password", fallback="").strip()
    server = cfg.get("mt5", "server", fallback="").strip()
    path = cfg.get("mt5", "terminal_path", fallback="").strip()

    kwargs = {}
    if isinstance(backend, NativeBackend):
        if path:
            kwargs["path"] = path
        if login and password and server:
            kwargs.update(login=int(login), password=password, server=server)

    ok = backend.initialize(**kwargs)
    if not ok:
        if isinstance(backend, NativeBackend):
            sys.exit(f"mt5.initialize failed: {backend.last_error()} "
                     "(open MT5 and log in, or set login/password/server in config.ini)")
        sys.exit(f"Bridge unavailable: {backend.last_error()}. Attach the "
                 "TradeNoteExport EA to a chart in MT5 (see mt5-sync/README.md), "
                 "or set [mt5] bridge_file in config.ini.")
    info = backend.account_info()
    log(f"Connected via {backend.name}: account {info.login} @ {info.server} ({info.currency})")
    return info


def fetch_deals(backend, frm, to):
    deals = backend.history_deals_get(frm, to)
    if deals is None:
        log(f"history_deals_get returned None: {backend.last_error()}")
        return []
    # Exclude deals belonging to positions that are STILL OPEN. Otherwise the
    # entry deal alone gets imported as an open trade, and when the position later
    # closes the re-import is dropped by TradeNote's dateUnix dedup — so the trade
    # stays stuck "open" and never shows its realised P&L. Import only complete
    # (closed) round-trips.
    open_positions = backend.positions_get() or []
    open_ids = {p.ticket for p in open_positions} | {getattr(p, "identifier", p.ticket) for p in open_positions}
    # Keep only actual trade deals (buy/sell) whose position has closed. Skip
    # balance/credit/correction entries too.
    return [d for d in deals
            if d.type in (DEAL_TYPE_BUY, DEAL_TYPE_SELL)
            and d.position_id not in open_ids]


def build_report_xlsx(account_login, server, deals):
    """Recreate the minimal MT5 'Trade History Report' structure TradeNote parses.
    Column order matters (positional): Time, Deal, Symbol, Type, Direction,
    Volume, Price, Order, Commission, Fee, Swap, Profit, Balance, Comment."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Trade History Report"])
    ws.append([])
    # TradeNote parses the account as the FIRST space-delimited token of this cell
    # (brokers.js: split(" ")[0]). Joining login + server with '@' (no spaces) makes
    # the whole "135174823@HFMarketsGlobal-Live8" survive as one account label, so
    # TradeNote's account filter shows both the MT5 number and the broker.
    ws.append(["Account:", f"{account_login}@{server}"])
    ws.append([])
    ws.append(["Deals"])
    ws.append(["Time", "Deal", "Symbol", "Type", "Direction", "Volume", "Price",
               "Order", "Commission", "Fee", "Swap", "Profit", "Balance", "Comment"])

    for d in deals:
        # d.time is broker-server time expressed as a UTC-based unix timestamp.
        # Reading it back in UTC (not the host's local tz) recovers the exact
        # broker wall-clock the MT5 terminal shows — e.g. 2026.07.24 21:37:28,
        # not 07.25 04:37 as datetime.fromtimestamp() would render on a UTC+7 box.
        # This keeps TradeNote's dates/times matching the terminal.
        ts = dt.datetime.fromtimestamp(d.time, dt.timezone.utc).strftime("%Y.%m.%d %H:%M:%S")
        side = "buy" if d.type == DEAL_TYPE_BUY else "sell"
        direction = "in" if d.entry == DEAL_ENTRY_IN else "out"
        # The "Order" column carries the MT5 position_id, so TradeNote can key each
        # position as its own trade (two overlapping same-symbol positions would
        # otherwise net into one). All deals of one position share position_id.
        ws.append([ts, str(d.ticket), d.symbol, side, direction,
                   float(d.volume), float(d.price), str(d.position_id),
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


def account_financials(backend):
    """Totals AND the individual dated deposits/withdrawals from the account's
    balance-type deals. Deposits are positive balance ops, withdrawals negative.
    The dated list lets TradeNote drop the equity curve on the day money left.

    Note for the bridge backend: this asks for all history since 2000, but the EA
    only exports its own LookbackDays window, so cash flows older than that window
    are not visible. Raise LookbackDays on the EA if you need the full history."""
    frm = dt.datetime(2000, 1, 1)
    to = dt.datetime.now() + dt.timedelta(days=2)
    deals = backend.history_deals_get(frm, to) or []
    deposit = sum(float(d.profit) for d in deals
                  if d.type == DEAL_TYPE_BALANCE and d.profit > 0)
    withdrawal = sum(-float(d.profit) for d in deals
                     if d.type == DEAL_TYPE_BALANCE and d.profit < 0)
    # d.time is a UTC-based unix timestamp (broker server time); keep it raw so the
    # frontend buckets it in the trade timezone, same as trades.
    cashflows = [
        {"t": int(d.time), "amount": float(d.profit),
         "type": "deposit" if d.profit > 0 else "withdrawal"}
        for d in deals if d.type == DEAL_TYPE_BALANCE and d.profit != 0
    ]
    return deposit, withdrawal, cashflows


def push_account(cfg, ai, deposit, withdrawal, cashflows=None):
    """Send the live account snapshot (balance/deposit/withdrawal/broker + dated
    cash flows) to TradeNote so the Dashboard can show it. Non-fatal: logged and
    swallowed."""
    try:
        url = cfg.get("tradenote", "url").rstrip("/") + "/api/account"
        api_key = cfg.get("tradenote", "api_key")
        body = {
            "login": ai.login,
            "server": ai.server,
            "currency": ai.currency,
            "balance": float(ai.balance),
            "deposit": deposit,
            "withdrawal": withdrawal,
            "cashFlows": cashflows or [],
        }
        r = requests.post(url, headers={"api-key": api_key, "Content-Type": "application/json"},
                          data=json.dumps(body), timeout=30)
        r.raise_for_status()
        log(f"Account snapshot pushed: balance={ai.balance} deposit={deposit:.2f} withdrawal={withdrawal:.2f}")
    except Exception as e:  # noqa: BLE001
        log(f"account snapshot push failed: {e}")


def _build_email_html(deals, total_profit, account_line, tradenote_url):
    """Render the reminder as a self-contained HTML email (inline styles only, so
    it renders the same in Gmail/Outlook which strip <style> blocks)."""
    rows = []
    for d in sorted(deals, key=lambda x: x.time):
        # UTC read = broker wall-clock, matching the terminal and TradeNote.
        when = dt.datetime.fromtimestamp(d.time, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        side = "BUY" if d.type == DEAL_TYPE_BUY else "SELL"
        side_color = "#16a34a" if d.type == DEAL_TYPE_BUY else "#dc2626"
        leg = "in" if d.entry == DEAL_ENTRY_IN else ("out" if d.entry == DEAL_ENTRY_OUT else "—")
        p = float(d.profit)
        p_color = "#16a34a" if p > 0 else ("#dc2626" if p < 0 else "#6b7280")
        rows.append(f"""
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;color:#6b7280;font-variant-numeric:tabular-nums;white-space:nowrap;">{when}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;font-weight:600;color:#111827;">{d.symbol}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;"><span style="color:{side_color};font-weight:700;">{side}</span> <span style="color:#9ca3af;font-size:12px;">{leg}</span></td>
            <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;text-align:right;color:#111827;font-variant-numeric:tabular-nums;">{float(d.volume):g}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;text-align:right;color:#111827;font-variant-numeric:tabular-nums;">{float(d.price):.2f}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;text-align:right;font-weight:600;color:{p_color};font-variant-numeric:tabular-nums;">{p:+.2f}</td>
          </tr>""")

    total_color = "#16a34a" if total_profit > 0 else ("#dc2626" if total_profit < 0 else "#6b7280")
    cta = (f'<a href="{tradenote_url}" style="display:inline-block;background:#4f46e5;color:#ffffff;'
           f'text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px;font-size:14px;">'
           f'Open TradeNote →</a>') if tradenote_url else ""

    return f"""\
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <div style="display:none;max-height:0;overflow:hidden;">{len(deals)} new MT5 deal(s) synced — total {total_profit:+.2f}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:22px 28px;">
          <div style="color:#e0e7ff;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">TradeNote · MT5 Sync</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">{len(deals)} new deal(s) synced</div>
          <div style="color:#c7d2fe;font-size:13px;margin-top:6px;">{account_line}</div>
        </td></tr>
        <tr><td style="padding:20px 28px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef0f3;border-radius:10px;border-collapse:separate;overflow:hidden;">
            <thead><tr style="background:#fafbfc;">
              <th style="padding:9px 12px;text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;">Time</th>
              <th style="padding:9px 12px;text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;">Symbol</th>
              <th style="padding:9px 12px;text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;">Side</th>
              <th style="padding:9px 12px;text-align:right;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;">Vol</th>
              <th style="padding:9px 12px;text-align:right;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;">Price</th>
              <th style="padding:9px 12px;text-align:right;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;">Profit</th>
            </tr></thead>
            <tbody>{''.join(rows)}
              <tr><td colspan="5" style="padding:10px 12px;text-align:right;font-weight:600;color:#374151;">Total (raw deals)</td>
                  <td style="padding:10px 12px;text-align:right;font-weight:700;color:{total_color};font-variant-numeric:tabular-nums;">{total_profit:+.2f}</td></tr>
            </tbody>
          </table>
        </td></tr>
        <tr><td style="padding:8px 28px 4px;">
          <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:6px;">Finish your journal</div>
          <div style="font-size:13px;color:#4b5563;line-height:1.7;">
            📸 Add screenshots of your setups<br>
            📝 Write your notes / journaling<br>
            🏷️ Tag your strategy &amp; satisfaction
          </div>
        </td></tr>
        <tr><td style="padding:18px 28px 26px;">{cta}</td></tr>
        <tr><td style="padding:14px 28px;background:#fafbfc;border-top:1px solid #eef0f3;">
          <div style="font-size:11px;color:#9ca3af;">Automated by the MT5 → TradeNote sync. You receive this only when new deals close.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def notify_email(cfg, deals, resp, account_info=None):
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

    # Summarise the synced deals for the reminder.
    symbols = {}
    total_profit = 0.0
    for d in deals:
        symbols[d.symbol] = symbols.get(d.symbol, 0) + 1
        total_profit += float(d.profit)
    sym_line = ", ".join(f"{s} ({n})" for s, n in sorted(symbols.items())) or "-"
    count = len(deals)
    tradenote_url = cfg.get("tradenote", "url", fallback="").rstrip("/")

    if account_info is not None:
        account_line = (f"Account {account_info.login} @ {account_info.server} "
                        f"({account_info.currency})")
    else:
        account_line = "MetaTrader 5"

    subject = f"TradeNote: {count} new MT5 deal(s) synced ({total_profit:+.2f})"

    # Plain-text fallback for clients that don't render HTML.
    text_body = "\n".join([
        f"{count} new deal(s) were just synced from MetaTrader 5 into TradeNote.",
        account_line,
        "",
        f"Symbols: {sym_line}",
        f"Total profit (raw deals): {total_profit:+.2f}",
        "",
        "Reminder - open TradeNote and finish these trades:",
        "  - add screenshots of your setups",
        "  - write your notes / journaling",
        "  - tag your strategy and satisfaction",
        "",
        f"TradeNote: {tradenote_url}" if tradenote_url else "",
    ]).strip()

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    msg.set_content(text_body)
    msg.add_alternative(
        _build_email_html(deals, total_profit, account_line, tradenote_url),
        subtype="html",
    )

    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            s.login(sender, app_password)
            s.send_message(msg)
        log(f"notify: reminder email sent to {recipient}")
    except Exception as e:  # noqa: BLE001 - never let email break the sync
        log(f"notify: failed to send email: {e}")


def parse_args():
    """--lookback-days / --force exist for RECOVERY runs. The scheduled every-minute
    sync uses the config's small window and the watermark, which is right for steady
    state but means a day that was stored wrong can never be revisited once it falls
    out of that window. Re-importing a wide window rebuilds those days from the
    broker's own history:  python mt5_sync.py --lookback-days 60 --force"""
    import argparse
    p = argparse.ArgumentParser(description="MT5 -> TradeNote sync")
    p.add_argument("--lookback-days", type=int, default=None,
                   help="override [sync] lookback_days for this run (recovery)")
    p.add_argument("--force", action="store_true",
                   help="push even when no deal is newer than the stored watermark")
    return p.parse_args()


def main():
    args = parse_args()
    cfg = load_config()
    state = load_state()

    # Bind the sync to the project's lifecycle: do nothing (and never touch/launch
    # MT5) unless TradeNote is actually running. Stop the project -> sync stops.
    if not tradenote_up(cfg):
        log("TradeNote not reachable -- skipping (sync only runs while the project is up).")
        return

    # --- Sliding window, not a moving watermark --------------------------------
    # Two facts drive this design:
    #
    # 1. MT5 returns deal times in *broker-server* time, which the API hands back
    #    ahead of the host clock (HFMarkets is UTC+3, so a trade the terminal shows
    #    at 21:37 comes back as ~04:37 next day on a UTC+7 host). If we cap the
    #    query at the host's "now", the newest deals sit just beyond it and are
    #    never pulled -- which is exactly why nothing showed up. So the upper bound
    #    is padded two days into the future; the lower bound is a fixed lookback.
    #
    # 2. TradeNote dedups imports by dateUnix (see useImportTrades), so re-sending
    #    the same window every run never creates duplicates, and always re-pairs a
    #    trade's open+close deals even when they landed in different runs. That
    #    makes a fixed sliding window both correct and self-healing -- a failed run
    #    is simply recovered by the next one, with no watermark to corrupt.
    #
    # We still keep a watermark ("last_deal_unix", the newest deal time pushed) but
    # use it ONLY to detect whether anything new arrived -- so a 1-minute schedule
    # doesn't push (or email) on every tick when nothing has changed.
    lookback_days = args.lookback_days if args.lookback_days is not None else cfg.getint("sync", "lookback_days", fallback=2)
    now = dt.datetime.now()
    frm = now - dt.timedelta(days=lookback_days)
    to = now + dt.timedelta(days=2)
    last_deal_unix = 0 if args.force else int(state.get("last_deal_unix", 0))
    log(f"Sync window (sliding): {frm:%Y-%m-%d %H:%M} -> {to:%Y-%m-%d %H:%M}")

    backend = pick_backend(cfg)

    # Don't wake a closed terminal. mt5.initialize() would auto-launch MT5 if it's
    # not running, so a 1-minute schedule kept re-opening it after you closed it.
    # Skip the run instead; syncing resumes automatically once MT5 is open again.
    # The bridge backend answers this from the export file's age instead.
    if not backend.terminal_running():
        log("MT5 terminal not running -- skipping (won't auto-launch it).")
        return

    connect(cfg, backend)
    try:
        # Always refresh the account snapshot (balance/deposit/withdrawal) so the
        # Dashboard stays current even on ticks with no new trades.
        ai = backend.account_info()
        deposit, withdrawal, cashflows = account_financials(backend)
        push_account(cfg, ai, deposit, withdrawal, cashflows)

        deals = fetch_deals(backend, frm, to)
        new_deals = [d for d in deals if d.time > last_deal_unix]
        log(f"Fetched {len(deals)} trade deal(s) in window, {len(new_deals)} new")
        if not new_deals:
            log("Nothing new to sync.")
            return
        # Push the FULL window (not just the new deals) so TradeNote always sees
        # both legs of every trade and can pair them; its dateUnix dedup drops the
        # ones already stored.
        xlsx = build_report_xlsx(ai.login, ai.server, deals)
        resp = push(cfg, xlsx)
        log(f"TradeNote response: {resp}")
        # Advance the watermark to the newest deal we've now pushed.
        state["last_deal_unix"] = max(d.time for d in deals)
        save_state(state)
        # Email reminder disabled for now (not needed yet). Re-enable by
        # uncommenting the call below; the notify_email() helper and its
        # [notify] config are left in place.
        # Email summarises only the genuinely new deals, not the whole window.
        # notify_email(cfg, new_deals, resp, ai)
        log("Done.")
    finally:
        backend.shutdown()


if __name__ == "__main__":
    main()
