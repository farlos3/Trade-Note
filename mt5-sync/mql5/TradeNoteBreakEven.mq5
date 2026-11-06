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
//|  It also draws the account's DEAD POINT: the price at which the    |
//|  broker's stop-out fires and closes positions for you. A basket    |
//|  that has been averaged or hedged out of a loss is exactly the one |
//|  that drifts toward it, and the break-even line alone says nothing |
//|  about how much room is left before that happens.                  |
//|                                                                   |
//|  And it can answer BEFORE you act: set PlanSide and PlanLots to the |
//|  recovery order you are considering and it draws where the         |
//|  break-even and the dead point would move if you opened it now.    |
//|                                                                   |
//|  Read-only: reads positions, symbol properties and deal history,   |
//|  and draws. It cannot place, modify or close an order -- being an  |
//|  indicator rather than an EA is the point, not an accident.        |
//+------------------------------------------------------------------+
#property copyright "TradeNote"
#property version   "1.02"
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
input bool   ShowDeadPoint      = true;      // also draw the stop-out ("dead") price
input color  DeadColor          = clrTomato; // dead-point line
input int    DeadLineWidth      = 1;         // dead-point line width

// What-if: a recovery order you are only CONSIDERING. Nothing is sent; the order is
// added to the basket in the arithmetic only. Change these in the indicator's
// properties (Inputs tab) and the lines move at once. PLAN_NONE turns it off.
enum PlanSideEnum { PLAN_NONE = 0, PLAN_BUY = 1, PLAN_SELL = 2 };
input PlanSideEnum PlanSide         = PLAN_NONE; // what-if order: side
input double PlanLots               = 0.0;       // what-if order: lots
input double PlanEntryCostPerLot    = 0.0;       // what-if order: commission the OPEN will charge, per lot
input color  PlanColor              = clrDeepSkyBlue; // what-if lines

#define PREFIX "TN_BE_"
#define LINE_NAME PREFIX "line"
#define DEAD_NAME PREFIX "dead"
#define PLAN_BE_NAME   PREFIX "plan_be"
#define PLAN_DEAD_NAME PREFIX "plan_dead"

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
   double valuePerPrice;  // account currency per lot per whole unit of price
   double bid;            // the bid this snapshot was taken at
   double k;              // constant term of the basket's P&L line (see ReadBasket)
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
   out.valuePerPrice = valuePerPrice; out.bid = bid; out.k = 0.0;

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

   out.k = k;
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
//| The DEAD POINT: where the broker's stop-out fires.                |
//|                                                                   |
//| Equity moves in a straight line with this symbol's price, and its  |
//| slope is the net exposure -- longs gain and shorts lose the same   |
//| amount per unit, so a hedge cancels exactly as much slope as it    |
//| has lots:                                                          |
//|                                                                   |
//|   equity(P) = equity_now + valuePerPrice * net * (P - bid_now)     |
//|                                                                   |
//| Anchored on the account's own ACCOUNT_EQUITY rather than re-summed |
//| from positions, so other symbols, credit and swap are already in   |
//| it. Stop-out fires when equity falls to                            |
//|                                                                   |
//|   percent mode:  margin * stop_out_level / 100                     |
//|   money mode:    margin + stop_out_level   (free margin reaches    |
//|                  the level -- the rarer mode, and the one this     |
//|                  code is least sure of; check it with the broker)  |
//|                                                                   |
//| so  dead = bid - (equity - stop_out_equity) / (valuePerPrice*net)  |
//| A net long gives a price BELOW the market, a net short ABOVE it.   |
//|                                                                   |
//| Two simplifications, both stated rather than hidden:               |
//|  * margin is held at today's value. It really moves a little with  |
//|    price, so far from the market the line is approximate.          |
//|  * other symbols are held at their current prices.                 |
//+------------------------------------------------------------------+
struct DeadPoint
{
   int    state;          // 0 price found, 1 no margin in use, 2 hedged flat, 3 already at stop-out
   double price;          // bid at which stop-out fires (state 0 only)
   double equity;
   double margin;
   double marginLevel;    // percent; 0 when no margin is in use
   double soLevel;        // the broker's stop-out level, percent or money
   bool   percentMode;
   double stopOutEquity;  // equity at which it fires
   double room;           // equity - stopOutEquity: what can still be lost
};

