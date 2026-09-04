//+------------------------------------------------------------------+
//|                                          TradeNoteBreakEven.mq5   |
//|  The price at which every open position on this chart's symbol,   |
//|  taken together, is worth exactly 0.00.                           |
//|                                                                   |
//|  Why: once a symbol carries more than one entry -- an average-in,  |
//|  a partial close, a hedge left half-unwound -- the per-position    |
//|  P&L the terminal shows no longer answers the only question that   |
//|  matters while the basket is open: where does the market have to   |
//|  be for me to walk away flat? Doing that arithmetic by hand, in a  |
//|  drawdown, is exactly when it gets done wrong.                     |
//|                                                                   |
//|  Read-only: reads positions, symbol properties and deal history,   |
//|  and draws. It cannot place, modify or close an order -- being an  |
//|  indicator rather than an EA is the point, not an accident.        |
//+------------------------------------------------------------------+
#property copyright "TradeNote"
#property version   "1.00"
#property strict
#property indicator_chart_window
#property indicator_buffers 0
#property indicator_plots   0

input bool   IncludeSwap        = true;      // count swap already charged
input bool   IncludeCommission  = true;      // count entry commission already charged
input double ExitCostPerLot     = 0.0;       // commission the CLOSE will still cost, per lot
input color  LineColor          = clrGold;   // break-even line
input int    LineWidth          = 1;         // break-even line width
input bool   ShowPanel          = true;      // numbers in the chart corner
input int    PanelCorner        = 0;         // 0 upper-left 1 upper-right 2 lower-left 3 lower-right
input int    PanelXDistance     = 12;        // panel offset from that corner, px
input int    PanelYDistance     = 18;

#define PREFIX "TN_BE_"
#define LINE_NAME PREFIX "line"

// Entry commission is charged on the position's DEALS, not on the position, so it
// costs a history lookup to read. It also cannot change once the position is open,
// so each position is looked up once and remembered -- without this the indicator
// would re-scan deal history for every position on every tick. Keyed by the
// position IDENTIFIER, which is what deals are filed under (the same value as the
// ticket on a hedging account, not necessarily on a netting one).
ulong  g_commTickets[];
double g_commValues[];

//+------------------------------------------------------------------+
//| Commission already charged on one position's entry deal(s).       |
//+------------------------------------------------------------------+
double EntryCommission(const ulong posId)
{
   for(int i = 0; i < ArraySize(g_commTickets); i++)
      if(g_commTickets[i] == posId)
         return g_commValues[i];

   double total = 0.0;
   if(HistorySelectByPosition(posId))
   {
      int deals = HistoryDealsTotal();
      for(int i = 0; i < deals; i++)
      {
         ulong deal = HistoryDealGetTicket(i);
         if(deal == 0) continue;
         if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
         total += HistoryDealGetDouble(deal, DEAL_COMMISSION);
      }
   }

   int n = ArraySize(g_commTickets);
   ArrayResize(g_commTickets, n + 1);
   ArrayResize(g_commValues,  n + 1);
   g_commTickets[n] = posId;
   g_commValues[n]  = total;
   return total;
}

//+------------------------------------------------------------------+
//| One pip in price terms, matching how the journal counts them      |
//| (src/utils/addOrder.js): a pip is ten points on the 3- and        |
//| 5-digit quotes brokers pad, and the point itself everywhere else  |
//| -- so gold moves in 0.01 pips and EURUSD in 0.0001.               |
//+------------------------------------------------------------------+
double PipSize(const string sym)
{
   int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
   return (digits == 3 || digits == 5) ? point * 10.0 : point;
}

