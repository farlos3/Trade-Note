//+------------------------------------------------------------------+
//|                                            TradeNoteExport.mq5   |
//|  Exports closed deals, the account snapshot, open positions and    |
//|  dated balance operations to a JSON file that mt5-sync/ reads:     |
//|  mt5_sync.py takes the history, mt5_live.py takes the positions.   |
//|                                                                   |
//|  Why this exists: the official `MetaTrader5` Python package is a   |
//|  Windows-only wheel that binds to terminal64.dll, so on macOS the  |
//|  sync has no way to talk to MT5 at all. MQL5 runs *inside* the     |
//|  terminal on every platform, so the terminal pushes the data out   |
//|  instead of Python reaching in.                                    |
//|                                                                   |
//|  Read-only: queries history and account state, never trades.       |
//+------------------------------------------------------------------+
#property copyright "TradeNote"
#property version   "1.01"
#property strict

// Also the refresh rate of the Live page on macOS, where this file is the only
// source of open-position data -- opens and closes are pushed immediately by
// OnTrade, but a moving floating P&L only updates this often. Lower it for a
// smoother Live page; the write is a few KB, so a handful of seconds is cheap.
input int    ExportIntervalSeconds = 5;                      // how often to refresh the file
input int    LookbackDays          = 7;                      // window of history to export
input string OutFileName           = "tradenote_deals.json"; // name of the exported file
// false -> <data folder>/MQL5/Files, which is deterministic in every install
// mode. Portable installs (portable.txt) move the data folder into the program
// folder and the Common folder is not reliably reachable there, so
// terminal-local is the safer default. The Python side searches both.
input bool   UseCommonFolder       = false;                  // true -> Terminal/Common/Files

int CommonFlag() { return UseCommonFolder ? FILE_COMMON : 0; }

//+------------------------------------------------------------------+
//| JSON string escaping. Symbols and comments are broker-controlled  |
//| text, so quotes/backslashes in them must not break the document.  |
//+------------------------------------------------------------------+
string JsonEscape(const string s)
{
   string out = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c == '"')            out += "\\\"";
      else if(c == '\\')      out += "\\\\";
      else if(c == '\n')      out += "\\n";
      else if(c == '\r')      out += "\\r";
      else if(c == '\t')      out += "\\t";
      else if(c < 0x20)       out += StringFormat("\\u%04x", c);
      else                    out += ShortToString(c);
   }
   return out;
}

//+------------------------------------------------------------------+
//| Numbers are written with enough precision for money and lots, and |
//| never in scientific notation -- json.loads handles plain decimals |
//| identically on every platform.                                    |
//+------------------------------------------------------------------+
string Num(const double v, const int digits = 8)
{
   return DoubleToString(v, digits);
}