void DeadFrom(const double equity, const double margin, const double netLots,
              const double bid, const double valuePerPrice, DeadPoint &d)
{
   d.state       = 0;
   d.price       = 0.0;
   d.equity      = equity;
   d.margin      = margin;
   d.soLevel     = AccountInfoDouble(ACCOUNT_MARGIN_SO_SO);
   d.percentMode = (AccountInfoInteger(ACCOUNT_MARGIN_SO_MODE) == ACCOUNT_STOPOUT_MODE_PERCENT);
   d.marginLevel = (d.margin > 0.0) ? d.equity / d.margin * 100.0 : 0.0;
   d.stopOutEquity = d.percentMode ? d.margin * d.soLevel / 100.0
                                   : d.margin + d.soLevel;
   d.room        = d.equity - d.stopOutEquity;

   if(d.margin <= 0.0) { d.state = 1; return; }
   if(d.room <= 0.0)   { d.state = 3; return; }

   // Same smallest-lot test as the break-even: a hedge that nets to zero leaves
   // equity unmoved by price, so there is no price at which it dies.
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = 0.01;
   if(MathAbs(netLots) < step / 2.0) { d.state = 2; return; }

   d.price = bid - d.room / (valuePerPrice * netLots);
}

// The dead point of the account as it stands.
void ComputeDeadPoint(const BasketState &b, DeadPoint &d)
{
   DeadFrom(AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoDouble(ACCOUNT_MARGIN),
            b.netLots, b.bid, b.valuePerPrice, d);
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

void DrawDeadLine(const double price)
{
   if(ObjectFind(0, DEAD_NAME) < 0)
   {
      ObjectCreate(0, DEAD_NAME, OBJ_HLINE, 0, 0, price);
      ObjectSetInteger(0, DEAD_NAME, OBJPROP_STYLE, STYLE_DASHDOT);
      ObjectSetInteger(0, DEAD_NAME, OBJPROP_BACK, true);
      ObjectSetInteger(0, DEAD_NAME, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, DEAD_NAME, OBJPROP_HIDDEN, true);
   }
   ObjectSetDouble(0, DEAD_NAME, OBJPROP_PRICE, price);
   ObjectSetInteger(0, DEAD_NAME, OBJPROP_COLOR, DeadColor);
   ObjectSetInteger(0, DEAD_NAME, OBJPROP_WIDTH, DeadLineWidth);
}

void DrawPlanLine(const string name, const double price)
{
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
      ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_DOT);
      ObjectSetInteger(0, name, OBJPROP_BACK, true);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
   }
   ObjectSetDouble(0, name, OBJPROP_PRICE, price);
   ObjectSetInteger(0, name, OBJPROP_COLOR, PlanColor);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
}

void ClearPlanLines()
{
   ObjectDelete(0, PLAN_BE_NAME);
   ObjectDelete(0, PLAN_DEAD_NAME);
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
   for(int row = fromRow; row < 14; row++)
      ObjectDelete(0, PREFIX "lbl" + IntegerToString(row));
}