//+------------------------------------------------------------------+
//| The whole calculation, in one pass over the open positions.       |
//|                                                                   |
//| Every position on the symbol is worth a straight line in the      |
//| closing price, so the basket is one too, and the break-even is    |
//| just where that line crosses zero -- no search, no iteration.     |
//|                                                                   |
//| Working in the BID, with the ASK carried as bid+spread, because    |
//| that is how the two sides actually close: a long is closed at the  |
//| bid, a short at the ask. Treating both as one price would put the  |
//| answer out by the spread on every hedged lot.                      |
//|                                                                   |
//|   long  i:  P&L = (bid - open_i)         * vol_i * valuePerPrice   |
//|   short i:  P&L = (open_i - bid - spread) * vol_i * valuePerPrice  |
//|                                                                   |
//| Summed:  P&L(bid) = valuePerPrice * (bid * net + K) + costs        |
//| so       bid_BE   = -(K + costs / valuePerPrice) / net             |
//|                                                                   |
//| `net` is signed lots. At zero the basket is perfectly hedged: its  |
//| P&L is the same at every price, so there is no break-even to draw  |
//| and saying so is the honest answer.                                |
//+------------------------------------------------------------------+
struct BasketState
{
   int    count;          // positions counted
   double netLots;        // + long, - short
   double grossLots;      // total size on the symbol, both sides
   double costs;          // swap + commission, in account currency (negative = paid)
   double floating;       // P&L right now, terminal's own numbers + costs
   double breakEven;      // bid price where floating becomes 0
   bool   hasBreakEven;   // false when the basket is flat-hedged
};

bool ReadBasket(const string sym, BasketState &out)
{
   double tickSize  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0.0 || tickValue <= 0.0)
      return false;
   // Account currency earned per lot per whole unit of price.
   double valuePerPrice = tickValue / tickSize;

   double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
   double spread = (ask > bid) ? ask - bid : 0.0;

   out.count = 0; out.netLots = 0.0; out.grossLots = 0.0;
   out.costs = 0.0; out.floating = 0.0;
   out.breakEven = 0.0; out.hasBreakEven = false;

   double k = 0.0;    // the constant term of the basket's P&L line

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != sym) continue;

      ulong  posId = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
      long   type = PositionGetInteger(POSITION_TYPE);
      double vol  = PositionGetDouble(POSITION_VOLUME);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);

      double cost = 0.0;
      if(IncludeSwap)       cost += PositionGetDouble(POSITION_SWAP);
      if(IncludeCommission) cost += EntryCommission(posId);
      // Charged on the way out, so it is not in the terminal's P&L yet -- but it
      // is owed, and a break-even that ignores it is a small loss dressed as flat.
      cost -= ExitCostPerLot * vol;

      if(type == POSITION_TYPE_BUY)
      {
         out.netLots += vol;
         k           -= vol * open;
      }
      else
      {
         out.netLots -= vol;
         k           += vol * (open - spread);
      }

      out.grossLots += vol;
      out.costs     += cost;
      out.floating  += PositionGetDouble(POSITION_PROFIT) + cost;
      out.count++;
   }

   if(out.count == 0)
      return true;

   // "Flat" has to be judged against the smallest size the broker deals in: on a
   // 0.01-lot symbol, 0.30 long against 0.30 short is hedged, and floating-point
   // subtraction will not hand back an exact zero to test for.
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = 0.01;
   if(MathAbs(out.netLots) < step / 2.0)
      return true;                      // hedged flat: P&L is the same at every price

   out.breakEven    = -(k + out.costs / valuePerPrice) / out.netLots;
   out.hasBreakEven = true;
   return true;
}

//+------------------------------------------------------------------+
//| Drawing                                                          |
//+------------------------------------------------------------------+
void DrawLine(const double price)
{
   if(ObjectFind(0, LINE_NAME) < 0)
   {
      ObjectCreate(0, LINE_NAME, OBJ_HLINE, 0, 0, price);
      ObjectSetInteger(0, LINE_NAME, OBJPROP_STYLE, STYLE_DASH);
      ObjectSetInteger(0, LINE_NAME, OBJPROP_BACK, true);
      ObjectSetInteger(0, LINE_NAME, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, LINE_NAME, OBJPROP_HIDDEN, true);
   }
   ObjectSetDouble(0, LINE_NAME, OBJPROP_PRICE, price);
   ObjectSetInteger(0, LINE_NAME, OBJPROP_COLOR, LineColor);
   ObjectSetInteger(0, LINE_NAME, OBJPROP_WIDTH, LineWidth);
}