//+------------------------------------------------------------------+
string BuildJson()
{
   datetime to   = TimeCurrent() + 2 * 24 * 60 * 60;   // pad ahead: broker time can lead the host clock
   datetime from = TimeCurrent() - (datetime)LookbackDays * 24 * 60 * 60;

   if(!HistorySelect(from, to))
      return "";

   string json = "{\n";

   // ---- account ----------------------------------------------------------
   json += "  \"account\": {";
   json += "\"login\": "     + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   json += ", \"server\": \"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\"";
   json += ", \"currency\": \"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\"";
   json += ", \"balance\": "  + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2);
   json += ", \"equity\": "   + Num(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   // Floating P&L and margin: the Live page shows these next to equity, and only
   // the terminal can compute them (they depend on current prices, not history).
   json += ", \"profit\": "      + Num(AccountInfoDouble(ACCOUNT_PROFIT), 2);
   json += ", \"margin\": "      + Num(AccountInfoDouble(ACCOUNT_MARGIN), 2);
   json += ", \"margin_free\": " + Num(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   json += "},\n";

   // ---- open positions ---------------------------------------------------
   // Two shapes of the same thing, because two consumers want different halves:
   //   open_positions  bare tickets. mt5_sync.py drops deals whose position is
   //                   still open, so a half-filled round trip is never imported
   //                   as a finished trade. It only needs to ask "is this open?".
   //   positions       full detail + current price. mt5_live.py streams this to
   //                   /api/live for the Live page. On Windows that data comes
   //                   from the MetaTrader5 package instead; on macOS there is no
   //                   such package, so it has to come through here.
   // Kept as two keys rather than one so that an older mt5_sync.py, which reads
   // open_positions as a list of ints, keeps working against a newer EA.
   json += "  \"open_positions\": [";
   int totalPos = PositionsTotal();
   bool firstPos = true;
   for(int i = 0; i < totalPos; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!firstPos) json += ", ";
      json += IntegerToString((long)ticket);
      firstPos = false;
   }
   json += "],\n";

   json += "  \"positions\": [";
   bool firstDet = true;
   for(int i = 0; i < totalPos; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      if(!firstDet) json += ", ";
      json += "{\"ticket\": "     + IntegerToString((long)ticket);
      json += ", \"symbol\": \""  + JsonEscape(sym) + "\"";
      // POSITION_TYPE matches DEAL_TYPE for buy/sell: 0 = buy, 1 = sell.
      json += ", \"type\": "      + IntegerToString(PositionGetInteger(POSITION_TYPE));
      json += ", \"volume\": "    + Num(PositionGetDouble(POSITION_VOLUME));
      json += ", \"price_open\": "    + Num(PositionGetDouble(POSITION_PRICE_OPEN));
      json += ", \"price_current\": " + Num(PositionGetDouble(POSITION_PRICE_CURRENT));
      json += ", \"sl\": "        + Num(PositionGetDouble(POSITION_SL));
      json += ", \"tp\": "        + Num(PositionGetDouble(POSITION_TP));
      json += ", \"profit\": "    + Num(PositionGetDouble(POSITION_PROFIT), 2);
      json += ", \"swap\": "      + Num(PositionGetDouble(POSITION_SWAP), 2);
      json += ", \"time\": "      + IntegerToString(PositionGetInteger(POSITION_TIME));
      // Bid/ask for the symbol, so the Live page can show the spread without
      // needing a second data source.
      MqlTick tick;
      if(SymbolInfoTick(sym, tick))
      {
         json += ", \"bid\": " + Num(tick.bid);
         json += ", \"ask\": " + Num(tick.ask);
      }
      json += "}";
      firstDet = false;
   }
   json += "],\n";

   // ---- deals ------------------------------------------------------------
   // Every deal in the window, including DEAL_TYPE_BALANCE (deposits and
   // withdrawals): the Python side needs those for the cash-flow tiles and the
   // Plan vs Actual chart marks, and filters the rest by type itself.
   json += "  \"deals\": [\n";
   int total = HistoryDealsTotal();
   bool first = true;
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;

      long dtype  = HistoryDealGetInteger(ticket, DEAL_TYPE);
      long dentry = HistoryDealGetInteger(ticket, DEAL_ENTRY);

      if(!first) json += ",\n";
      json += "    {";
      json += "\"ticket\": "      + IntegerToString((long)ticket);
      json += ", \"time\": "      + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_TIME));
      json += ", \"type\": "      + IntegerToString(dtype);
      json += ", \"entry\": "     + IntegerToString(dentry);
      json += ", \"symbol\": \""  + JsonEscape(HistoryDealGetString(ticket, DEAL_SYMBOL)) + "\"";
      json += ", \"volume\": "    + Num(HistoryDealGetDouble(ticket, DEAL_VOLUME));
      json += ", \"price\": "     + Num(HistoryDealGetDouble(ticket, DEAL_PRICE));
      json += ", \"position_id\": " + IntegerToString(HistoryDealGetInteger(ticket, DEAL_POSITION_ID));
      json += ", \"commission\": " + Num(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2);
      json += ", \"fee\": "       + Num(HistoryDealGetDouble(ticket, DEAL_FEE), 2);
      json += ", \"swap\": "      + Num(HistoryDealGetDouble(ticket, DEAL_SWAP), 2);
      json += ", \"profit\": "    + Num(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2);
      json += ", \"comment\": \"" + JsonEscape(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\"";
      json += "}";
      first = false;
   }
   json += "\n  ],\n";

   // ---- balance operations, FULL account history -------------------------
   // Deposits and withdrawals must be complete, not windowed: the Dashboard and
   // Plan vs Actual show lifetime totals, and a 7-day window would report only
   // the most recent top-up. Re-selecting the whole history is cheap here because
   // an account has a handful of these, versus thousands of trade deals -- which
   // is why they are exported separately instead of just widening LookbackDays.
   json += "  \"balance_ops\": [";
   bool firstBal = true;
   if(HistorySelect(0, TimeCurrent() + 2 * 24 * 60 * 60))
   {
      int totalBal = HistoryDealsTotal();
      for(int i = 0; i < totalBal; i++)
      {
         ulong ticket = HistoryDealGetTicket(i);
         if(ticket == 0) continue;
         if(HistoryDealGetInteger(ticket, DEAL_TYPE) != DEAL_TYPE_BALANCE) continue;
         double profit = HistoryDealGetDouble(ticket, DEAL_PROFIT);
         if(profit == 0) continue;
         if(!firstBal) json += ", ";
         json += "{\"time\": "   + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_TIME));
         json += ", \"profit\": " + Num(profit, 2);
         json += ", \"comment\": \"" + JsonEscape(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\"}";
         firstBal = false;
      }
   }
   json += "],\n";

   // ---- broker clock offset ------------------------------------------------
   // Every timestamp above is MT5 server time, NOT UTC: TimeCurrent() on a UTC+3
   // broker reads 12:41 for an event that happened at 09:41 UTC. Downstream those
   // numbers are treated as real unix timestamps, so without this they land three
   // hours into the future and every trade is displayed three hours late.
   //
   // The terminal is the only thing that knows the offset -- it changes with the
   // broker's own DST, not the host's -- so it is exported rather than configured,
   // and the Python side subtracts it. Rounded to the minute because TimeGMT() and
   // TimeCurrent() are sampled a moment apart.
   long gmtOffset = (long)TimeCurrent() - (long)TimeGMT();
   gmtOffset = (long)MathRound((double)gmtOffset / 60.0) * 60;
   json += "  \"gmt_offset\": " + IntegerToString(gmtOffset) + ",\n";

   json += "  \"exported_at\": " + IntegerToString((long)TimeCurrent()) + "\n";
   json += "}\n";
   return json;
}