//+------------------------------------------------------------------+
//| Compute, draw and describe the dead point. Returns the first panel |
//| row still free. The line is drawn whether or not the panel is on.  |
//+------------------------------------------------------------------+
int UpdateDeadPoint(const BasketState &b, const int firstRow, const int digits,
                    const double pip, const string account)
{
   if(!ShowDeadPoint)
   {
      ObjectDelete(0, DEAD_NAME);
      return firstRow;
   }

   DeadPoint d;
   ComputeDeadPoint(b, d);

   if(d.state == 0) DrawDeadLine(d.price);
   else             ObjectDelete(0, DEAD_NAME);

   if(!ShowPanel) return firstRow;

   int row = firstRow;
   switch(d.state)
   {
      case 0:
         SetLabel(row++, "Dead point " + DoubleToString(d.price, digits) +
                         StringFormat("   %+.1f pips away", (d.price - b.bid) / pip), DeadColor);
         break;
      case 1:
         SetLabel(row++, "Dead point  n/a (no margin in use)", clrSilver);
         return row;
      case 2:
         SetLabel(row++, "Dead point  none - hedged flat, price does not move equity", clrSilver);
         break;
      default:
         SetLabel(row++, "Dead point  REACHED - equity is at or below the stop-out level", DeadColor);
         return row;
   }

   if(d.percentMode)
      SetLabel(row++, StringFormat("Margin lvl  %.0f%%  (stop-out %.0f%%)  room %.2f %s",
                                   d.marginLevel, d.soLevel, d.room, account), clrSilver);
   else
      SetLabel(row++, StringFormat("Room        %.2f %s before stop-out (money mode)",
                                   d.room, account), clrSilver);
   return row;
}