void SetLabel(const int row, const string text, const color clr)
{
   string name = PREFIX "lbl" + IntegerToString(row);
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, PanelCorner);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, PanelXDistance);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, PanelYDistance + row * 16);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
   }
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
}

void ClearPanel(const int fromRow)
{
   for(int row = fromRow; row < 8; row++)
      ObjectDelete(0, PREFIX "lbl" + IntegerToString(row));
}

//+------------------------------------------------------------------+
//| Recalculate and redraw. Called on every tick AND on a one-second  |
//| timer: opening or closing a position does not itself produce a    |
//| tick, and a break-even line that only moves when the market does  |
//| would sit at the old basket's level for as long as the market is  |
//| quiet -- which is exactly when it gets trusted.                   |
//+------------------------------------------------------------------+
void Refresh()
{
   string sym = _Symbol;
   BasketState b;
   if(!ReadBasket(sym, b))
   {
      ObjectDelete(0, LINE_NAME);
      if(ShowPanel) SetLabel(0, "Break-even: symbol data unavailable", clrSilver);
      ClearPanel(1);
      ChartRedraw();
      return;
   }

   int    digits  = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double pip     = PipSize(sym);
   string account = AccountInfoString(ACCOUNT_CURRENCY);

   if(b.count == 0)
   {
      ObjectDelete(0, LINE_NAME);
      if(ShowPanel)
      {
         SetLabel(0, "No open " + sym + " positions", clrSilver);
         ClearPanel(1);
      }
      else ClearPanel(0);
      ChartRedraw();
      return;
   }

   if(!b.hasBreakEven)
   {
      // Fully hedged: the basket's P&L is frozen, so there is no price to draw.
      // Saying that is the answer -- an omitted line reads as "not calculated".
      ObjectDelete(0, LINE_NAME);
      if(ShowPanel)
      {
         SetLabel(0, StringFormat("%s  %d positions  %.2f lots hedged flat",
                                  sym, b.count, b.grossLots), clrSilver);
         SetLabel(1, StringFormat("P&L locked at %.2f %s -- no break-even price",
                                  b.floating, account),
                  b.floating >= 0 ? clrLimeGreen : clrTomato);
         ClearPanel(2);
      }
      else ClearPanel(0);
      ChartRedraw();
      return;
   }

   DrawLine(b.breakEven);

   if(ShowPanel)
   {
      double bid      = SymbolInfoDouble(sym, SYMBOL_BID);
      double distance = (b.breakEven - bid) / pip;   // + = price must rise
      SetLabel(0, StringFormat("%s  %d positions  net %+.2f lots (%.2f gross)",
                               sym, b.count, b.netLots, b.grossLots), clrSilver);
      SetLabel(1, "Break-even  " + DoubleToString(b.breakEven, digits) +
                  StringFormat("   %+.1f pips away", distance), LineColor);
      SetLabel(2, StringFormat("Floating   %+.2f %s", b.floating, account),
               b.floating >= 0 ? clrLimeGreen : clrTomato);
      SetLabel(3, StringFormat("Costs      %+.2f %s (swap + commission)",
                               b.costs, account), clrSilver);
      ClearPanel(4);
   }
   else ClearPanel(0);

   ChartRedraw();
}

//+------------------------------------------------------------------+
int OnInit()
{
   IndicatorSetString(INDICATOR_SHORTNAME, "TradeNote Break-Even");
   ArrayResize(g_commTickets, 0);
   ArrayResize(g_commValues, 0);
   EventSetTimer(1);
   Refresh();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   ObjectsDeleteAll(0, PREFIX);
   ChartRedraw();
}

void OnTimer()
{
   Refresh();
}

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   Refresh();
   return(rates_total);
}
//+------------------------------------------------------------------+