//+------------------------------------------------------------------+
//| Write to a temp file then rename over the target, so the Python   |
//| reader never observes a half-written document.                    |
//+------------------------------------------------------------------+
bool WriteJson(const string json)
{
   if(StringLen(json) == 0) return false;

   string tmpName = OutFileName + ".tmp";
   int h = FileOpen(tmpName, FILE_WRITE | FILE_BIN | CommonFlag());
   if(h == INVALID_HANDLE)
   {
      Print("TradeNoteExport: cannot open ", tmpName, " err=", GetLastError());
      return false;
   }
   // UTF-8 bytes, no BOM: json.loads() in Python expects plain UTF-8.
   uchar bytes[];
   int len = StringToCharArray(json, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) len--;                       // drop the trailing NUL StringToCharArray adds
   if(len > 0) FileWriteArray(h, bytes, 0, len);
   FileClose(h);

   if(!FileMove(tmpName, CommonFlag(), OutFileName, CommonFlag() | FILE_REWRITE))
   {
      Print("TradeNoteExport: cannot move temp into place err=", GetLastError());
      return false;
   }
   return true;
}

void ExportNow()
{
   if(WriteJson(BuildJson()))
      Comment("TradeNote export: ", TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS));
}

//+------------------------------------------------------------------+
int OnInit()
{
   EventSetTimer(ExportIntervalSeconds < 1 ? 1 : ExportIntervalSeconds);
   ExportNow();                              // don't make the first sync wait a full interval
   Print("TradeNoteExport running. Writing ", OutFileName,
         UseCommonFolder ? " to the Common Files folder" : " to this terminal's MQL5/Files",
         " every ", ExportIntervalSeconds, "s.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTimer() { ExportNow(); }

// A closing deal lands in history on a trade transaction, so export immediately
// instead of waiting up to ExportIntervalSeconds for the timer.
void OnTrade() { ExportNow(); }