//+------------------------------------------------------------------+
//| WHAT IF: the basket with one more order in it.                    |
//|                                                                   |
//| The same two straight lines as above, with the candidate order     |
//| added to them -- nothing is sent. It opens at the price it would   |
//| really get (a buy at the ask, a sell at the bid), so it starts     |
//| life down by the spread, and that is already in the answer: a      |
//| recovery order never gets the break-even for free.                 |
//|                                                                   |
//|   buy  v @ ask:  net += v,  k -= v*ask                             |
//|   sell v @ bid:  net -= v,  k += v*(bid - spread)                 |
//|                                                                   |
//| Equity after opening is today's less the spread it costs and the   |
//| entry commission; margin is today's plus the terminal's own        |
//| OrderCalcMargin for this order. Hedging brokers may charge less    |
//| for an offsetting order than OrderCalcMargin says, so the dead     |
//| point of a HEDGE is, if anything, a little pessimistic.            |
//+------------------------------------------------------------------+
bool BuildPlan(const BasketState &b, BasketState &p, double &lots, double &openPrice, double &spread)
{
   if(PlanSide == PLAN_NONE || PlanLots <= 0.0)
      return false;

   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = 0.01;
   lots = MathFloor(PlanLots / step + 0.5) * step;
   if(lots <= 0.0)
      return false;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   spread = (ask > b.bid) ? ask - b.bid : 0.0;

   p = b;
   if(PlanSide == PLAN_BUY)
   {
      openPrice  = ask;
      p.netLots += lots;
      p.k       -= lots * openPrice;
   }
   else
   {
      openPrice  = b.bid;
      p.netLots -= lots;
      p.k       += lots * (openPrice - spread);
   }
   double cost = -(PlanEntryCostPerLot + ExitCostPerLot) * lots;
   p.grossLots += lots;
   p.count++;
   p.costs     += cost;
   p.floating   = b.floating - spread * lots * b.valuePerPrice + cost;

   if(MathAbs(p.netLots) < step / 2.0)
   {
      p.hasBreakEven = false;
      p.breakEven    = 0.0;
   }
   else
   {
      p.breakEven    = -(p.k + p.costs / p.valuePerPrice) / p.netLots;
      p.hasBreakEven = true;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Draw and describe the what-if. Returns the first panel row free.  |
//+------------------------------------------------------------------+
int UpdatePlan(const BasketState &b, const int firstRow, const int digits,
               const double pip, const string account)
{
   BasketState p;
   double lots = 0.0, openPrice = 0.0, spread = 0.0;
   if(!BuildPlan(b, p, lots, openPrice, spread))
   {
      ClearPlanLines();
      return firstRow;
   }

   if(p.hasBreakEven) DrawPlanLine(PLAN_BE_NAME, p.breakEven);
   else               ObjectDelete(0, PLAN_BE_NAME);

   // Dead point of the account WITH the order: equity after paying the spread and
   // the entry commission, margin plus what the terminal says this order needs.
   DeadPoint d;
   bool haveDead = false;
   if(ShowDeadPoint)
   {
      double orderMargin = 0.0;
      if(OrderCalcMargin(PlanSide == PLAN_BUY ? ORDER_TYPE_BUY : ORDER_TYPE_SELL,
                         _Symbol, lots, openPrice, orderMargin))
      {
         double equity = AccountInfoDouble(ACCOUNT_EQUITY)
                         - spread * lots * b.valuePerPrice - PlanEntryCostPerLot * lots;
         DeadFrom(equity, AccountInfoDouble(ACCOUNT_MARGIN) + orderMargin,
                  p.netLots, p.bid, p.valuePerPrice, d);
         haveDead = true;
      }
   }
   if(haveDead && d.state == 0) DrawPlanLine(PLAN_DEAD_NAME, d.price);
   else                         ObjectDelete(0, PLAN_DEAD_NAME);

   if(!ShowPanel) return firstRow;

   int row = firstRow;
   SetLabel(row++, StringFormat("IF %s %.2f lots @ %s  (nothing is sent)",
                                PlanSide == PLAN_BUY ? "BUY" : "SELL", lots,
                                DoubleToString(openPrice, digits)), PlanColor);
   if(p.hasBreakEven)
   {
      string moved = b.hasBreakEven
         ? StringFormat("   was %s", DoubleToString(b.breakEven, digits)) : "";
      SetLabel(row++, "  Break-even  " + DoubleToString(p.breakEven, digits) +
                      StringFormat("   %+.1f pips away", (p.breakEven - p.bid) / pip) + moved, PlanColor);
   }
   else
      SetLabel(row++, StringFormat("  Hedged flat: P&L locked at %.2f %s, no break-even price",
                                   p.floating, account), PlanColor);

   if(!ShowDeadPoint) return row;
   if(!haveDead)
   {
      SetLabel(row++, "  Dead point  n/a (the terminal could not price this order's margin)", clrSilver);
      return row;
   }
   switch(d.state)
   {
      case 0:
         SetLabel(row++, "  Dead point  " + DoubleToString(d.price, digits) +
                         StringFormat("   %+.1f pips away", (d.price - p.bid) / pip), PlanColor);
         break;
      case 2:
         SetLabel(row++, "  Dead point  none - hedged flat", PlanColor);
         break;
      case 1:
         SetLabel(row++, "  Dead point  n/a (no margin in use)", clrSilver);
         return row;
      default:
         SetLabel(row++, "  Dead point  REACHED with this order -- it would be stopped out", DeadColor);
         return row;
   }
   if(d.percentMode)
      SetLabel(row++, StringFormat("  Margin lvl  %.0f%%  (stop-out %.0f%%)  room %.2f %s",
                                   d.marginLevel, d.soLevel, d.room, account), clrSilver);
   else
      SetLabel(row++, StringFormat("  Room        %.2f %s before stop-out (money mode)", d.room, account), clrSilver);
   return row;
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
      ObjectDelete(0, DEAD_NAME);
      ClearPlanLines();
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
      ObjectDelete(0, DEAD_NAME);
      ClearPlanLines();
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
         int row = UpdateDeadPoint(b, 2, digits, pip, account);
         ClearPanel(UpdatePlan(b, row, digits, pip, account));
      }
      else
      {
         UpdateDeadPoint(b, 2, digits, pip, account);
         UpdatePlan(b, 0, digits, pip, account);
         ClearPanel(0);
      }
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
      int row = UpdateDeadPoint(b, 4, digits, pip, account);
      ClearPanel(UpdatePlan(b, row, digits, pip, account));
   }
   else
   {
      UpdateDeadPoint(b, 4, digits, pip, account);
      UpdatePlan(b, 0, digits, pip, account);
      ClearPanel(0);
   }

   ChartRedraw();
}

//+------------------------------------------------------------------+
int OnInit()
{
   IndicatorSetString(INDICATOR_SHORTNAME, "TradeNote Break-Even + Dead point");
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
