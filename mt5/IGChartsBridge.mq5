//+------------------------------------------------------------------+
//| IGChartsBridge.mq5                                                |
//| Read-only bridge: sends this terminal's account summary, open     |
//| positions, pending orders and deal history to IG Charts so they   |
//| show on its charts. It never places, modifies or closes trades,   |
//| and your MT5 password never leaves the terminal.                  |
//+------------------------------------------------------------------+
#property copyright "IG Charts"
#property version   "1.00"
#property description "Read-only bridge to IG Charts (positions, orders, deals)."

input string ServerUrl   = "http://127.0.0.1:3000/api/mt5/push"; // IG Charts push URL (from the MT5 tab)
input string BridgeToken = "";                                    // Bridge token (from the MT5 tab)
input int    IntervalSec = 2;                                     // Send positions every N seconds
input int    HistoryDays = 30;                                    // Days of deal history to send

datetime g_lastFull = 0;
bool     g_dirty    = true;
bool     g_warned   = false;

int OnInit()
  {
   if(StringLen(BridgeToken) < 8)
     {
      Print("IGChartsBridge: paste the bridge token from IG Charts (MT5 tab) into the BridgeToken input.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   EventSetTimer(MathMax(1, IntervalSec));
   Send(true);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
  {
   bool full = g_dirty || (TimeLocal() - g_lastFull) >= 60;
   Send(full);
  }

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   g_dirty = true;
  }

// broker server time → UTC (unix seconds); the offset is rounded to 15 minutes
long ServerOffset()
  {
   long diff = (long)(TimeTradeServer() - TimeGMT());
   return (long)(MathRound(diff / 900.0) * 900.0);
  }
long Utc(datetime t) { return (long)t - ServerOffset(); }

string Esc(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\t", " ");
   return s;
  }
string Q(string s) { return "\"" + Esc(s) + "\""; }
string N(double v, int digits = 8) { return DoubleToString(v, digits); }
string I(long v) { return IntegerToString(v); }

string OrderTypeName(long t)
  {
   switch((int)t)
     {
      case ORDER_TYPE_BUY:             return "buy";
      case ORDER_TYPE_SELL:            return "sell";
      case ORDER_TYPE_BUY_LIMIT:       return "buy_limit";
      case ORDER_TYPE_SELL_LIMIT:      return "sell_limit";
      case ORDER_TYPE_BUY_STOP:        return "buy_stop";
      case ORDER_TYPE_SELL_STOP:       return "sell_stop";
      case ORDER_TYPE_BUY_STOP_LIMIT:  return "buy_stop_limit";
      case ORDER_TYPE_SELL_STOP_LIMIT: return "sell_stop_limit";
      case ORDER_TYPE_CLOSE_BY:        return "close_by";
     }
   return "buy_limit";
  }

string EntryName(long e)
  {
   switch((int)e)
     {
      case DEAL_ENTRY_IN:     return "in";
      case DEAL_ENTRY_OUT:    return "out";
      case DEAL_ENTRY_INOUT:  return "inout";
      case DEAL_ENTRY_OUT_BY: return "out_by";
     }
   return "in";
  }

string AccountJson()
  {
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string tm = mode == ACCOUNT_TRADE_MODE_DEMO ? "demo" : mode == ACCOUNT_TRADE_MODE_CONTEST ? "contest" : "real";
   return "{\"login\":" + Q(I(AccountInfoInteger(ACCOUNT_LOGIN))) +
          ",\"server\":" + Q(AccountInfoString(ACCOUNT_SERVER)) +
          ",\"name\":" + Q(AccountInfoString(ACCOUNT_NAME)) +
          ",\"company\":" + Q(AccountInfoString(ACCOUNT_COMPANY)) +
          ",\"currency\":" + Q(AccountInfoString(ACCOUNT_CURRENCY)) +
          ",\"balance\":" + N(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
          ",\"equity\":" + N(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
          ",\"margin\":" + N(AccountInfoDouble(ACCOUNT_MARGIN), 2) +
          ",\"freeMargin\":" + N(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
          ",\"marginLevel\":" + N(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) +
          ",\"leverage\":" + I(AccountInfoInteger(ACCOUNT_LEVERAGE)) +
          ",\"profit\":" + N(AccountInfoDouble(ACCOUNT_PROFIT), 2) +
          ",\"tradeMode\":" + Q(tm) + "}";
  }

string PositionsJson()
  {
   string out = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(out != "") out += ",";
      out += "{\"ticket\":" + Q(I((long)ticket)) +
             ",\"symbol\":" + Q(PositionGetString(POSITION_SYMBOL)) +
             ",\"type\":" + Q(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell") +
             ",\"volume\":" + N(PositionGetDouble(POSITION_VOLUME), 2) +
             ",\"priceOpen\":" + N(PositionGetDouble(POSITION_PRICE_OPEN)) +
             ",\"priceCurrent\":" + N(PositionGetDouble(POSITION_PRICE_CURRENT)) +
             ",\"sl\":" + N(PositionGetDouble(POSITION_SL)) +
             ",\"tp\":" + N(PositionGetDouble(POSITION_TP)) +
             ",\"profit\":" + N(PositionGetDouble(POSITION_PROFIT), 2) +
             ",\"swap\":" + N(PositionGetDouble(POSITION_SWAP), 2) +
             ",\"time\":" + I(Utc((datetime)PositionGetInteger(POSITION_TIME))) +
             ",\"magic\":" + I(PositionGetInteger(POSITION_MAGIC)) +
             ",\"comment\":" + Q(PositionGetString(POSITION_COMMENT)) + "}";
     }
   return "[" + out + "]";
  }

string OrdersJson()
  {
   string out = "";
   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(out != "") out += ",";
      out += "{\"ticket\":" + Q(I((long)ticket)) +
             ",\"symbol\":" + Q(OrderGetString(ORDER_SYMBOL)) +
             ",\"type\":" + Q(OrderTypeName(OrderGetInteger(ORDER_TYPE))) +
             ",\"volume\":" + N(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) +
             ",\"priceOpen\":" + N(OrderGetDouble(ORDER_PRICE_OPEN)) +
             ",\"stopLimit\":" + N(OrderGetDouble(ORDER_PRICE_STOPLIMIT)) +
             ",\"sl\":" + N(OrderGetDouble(ORDER_SL)) +
             ",\"tp\":" + N(OrderGetDouble(ORDER_TP)) +
             ",\"time\":" + I(Utc((datetime)OrderGetInteger(ORDER_TIME_SETUP))) +
             ",\"comment\":" + Q(OrderGetString(ORDER_COMMENT)) + "}";
     }
   return "[" + out + "]";
  }

string DealsJson(datetime from)
  {
   if(!HistorySelect(from, TimeCurrent() + 86400)) return "[]";
   string out = "";
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      long type = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;   // skip balance, credit, fees…
      if(out != "") out += ",";
      out += "{\"ticket\":" + Q(I((long)ticket)) +
             ",\"order\":" + Q(I(HistoryDealGetInteger(ticket, DEAL_ORDER))) +
             ",\"positionId\":" + Q(I(HistoryDealGetInteger(ticket, DEAL_POSITION_ID))) +
             ",\"symbol\":" + Q(HistoryDealGetString(ticket, DEAL_SYMBOL)) +
             ",\"type\":" + Q(type == DEAL_TYPE_BUY ? "buy" : "sell") +
             ",\"entry\":" + Q(EntryName(HistoryDealGetInteger(ticket, DEAL_ENTRY))) +
             ",\"volume\":" + N(HistoryDealGetDouble(ticket, DEAL_VOLUME), 2) +
             ",\"price\":" + N(HistoryDealGetDouble(ticket, DEAL_PRICE)) +
             ",\"profit\":" + N(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) +
             ",\"commission\":" + N(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) +
             ",\"swap\":" + N(HistoryDealGetDouble(ticket, DEAL_SWAP), 2) +
             ",\"time\":" + I(Utc((datetime)HistoryDealGetInteger(ticket, DEAL_TIME))) +
             ",\"comment\":" + Q(HistoryDealGetString(ticket, DEAL_COMMENT)) + "}";
     }
   return "[" + out + "]";
  }

void Send(bool full)
  {
   datetime from = TimeCurrent() - (datetime)(MathMax(1, HistoryDays) * 86400);
   string json = "{\"ts\":" + I(Utc(TimeTradeServer())) +
                 ",\"account\":" + AccountJson() +
                 ",\"positions\":" + PositionsJson() +
                 ",\"orders\":" + OrdersJson() +
                 ",\"deals\":" + (full ? DealsJson(from) : "[]") +
                 ",\"historyFrom\":" + I(Utc(from)) + "}";

   char data[];
   int n = StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1);   // drop the terminating zero
   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\nX-Bridge-Token: " + BridgeToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", ServerUrl, headers, 5000, data, result, resultHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      if(!g_warned)
        {
         if(err == 4014)
            Print("IGChartsBridge: allow this URL in Tools > Options > Expert Advisors > 'Allow WebRequest for listed URL': ", ServerUrl);
         else
            Print("IGChartsBridge: WebRequest failed, error ", err, " (is IG Charts running at ", ServerUrl, "?)");
         g_warned = true;
        }
      return;
     }
   g_warned = false;
   if(code != 200)
     {
      Print("IGChartsBridge: server replied ", code, ": ", CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
      return;
     }
   if(full) { g_lastFull = TimeLocal(); g_dirty = false; }
  }
//+------------------------------------------------------------------+
