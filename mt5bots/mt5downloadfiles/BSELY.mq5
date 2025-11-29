//+------------------------------------------------------------------+
//|                                                      BSELY.mq5    |
//|                        Magic Automation Lab - Trend Analysis Bot |
//|                                    Multi-Timeframe Trend Analysis |
//+------------------------------------------------------------------+
#property copyright "Magic Automation Lab"
#property link      "https://magicbotslab.com"
#property version   "1.00"
#property description "BSELY - Analyzes 4H, 1H, 30M trends and executes BUY or SELL immediately"
#property description "Works on any timeframe"

#include <Trade\Trade.mqh>
#include <Trade\AccountInfo.mqh>
#include <Trade\SymbolInfo.mqh>

//--- Input Parameters
input int      InpMagicNumber = 123456;     // Magic Number
input string   InpTradeComment = "BSELY";   // Trade Comment

input group "=== Risk Management ==="
input double   InpRiskPercent = 1.0;         // Risk Percentage per Trade (%)
input double   InpTP1Multiplier = 1.5;      // TP1 Risk:Reward Ratio
input double   InpTP2Multiplier = 2.5;      // TP2 Risk:Reward Ratio
input double   InpTP3Multiplier = 4.0;       // TP3 Risk:Reward Ratio
input bool     InpUseTP1 = true;            // Use TP1
input bool     InpUseTP2 = true;            // Use TP2
input bool     InpUseTP3 = true;            // Use TP3

//--- Global Variables
CTrade trade;
CAccountInfo account;
CPositionInfo position;
bool tradeExecuted = false;
int globalTrendSignal = 0; // Stores the trend direction (1=BUY, -1=SELL, 0=NEUTRAL)
datetime trendAnalysisTime = 0; // Time when trend was analyzed
int maxWaitMinutes = 30; // Maximum wait time for rejection before executing anyway
int barsSinceAnalysis = 0; // Count bars since trend analysis (for tester)
datetime lastTradeTime = 0; // Time of last trade execution
int tradeCooldownMinutes = 240; // Minimum time between trades (4 hours) - increased to reduce overtrading

// Zone tracking
struct ZoneLevel
{
   double price;
   bool isSupport;
   bool isResistance;
   datetime lastTestTime;
   int testCount;
   bool isActive;
};

ZoneLevel keyZones[];
int maxZones = 20;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   // Set trade parameters
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(10);
   trade.SetTypeFilling(ORDER_FILLING_FOK);
   trade.SetAsyncMode(false);
   
   Print("BSELY Bot initialized successfully");
   Print("Symbol: ", _Symbol);
   Print("Current Timeframe: ", EnumToString(Period()));
   Print("Risk per Trade: ", InpRiskPercent, "%");
   Print("Analyzing market trends from 4H, 1H, 30M timeframes...");
   
   // Initialize zone tracking
   ArrayResize(keyZones, maxZones);
   for(int i = 0; i < maxZones; i++)
   {
      keyZones[i].price = 0.0;
      keyZones[i].isSupport = false;
      keyZones[i].isResistance = false;
      keyZones[i].lastTestTime = 0;
      keyZones[i].testCount = 0;
      keyZones[i].isActive = false;
   }
   
   // Identify key zones first
   IdentifyKeyZones(_Symbol);
   
   // Analyze market and execute trade
   AnalyzeAndExecute();
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("BSELY Bot stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| Tester function - called at the end of testing/optimization      |
//+------------------------------------------------------------------+
double OnTester()
{
   // Return custom optimization criterion (profit factor)
   double profitFactor = TesterStatistics(STAT_PROFIT_FACTOR);
   
   // If profit factor is invalid, use total profit as criterion
   if(profitFactor <= 0)
   {
      double totalProfit = TesterStatistics(STAT_PROFIT);
      return totalProfit;
   }
   
   return profitFactor;
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // Check if enough time has passed since last trade (cooldown)
   if(lastTradeTime > 0)
   {
      int minutesSinceLastTrade = (int)((TimeCurrent() - lastTradeTime) / 60);
      if(minutesSinceLastTrade < tradeCooldownMinutes)
      {
         return; // Still in cooldown period
      }
   }
   
   // Reset trade executed flag after cooldown to allow new trades
   if(lastTradeTime > 0 && (TimeCurrent() - lastTradeTime) >= (tradeCooldownMinutes * 60))
   {
      tradeExecuted = false;
      // Re-analyze trend for new opportunities
      if(globalTrendSignal == 0)
      {
         AnalyzeAndExecute();
      }
   }
   
   // Track new bars for tester mode
   static int lastBarTime = 0;
   int currentBarTime = (int)SeriesInfoInteger(_Symbol, PERIOD_M15, SERIES_LASTBAR_DATE);
   bool newBar = (currentBarTime != lastBarTime);
   if(newBar)
   {
      lastBarTime = currentBarTime;
      if(!tradeExecuted && globalTrendSignal != 0)
      {
         barsSinceAnalysis++;
      }
   }
   
   // Check for zone or EMA 200 rejections on each tick
   if(!tradeExecuted && globalTrendSignal != 0)
   {
      // Check for rejections (zone or EMA 200)
      int rejectionSignal = CheckForRejections(_Symbol);
      
      if(rejectionSignal != 0)
      {
         // Rejection detected - now check if it matches trend direction
         if((rejectionSignal == 1 && globalTrendSignal == 1) || 
            (rejectionSignal == -1 && globalTrendSignal == -1))
         {
            // Rejection matches trend direction - execute trade
            if(rejectionSignal == 1)
            {
               Print("=== REJECTION CONFIRMED: BUY SIGNAL (Matches Trend) ===");
               Print("Executing BUY trade...");
               ExecuteBuyTrade();
            }
            else if(rejectionSignal == -1)
            {
               Print("=== REJECTION CONFIRMED: SELL SIGNAL (Matches Trend) ===");
               Print("Executing SELL trade...");
               ExecuteSellTrade();
            }
         }
         else
         {
            // Log but don't execute if rejection doesn't match trend
            static datetime lastMismatchLog = 0;
            if(TimeCurrent() - lastMismatchLog > 60) // Log once per minute
            {
               Print("=== REJECTION DETECTED BUT DOESN'T MATCH TREND - IGNORING ===");
               Print("Rejection Signal: ", rejectionSignal, " | Trend Signal: ", globalTrendSignal);
               lastMismatchLog = TimeCurrent();
            }
         }
      }
      else
      {
         // No rejection detected - check if we've waited too long
         if(trendAnalysisTime > 0)
         {
            int minutesWaited = (int)((TimeCurrent() - trendAnalysisTime) / 60);
            
            // In tester mode, execute after more bars if no rejection found (better quality)
            bool shouldExecute = false;
            if(MQLInfoInteger(MQL_TESTER))
            {
               // Execute after 4 bars (1 hour) in tester if no rejection - better quality trades
               if(barsSinceAnalysis >= 4)
               {
                  shouldExecute = true;
                  Print("=== TESTER MODE: NO REJECTION AFTER ", barsSinceAnalysis, " BARS - EXECUTING BASED ON TREND ===");
               }
            }
            else
            {
               // Live mode: wait for time-based condition
               if(minutesWaited >= maxWaitMinutes)
               {
                  shouldExecute = true;
                  Print("=== NO REJECTION FOUND AFTER ", minutesWaited, " MINUTES - EXECUTING BASED ON TREND ===");
               }
            }
            
            if(shouldExecute)
            {
               if(globalTrendSignal == 1)
               {
                  ExecuteBuyTrade();
               }
               else if(globalTrendSignal == -1)
               {
                  ExecuteSellTrade();
               }
            }
         }
      }
   }
   else if(!tradeExecuted && globalTrendSignal == 0)
   {
      // If no trend signal, re-analyze periodically
      static datetime lastReanalysis = 0;
      if(TimeCurrent() - lastReanalysis > 3600) // Re-analyze every hour
      {
         Print("Re-analyzing trend...");
         AnalyzeAndExecute();
         lastReanalysis = TimeCurrent();
      }
   }
}

//+------------------------------------------------------------------+
//| Analyze market trends and execute trade                          |
//+------------------------------------------------------------------+
void AnalyzeAndExecute()
{
   if(tradeExecuted)
   {
      Print("Trade already executed. Skipping.");
      return;
   }
   
   string symbol = _Symbol;
   
   // Analyze trends from higher timeframes
   int trend4H = AnalyzeTrend(symbol, PERIOD_H4);
   int trend1H = AnalyzeTrend(symbol, PERIOD_H1);
   int trend30M = AnalyzeTrend(symbol, PERIOD_M30);
   
   Print("=== MARKET ANALYSIS ===");
   Print("4H Trend: ", (trend4H > 0 ? "BULLISH" : (trend4H < 0 ? "BEARISH" : "NEUTRAL")));
   Print("1H Trend: ", (trend1H > 0 ? "BULLISH" : (trend1H < 0 ? "BEARISH" : "NEUTRAL")));
   Print("30M Trend: ", (trend30M > 0 ? "BULLISH" : (trend30M < 0 ? "BEARISH" : "NEUTRAL")));
   
   // Calculate overall trend score
   int bullishCount = 0;
   int bearishCount = 0;
   
   if(trend4H > 0) bullishCount++;
   else if(trend4H < 0) bearishCount++;
   
   if(trend1H > 0) bullishCount++;
   else if(trend1H < 0) bearishCount++;
   
   if(trend30M > 0) bullishCount++;
   else if(trend30M < 0) bearishCount++;
   
   Print("Bullish Signals: ", bullishCount);
   Print("Bearish Signals: ", bearishCount);
   
   // Determine trade direction
   int signal = 0; // 0 = no signal, 1 = BUY, -1 = SELL
   
   if(bullishCount >= 2)
   {
      signal = 1; // BUY
      Print("=== DECISION: BUY (Majority Bullish) ===");
   }
   else if(bearishCount >= 2)
   {
      signal = -1; // SELL
      Print("=== DECISION: SELL (Majority Bearish) ===");
   }
   else
   {
      // If tied or neutral, use strongest trend
      if(trend4H != 0)
      {
         signal = (trend4H > 0) ? 1 : -1;
         Print("=== DECISION: ", (signal == 1 ? "BUY" : "SELL"), " (Based on 4H Trend) ===");
      }
      else if(trend1H != 0)
      {
         signal = (trend1H > 0) ? 1 : -1;
         Print("=== DECISION: ", (signal == 1 ? "BUY" : "SELL"), " (Based on 1H Trend) ===");
      }
      else if(trend30M != 0)
      {
         signal = (trend30M > 0) ? 1 : -1;
         Print("=== DECISION: ", (signal == 1 ? "BUY" : "SELL"), " (Based on 30M Trend) ===");
      }
      else
      {
         // Default to BUY if all neutral
         signal = 1;
         Print("=== DECISION: BUY (Default - All Neutral) ===");
      }
   }
   
   // Store trend signal for rejection matching
   globalTrendSignal = signal;
   trendAnalysisTime = TimeCurrent();
   barsSinceAnalysis = 0;
   
   // In tester mode, use reasonable wait times
   if(MQLInfoInteger(MQL_TESTER))
   {
      maxWaitMinutes = 60; // Wait 60 minutes in tester (increased for better quality)
      tradeCooldownMinutes = 240; // 4 hours between trades in tester (increased to prevent overtrading)
      Print("=== TESTER MODE DETECTED ===");
   }
   
   // Wait for rejection before executing - rejection check happens in OnTick
   Print("=== TREND ANALYSIS COMPLETE - WAITING FOR REJECTION ===");
   Print("Trend Signal: ", (signal == 1 ? "BUY" : (signal == -1 ? "SELL" : "NEUTRAL")));
   Print("Bot will execute trade when rejection is detected at key level or EMA 200 on M15");
   Print("If no rejection found within ", maxWaitMinutes, " minutes, will execute based on trend");
}

//+------------------------------------------------------------------+
//| Analyze trend for a specific timeframe                           |
//+------------------------------------------------------------------+
int AnalyzeTrend(string symbol, ENUM_TIMEFRAMES timeframe)
{
   // Get current price
   double currentPrice = SymbolInfoDouble(symbol, SYMBOL_BID);
   if(currentPrice <= 0) return 0;
   
   // Get EMA values for trend analysis
   int emaFastHandle = iMA(symbol, timeframe, 12, 0, MODE_EMA, PRICE_CLOSE);
   int emaSlowHandle = iMA(symbol, timeframe, 26, 0, MODE_EMA, PRICE_CLOSE);
   int smaHandle = iMA(symbol, timeframe, 50, 0, MODE_SMA, PRICE_CLOSE);
   
   if(emaFastHandle == INVALID_HANDLE || emaSlowHandle == INVALID_HANDLE || smaHandle == INVALID_HANDLE)
   {
      Print("Failed to create indicators for ", EnumToString(timeframe));
      return 0;
   }
   
   double emaFast[], emaSlow[], sma[];
   ArraySetAsSeries(emaFast, true);
   ArraySetAsSeries(emaSlow, true);
   ArraySetAsSeries(sma, true);
   ArrayResize(emaFast, 1);
   ArrayResize(emaSlow, 1);
   ArrayResize(sma, 1);
   
   if(CopyBuffer(emaFastHandle, 0, 0, 1, emaFast) <= 0 ||
      CopyBuffer(emaSlowHandle, 0, 0, 1, emaSlow) <= 0 ||
      CopyBuffer(smaHandle, 0, 0, 1, sma) <= 0)
   {
      IndicatorRelease(emaFastHandle);
      IndicatorRelease(emaSlowHandle);
      IndicatorRelease(smaHandle);
      return 0;
   }
   
   IndicatorRelease(emaFastHandle);
   IndicatorRelease(emaSlowHandle);
   IndicatorRelease(smaHandle);
   
   // Calculate trend score
   int trendScore = 0;
   
   // EMA crossover analysis
   if(emaFast[0] > emaSlow[0]) trendScore += 1;  // Bullish
   else if(emaFast[0] < emaSlow[0]) trendScore -= 1; // Bearish
   
   // Price vs SMA analysis
   if(currentPrice > sma[0]) trendScore += 1;  // Bullish
   else if(currentPrice < sma[0]) trendScore -= 1; // Bearish
   
   // Price vs EMA analysis
   if(currentPrice > emaFast[0]) trendScore += 1;  // Bullish
   else if(currentPrice < emaFast[0]) trendScore -= 1; // Bearish
   
   // Return trend: 1 = bullish, -1 = bearish, 0 = neutral
   if(trendScore > 0) return 1;
   else if(trendScore < 0) return -1;
   else return 0;
}

//+------------------------------------------------------------------+
//| Execute BUY trade                                                |
//+------------------------------------------------------------------+
void ExecuteBuyTrade()
{
   string symbol = _Symbol;
   
   // Check for existing positions - don't open new trade if position already exists
   if(PositionSelect(symbol))
   {
      Print("=== POSITION ALREADY EXISTS FOR ", symbol, " - SKIPPING TRADE ===");
      return;
   }
   
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   
   if(ask <= 0 || bid <= 0)
   {
      Print("ERROR: Invalid prices - Ask: ", ask, " Bid: ", bid);
      return;
   }
   
   // Calculate stop loss and take profit levels based on market structure
   double stopLoss = CalculateStopLossFromStructure(symbol, true, ask); // true for BUY
   double tp1 = 0.0, tp2 = 0.0, tp3 = 0.0;
   
   if(stopLoss > 0 && stopLoss < ask)
   {
      // Calculate TP levels based on market structure (next resistance levels)
      double tps[] = {0.0, 0.0, 0.0};
      int tpCount = CalculateTakeProfitsFromStructure(symbol, true, ask, stopLoss, tps);
      
      if(tpCount > 0)
      {
         tp1 = (tpCount >= 1) ? tps[0] : 0.0;
         tp2 = (tpCount >= 2) ? tps[1] : 0.0;
         tp3 = (tpCount >= 3) ? tps[2] : 0.0;
      }
      else
      {
         // Fallback: Use risk:reward ratios if no structure levels found
         double stopDistance = ask - stopLoss;
         tp1 = ask + (stopDistance * InpTP1Multiplier);
         tp2 = ask + (stopDistance * InpTP2Multiplier);
         tp3 = ask + (stopDistance * InpTP3Multiplier);
      }
   }
   else
   {
      Print("ERROR: Invalid stop loss calculation");
      return;
   }
   
   // Normalize prices
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   ask = NormalizeDouble(ask, digits);
   stopLoss = NormalizeDouble(stopLoss, digits);
   tp1 = NormalizeDouble(tp1, digits);
   tp2 = NormalizeDouble(tp2, digits);
   tp3 = NormalizeDouble(tp3, digits);
   
   // Validate levels
   if(stopLoss >= ask || tp1 <= ask || tp2 <= ask || tp3 <= ask)
   {
      Print("ERROR: Invalid price levels for BUY");
      Print("Entry: ", ask, " SL: ", stopLoss, " TP1: ", tp1, " TP2: ", tp2, " TP3: ", tp3);
      return;
   }
   
   // Calculate lot size based on 1% risk
   double totalLotSize = CalculateLotSize(symbol, ask, stopLoss, InpRiskPercent);
   
   if(totalLotSize <= 0)
   {
      Print("ERROR: Invalid lot size calculation");
      return;
   }
   
   // Divide lot size into 3 parts for 3 TP levels
   double lotSize1 = 0.0, lotSize2 = 0.0, lotSize3 = 0.0;
   int tpCount = 0;
   if(InpUseTP1) tpCount++;
   if(InpUseTP2) tpCount++;
   if(InpUseTP3) tpCount++;
   
   if(tpCount > 0)
   {
      lotSize1 = (InpUseTP1 ? totalLotSize / tpCount : 0.0);
      lotSize2 = (InpUseTP2 ? totalLotSize / tpCount : 0.0);
      lotSize3 = (InpUseTP3 ? totalLotSize / tpCount : 0.0);
   }
   else
   {
      // If no TP enabled, use full lot size
      lotSize1 = totalLotSize;
   }
   
   // Normalize lot sizes
   double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   
   lotSize1 = NormalizeLotSize(lotSize1, minLot, maxLot, lotStep);
   lotSize2 = NormalizeLotSize(lotSize2, minLot, maxLot, lotStep);
   lotSize3 = NormalizeLotSize(lotSize3, minLot, maxLot, lotStep);
   
   // Execute trades for each TP level
   bool result1 = false, result2 = false, result3 = false;
   int tradesExecuted = 0;
   
   if(InpUseTP1 && lotSize1 >= minLot && tp1 > 0)
   {
      result1 = trade.Buy(lotSize1, symbol, 0, stopLoss, tp1, InpTradeComment + "_TP1");
      if(result1) tradesExecuted++;
   }
   
   if(InpUseTP2 && lotSize2 >= minLot && tp2 > 0)
   {
      result2 = trade.Buy(lotSize2, symbol, 0, stopLoss, tp2, InpTradeComment + "_TP2");
      if(result2) tradesExecuted++;
   }
   
   if(InpUseTP3 && lotSize3 >= minLot && tp3 > 0)
   {
      result3 = trade.Buy(lotSize3, symbol, 0, stopLoss, tp3, InpTradeComment + "_TP3");
      if(result3) tradesExecuted++;
   }
   
   if(tradesExecuted > 0)
   {
      Print("=== BUY TRADES EXECUTED SUCCESSFULLY ===");
      Print("Symbol: ", symbol);
      Print("Total Lot Size: ", totalLotSize, " (Risk: ", InpRiskPercent, "%)");
      Print("Lot Size TP1: ", lotSize1, " | Lot Size TP2: ", lotSize2, " | Lot Size TP3: ", lotSize3);
      Print("Entry Price (Ask): ", ask);
      Print("Stop Loss: ", stopLoss);
      Print("TP1: ", tp1, " (", (result1 ? "EXECUTED" : "FAILED"), ")");
      Print("TP2: ", tp2, " (", (result2 ? "EXECUTED" : "FAILED"), ")");
      Print("TP3: ", tp3, " (", (result3 ? "EXECUTED" : "FAILED"), ")");
      Print("Trades Executed: ", tradesExecuted, " / ", tpCount);
      tradeExecuted = true;
      lastTradeTime = TimeCurrent();
   }
   else
   {
      Print("=== BUY TRADE EXECUTION FAILED ===");
      Print("Symbol: ", symbol);
      Print("Error Code: ", GetLastError());
      Print("Total Lot Size: ", totalLotSize);
      Print("Ask Price: ", ask);
      Print("Stop Loss: ", stopLoss);
   }
}

//+------------------------------------------------------------------+
//| Execute SELL trade                                               |
//+------------------------------------------------------------------+
void ExecuteSellTrade()
{
   string symbol = _Symbol;
   
   // Check for existing positions - don't open new trade if position already exists
   if(PositionSelect(symbol))
   {
      Print("=== POSITION ALREADY EXISTS FOR ", symbol, " - SKIPPING TRADE ===");
      return;
   }
   
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   
   if(ask <= 0 || bid <= 0)
   {
      Print("ERROR: Invalid prices - Ask: ", ask, " Bid: ", bid);
      return;
   }
   
   // Calculate stop loss and take profit levels based on market structure
   double stopLoss = CalculateStopLossFromStructure(symbol, false, bid); // false for SELL
   double tp1 = 0.0, tp2 = 0.0, tp3 = 0.0;
   
   if(stopLoss > 0 && stopLoss > bid)
   {
      // Calculate TP levels based on market structure (next support levels)
      double tps[] = {0.0, 0.0, 0.0};
      int tpCount = CalculateTakeProfitsFromStructure(symbol, false, bid, stopLoss, tps);
      
      if(tpCount > 0)
      {
         tp1 = (tpCount >= 1) ? tps[0] : 0.0;
         tp2 = (tpCount >= 2) ? tps[1] : 0.0;
         tp3 = (tpCount >= 3) ? tps[2] : 0.0;
      }
      else
      {
         // Fallback: Use risk:reward ratios if no structure levels found
         double stopDistance = stopLoss - bid;
         tp1 = bid - (stopDistance * InpTP1Multiplier);
         tp2 = bid - (stopDistance * InpTP2Multiplier);
         tp3 = bid - (stopDistance * InpTP3Multiplier);
      }
   }
   else
   {
      Print("ERROR: Invalid stop loss calculation");
      return;
   }
   
   // Normalize prices
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   bid = NormalizeDouble(bid, digits);
   stopLoss = NormalizeDouble(stopLoss, digits);
   tp1 = NormalizeDouble(tp1, digits);
   tp2 = NormalizeDouble(tp2, digits);
   tp3 = NormalizeDouble(tp3, digits);
   
   // Validate levels
   if(stopLoss <= bid || tp1 >= bid || tp2 >= bid || tp3 >= bid)
   {
      Print("ERROR: Invalid price levels for SELL");
      Print("Entry: ", bid, " SL: ", stopLoss, " TP1: ", tp1, " TP2: ", tp2, " TP3: ", tp3);
      return;
   }
   
   // Calculate lot size based on 1% risk
   double totalLotSize = CalculateLotSize(symbol, bid, stopLoss, InpRiskPercent);
   
   if(totalLotSize <= 0)
   {
      Print("ERROR: Invalid lot size calculation");
      return;
   }
   
   // Divide lot size into 3 parts for 3 TP levels
   double lotSize1 = 0.0, lotSize2 = 0.0, lotSize3 = 0.0;
   int tpCount = 0;
   if(InpUseTP1) tpCount++;
   if(InpUseTP2) tpCount++;
   if(InpUseTP3) tpCount++;
   
   if(tpCount > 0)
   {
      lotSize1 = (InpUseTP1 ? totalLotSize / tpCount : 0.0);
      lotSize2 = (InpUseTP2 ? totalLotSize / tpCount : 0.0);
      lotSize3 = (InpUseTP3 ? totalLotSize / tpCount : 0.0);
   }
   else
   {
      // If no TP enabled, use full lot size
      lotSize1 = totalLotSize;
   }
   
   // Normalize lot sizes
   double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   
   lotSize1 = NormalizeLotSize(lotSize1, minLot, maxLot, lotStep);
   lotSize2 = NormalizeLotSize(lotSize2, minLot, maxLot, lotStep);
   lotSize3 = NormalizeLotSize(lotSize3, minLot, maxLot, lotStep);
   
   // Execute trades for each TP level
   bool result1 = false, result2 = false, result3 = false;
   int tradesExecuted = 0;
   
   if(InpUseTP1 && lotSize1 >= minLot && tp1 > 0)
   {
      result1 = trade.Sell(lotSize1, symbol, 0, stopLoss, tp1, InpTradeComment + "_TP1");
      if(result1) tradesExecuted++;
   }
   
   if(InpUseTP2 && lotSize2 >= minLot && tp2 > 0)
   {
      result2 = trade.Sell(lotSize2, symbol, 0, stopLoss, tp2, InpTradeComment + "_TP2");
      if(result2) tradesExecuted++;
   }
   
   if(InpUseTP3 && lotSize3 >= minLot && tp3 > 0)
   {
      result3 = trade.Sell(lotSize3, symbol, 0, stopLoss, tp3, InpTradeComment + "_TP3");
      if(result3) tradesExecuted++;
   }
   
   if(tradesExecuted > 0)
   {
      Print("=== SELL TRADES EXECUTED SUCCESSFULLY ===");
      Print("Symbol: ", symbol);
      Print("Total Lot Size: ", totalLotSize, " (Risk: ", InpRiskPercent, "%)");
      Print("Lot Size TP1: ", lotSize1, " | Lot Size TP2: ", lotSize2, " | Lot Size TP3: ", lotSize3);
      Print("Entry Price (Bid): ", bid);
      Print("Stop Loss: ", stopLoss);
      Print("TP1: ", tp1, " (", (result1 ? "EXECUTED" : "FAILED"), ")");
      Print("TP2: ", tp2, " (", (result2 ? "EXECUTED" : "FAILED"), ")");
      Print("TP3: ", tp3, " (", (result3 ? "EXECUTED" : "FAILED"), ")");
      Print("Trades Executed: ", tradesExecuted, " / ", tpCount);
      tradeExecuted = true;
      lastTradeTime = TimeCurrent();
   }
   else
   {
      Print("=== SELL TRADE EXECUTION FAILED ===");
      Print("Symbol: ", symbol);
      Print("Error Code: ", GetLastError());
      Print("Total Lot Size: ", totalLotSize);
      Print("Bid Price: ", bid);
      Print("Stop Loss: ", stopLoss);
   }
}

//+------------------------------------------------------------------+
//| Calculate stop loss based on 15-minute market structure          |
//+------------------------------------------------------------------+
double CalculateStopLossFromStructure(string symbol, bool isBuy, double entryPrice)
{
   if(entryPrice <= 0) return 0;
   
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(digits == 3 || digits == 5) point *= 10;
   
   double stopLoss = 0.0;
   
   // Find nearest structure level (support for BUY, resistance for SELL)
   if(isBuy)
   {
      // For BUY: Find nearest support level below entry
      double nearestSupport = FindNearestSupportLevel(symbol, entryPrice);
      double atr = GetATR(symbol, PERIOD_M15);
      
      if(nearestSupport > 0 && nearestSupport < entryPrice)
      {
         // Use support level with buffer (half ATR or 10 pips, whichever is larger)
         double buffer = MathMax(atr * 0.5, 10 * point);
         stopLoss = nearestSupport - buffer;
      }
      else if(atr > 0)
      {
         // Use ATR-based stop (1.5x ATR for tighter stop)
         stopLoss = entryPrice - (atr * 1.5);
      }
      else
      {
         // Final fallback: Use recent swing low
         double swingLow = FindLowestLow(symbol, PERIOD_M15, 20);
         if(swingLow > 0 && swingLow < entryPrice)
         {
            stopLoss = swingLow - (10 * point);
         }
         else
         {
            stopLoss = entryPrice - (30 * point); // 30 pips fallback
         }
      }
   }
   else
   {
      // For SELL: Find nearest resistance level above entry
      double nearestResistance = FindNearestResistanceLevel(symbol, entryPrice);
      double atr = GetATR(symbol, PERIOD_M15);
      
      if(nearestResistance > 0 && nearestResistance > entryPrice)
      {
         // Use resistance level with buffer (half ATR or 10 pips, whichever is larger)
         double buffer = MathMax(atr * 0.5, 10 * point);
         stopLoss = nearestResistance + buffer;
      }
      else if(atr > 0)
      {
         // Use ATR-based stop (1.2x ATR for tighter stop - improved risk management)
         stopLoss = entryPrice + (atr * 1.2);
      }
      else
      {
         // Final fallback: Use recent swing high
         double swingHigh = FindHighestHigh(symbol, PERIOD_M15, 20);
         if(swingHigh > 0 && swingHigh > entryPrice)
         {
            stopLoss = swingHigh + (10 * point);
         }
         else
         {
            stopLoss = entryPrice + (25 * point); // 25 pips fallback (tighter)
         }
      }
   }
   
   // Ensure minimum stop level distance
   long stopLevel = (long)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minStopDistance = stopLevel * point;
   
   if(isBuy)
   {
      double stopDistance = entryPrice - stopLoss;
      if(stopDistance < minStopDistance)
         stopLoss = entryPrice - minStopDistance;
   }
   else
   {
      double stopDistance = stopLoss - entryPrice;
      if(stopDistance < minStopDistance)
         stopLoss = entryPrice + minStopDistance;
   }
   
   // Normalize stop loss
   stopLoss = NormalizeDouble(stopLoss, digits);
   
   Print("=== STOP LOSS CALCULATION ===");
   Print("Entry Price: ", entryPrice);
   Print("Stop Loss: ", stopLoss);
   Print("Stop Distance: ", MathAbs(entryPrice - stopLoss));
   
   return stopLoss;
}

//+------------------------------------------------------------------+
//| Get ATR value                                                     |
//+------------------------------------------------------------------+
double GetATR(string symbol, ENUM_TIMEFRAMES timeframe)
{
   int atrHandle = iATR(symbol, timeframe, 14);
   if(atrHandle == INVALID_HANDLE) return 0.0;
   
   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(atrHandle, 0, 0, 1, atr) <= 0)
   {
      IndicatorRelease(atrHandle);
      return 0.0;
   }
   
   IndicatorRelease(atrHandle);
   return atr[0];
}

//+------------------------------------------------------------------+
//| Find support level from 15-minute market structure               |
//+------------------------------------------------------------------+
double FindSupportLevel(string symbol, ENUM_TIMEFRAMES timeframe = PERIOD_M15)
{
   // Analyze 15-minute timeframe for support levels (last 20 candles)
   double support = FindLowestLow(symbol, timeframe, 20);
   
   return support;
}

//+------------------------------------------------------------------+
//| Find resistance level from 15-minute market structure            |
//+------------------------------------------------------------------+
double FindResistanceLevel(string symbol, ENUM_TIMEFRAMES timeframe = PERIOD_M15)
{
   // Analyze 15-minute timeframe for resistance levels (last 20 candles)
   double resistance = FindHighestHigh(symbol, timeframe, 20);
   
   return resistance;
}

//+------------------------------------------------------------------+
//| Find lowest low in recent candles                                 |
//+------------------------------------------------------------------+
double FindLowestLow(string symbol, ENUM_TIMEFRAMES timeframe, int periods)
{
   double low[];
   ArraySetAsSeries(low, true);
   if(CopyLow(symbol, timeframe, 0, periods, low) <= 0) return 0.0;
   
   double lowest = low[0];
   for(int i = 1; i < ArraySize(low); i++)
   {
      if(low[i] < lowest) lowest = low[i];
   }
   
   return lowest;
}

//+------------------------------------------------------------------+
//| Find highest high in recent candles                               |
//+------------------------------------------------------------------+
double FindHighestHigh(string symbol, ENUM_TIMEFRAMES timeframe, int periods)
{
   double high[];
   ArraySetAsSeries(high, true);
   if(CopyHigh(symbol, timeframe, 0, periods, high) <= 0) return 0.0;
   
   double highest = high[0];
   for(int i = 1; i < ArraySize(high); i++)
   {
      if(high[i] > highest) highest = high[i];
   }
   
   return highest;
}

//+------------------------------------------------------------------+
//| Adjust price to nearest key level from 15-minute market structure |
//+------------------------------------------------------------------+
double AdjustToKeyLevel(string symbol, double price, bool isBuy, ENUM_TIMEFRAMES timeframe = PERIOD_M15)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   
   // Try to find nearest key level from M15 structure (recent highs/lows)
   double nearestLevel = 0.0;
   
   if(isBuy)
   {
      // For BUY TP: look for recent resistance levels above price
      double high = FindHighestHigh(symbol, timeframe, 10);
      if(high > price && high > 0)
      {
         // Check if price is near a recent high
         double distance = high - price;
         double atr = GetATR(symbol, timeframe);
         if(atr > 0 && distance < atr * 3.0)
         {
            nearestLevel = high;
         }
      }
   }
   else
   {
      // For SELL TP: look for recent support levels below price
      double low = FindLowestLow(symbol, timeframe, 10);
      if(low < price && low > 0)
      {
         // Check if price is near a recent low
         double distance = price - low;
         double atr = GetATR(symbol, timeframe);
         if(atr > 0 && distance < atr * 3.0)
         {
            nearestLevel = low;
         }
      }
   }
   
   // If found a key level nearby, use it; otherwise round to psychological levels
   if(nearestLevel > 0)
   {
      price = nearestLevel;
   }
   else
   {
      // Round to psychological levels
      // For 5-digit pairs (like EURUSD), round to nearest 10 pips
      if(digits == 5)
      {
         price = MathRound(price * 100) / 100.0;
      }
      // For 3-digit pairs (like USDJPY), round to nearest pip
      else if(digits == 3)
      {
         price = MathRound(price * 10) / 10.0;
      }
      // For 2-digit pairs (like XAUUSD), round to nearest 0.5
      else if(digits == 2)
      {
         price = MathRound(price * 2) / 2.0;
      }
      // For other pairs, round to nearest point
      else
      {
         price = NormalizeDouble(price, digits);
      }
   }
   
   return price;
}

//+------------------------------------------------------------------+
//| Calculate lot size based on risk percentage                      |
//+------------------------------------------------------------------+
double CalculateLotSize(string symbol, double entryPrice, double stopLoss, double riskPercent)
{
   // Get account balance
   double balance = account.Balance();
   if(balance <= 0)
   {
      Print("ERROR: Invalid account balance: ", balance);
      return 0.0;
   }
   
   // Calculate risk amount
   double riskAmount = balance * (riskPercent / 100.0);
   
   // Calculate stop loss distance
   double stopDistance = MathAbs(entryPrice - stopLoss);
   if(stopDistance <= 0)
   {
      Print("ERROR: Invalid stop loss distance");
      return 0.0;
   }
   
   // Get symbol properties
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double contractSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   
   // Adjust point for 3/5 digit symbols
   if(digits == 3 || digits == 5) point *= 10;
   
   // Calculate stop loss in points
   long stopLossPoints = (long)(stopDistance / point);
   
   if(stopLossPoints <= 0)
   {
      Print("ERROR: Invalid stop loss points: ", stopLossPoints);
      return 0.0;
   }
   
   // Get account currency
   string accountCurrency = account.Currency();
   string symbolCurrency = SymbolInfoString(symbol, SYMBOL_CURRENCY_PROFIT);
   
   if(StringLen(accountCurrency) == 0)
   {
      Print("ERROR: Unable to get account currency");
      return 0.0;
   }
   
   if(StringLen(symbolCurrency) == 0)
   {
      Print("ERROR: Unable to get symbol profit currency");
      return 0.0;
   }
   
   // Calculate loss per lot
   double lossPerLot = (stopLossPoints * point) * contractSize;
   
   // Convert to account currency if needed
   if(symbolCurrency != accountCurrency)
   {
      double conversionRate = 1.0;
      string conversionSymbol = symbolCurrency + accountCurrency;
      if(SymbolInfoDouble(conversionSymbol, SYMBOL_BID) > 0)
      {
         conversionRate = SymbolInfoDouble(conversionSymbol, SYMBOL_BID);
      }
      else
      {
         // Try reverse pair
         conversionSymbol = accountCurrency + symbolCurrency;
         if(SymbolInfoDouble(conversionSymbol, SYMBOL_BID) > 0)
         {
            conversionRate = 1.0 / SymbolInfoDouble(conversionSymbol, SYMBOL_BID);
         }
      }
      lossPerLot = lossPerLot * conversionRate;
   }
   
   // Calculate lot size: Risk Amount / Loss per Lot
   double lotSize = 0.0;
   if(lossPerLot > 0)
   {
      lotSize = riskAmount / lossPerLot;
   }
   else
   {
      Print("ERROR: Invalid loss per lot calculation: ", lossPerLot);
      return 0.0;
   }
   
   Print("=== LOT SIZE CALCULATION ===");
   Print("Balance: ", DoubleToString(balance, 2));
   Print("Risk Amount (", riskPercent, "%): ", DoubleToString(riskAmount, 2));
   Print("Stop Loss Points: ", stopLossPoints);
   Print("Stop Distance: ", DoubleToString(stopDistance, digits));
   Print("Contract Size: ", contractSize);
   Print("Loss per Lot: ", DoubleToString(lossPerLot, 2));
   Print("Calculated Lot Size: ", DoubleToString(lotSize, 2));
   
   return lotSize;
}

//+------------------------------------------------------------------+
//| Normalize lot size to broker requirements                         |
//+------------------------------------------------------------------+
double NormalizeLotSize(double lotSize, double minLot, double maxLot, double lotStep)
{
   if(lotSize <= 0) return 0.0;
   
   // Round down to nearest lot step
   lotSize = MathFloor(lotSize / lotStep) * lotStep;
   
   // Ensure within broker limits
   if(lotSize < minLot) lotSize = minLot;
   if(lotSize > maxLot) lotSize = maxLot;
   
   return lotSize;
}

//+------------------------------------------------------------------+
//| Identify key zones/levels in the market                          |
//+------------------------------------------------------------------+
void IdentifyKeyZones(string symbol)
{
   Print("=== IDENTIFYING KEY ZONES ===");
   
   // Clear existing zones
   for(int i = 0; i < maxZones; i++)
   {
      keyZones[i].isActive = false;
   }
   
   int zoneIndex = 0;
   
   // Identify zones from multiple timeframes
   IdentifyZonesFromTimeframe(symbol, PERIOD_H4, zoneIndex);
   IdentifyZonesFromTimeframe(symbol, PERIOD_H1, zoneIndex);
   IdentifyZonesFromTimeframe(symbol, PERIOD_M30, zoneIndex);
   IdentifyZonesFromTimeframe(symbol, PERIOD_M15, zoneIndex);
   
   // Identify psychological levels (round numbers)
   IdentifyPsychologicalLevels(symbol, zoneIndex);
   
   // Identify Fibonacci levels
   IdentifyFibonacciLevels(symbol, zoneIndex);
   
   Print("Total Key Zones Identified: ", zoneIndex);
   for(int i = 0; i < zoneIndex && i < maxZones; i++)
   {
      if(keyZones[i].isActive)
      {
         Print("Zone ", i+1, ": ", DoubleToString(keyZones[i].price, _Digits), 
               " | Type: ", (keyZones[i].isSupport ? "SUPPORT" : "RESISTANCE"));
      }
   }
}

//+------------------------------------------------------------------+
//| Identify zones from a specific timeframe                          |
//+------------------------------------------------------------------+
void IdentifyZonesFromTimeframe(string symbol, ENUM_TIMEFRAMES timeframe, int &zoneIndex)
{
   // Get swing highs and lows
   double swingHighs[];
   double swingLows[];
   ArraySetAsSeries(swingHighs, true);
   ArraySetAsSeries(swingLows, true);
   
   // Find swing points (local highs and lows)
   int lookback = 50;
   double high[], low[], close[];
   ArraySetAsSeries(high, true);
   ArraySetAsSeries(low, true);
   ArraySetAsSeries(close, true);
   
   if(CopyHigh(symbol, timeframe, 0, lookback, high) <= 0) return;
   if(CopyLow(symbol, timeframe, 0, lookback, low) <= 0) return;
   if(CopyClose(symbol, timeframe, 0, lookback, close) <= 0) return;
   
   // Find swing highs (local maxima)
   for(int i = 2; i < lookback - 2 && zoneIndex < maxZones; i++)
   {
      if(high[i] > high[i-1] && high[i] > high[i-2] && 
         high[i] > high[i+1] && high[i] > high[i+2])
      {
         // Found swing high
         double zonePrice = high[i];
         if(AddZone(zonePrice, false, true, zoneIndex))
         {
            zoneIndex++;
         }
      }
   }
   
   // Find swing lows (local minima)
   for(int i = 2; i < lookback - 2 && zoneIndex < maxZones; i++)
   {
      if(low[i] < low[i-1] && low[i] < low[i-2] && 
         low[i] < low[i+1] && low[i] < low[i+2])
      {
         // Found swing low
         double zonePrice = low[i];
         if(AddZone(zonePrice, true, false, zoneIndex))
         {
            zoneIndex++;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Add zone if not too close to existing zones                       |
//+------------------------------------------------------------------+
bool AddZone(double price, bool isSupport, bool isResistance, int &zoneIndex)
{
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   if(digits == 3 || digits == 5) point *= 10;
   
   double minDistance = 20 * point; // Minimum 20 pips between zones
   
   // Check if zone is too close to existing zones
   for(int i = 0; i < zoneIndex; i++)
   {
      if(keyZones[i].isActive)
      {
         if(MathAbs(keyZones[i].price - price) < minDistance)
         {
            return false; // Too close to existing zone
         }
      }
   }
   
   // Add new zone
   if(zoneIndex < maxZones)
   {
      keyZones[zoneIndex].price = NormalizeDouble(price, digits);
      keyZones[zoneIndex].isSupport = isSupport;
      keyZones[zoneIndex].isResistance = isResistance;
      keyZones[zoneIndex].lastTestTime = 0;
      keyZones[zoneIndex].testCount = 0;
      keyZones[zoneIndex].isActive = true;
      return true;
   }
   
   return false;
}

//+------------------------------------------------------------------+
//| Identify psychological levels (round numbers)                     |
//+------------------------------------------------------------------+
void IdentifyPsychologicalLevels(string symbol, int &zoneIndex)
{
   double currentPrice = SymbolInfoDouble(symbol, SYMBOL_BID);
   if(currentPrice <= 0) return;
   
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(digits == 3 || digits == 5) point *= 10;
   
   // Round to nearest significant level
   double roundLevel = 0.0;
   
   if(digits == 5) // 5-digit pairs (EURUSD)
   {
      roundLevel = MathRound(currentPrice * 100) / 100.0; // Round to 10 pips
   }
   else if(digits == 3) // 3-digit pairs (USDJPY)
   {
      roundLevel = MathRound(currentPrice * 10) / 10.0; // Round to 1 pip
   }
   else if(digits == 2) // 2-digit pairs (XAUUSD)
   {
      roundLevel = MathRound(currentPrice * 2) / 2.0; // Round to 0.5
   }
   
   // Add levels above and below current price
   for(int i = -5; i <= 5 && zoneIndex < maxZones; i++)
   {
      if(i == 0) continue; // Skip current level
      
      double level = roundLevel + (i * (point * 50)); // 50 pips apart
      bool isSupport = (level < currentPrice);
      bool isResistance = (level > currentPrice);
      
      if(AddZone(level, isSupport, isResistance, zoneIndex))
      {
         zoneIndex++;
      }
   }
}

//+------------------------------------------------------------------+
//| Identify Fibonacci retracement levels                            |
//+------------------------------------------------------------------+
void IdentifyFibonacciLevels(string symbol, int &zoneIndex)
{
   // Get recent swing high and low
   double swingHigh = FindHighestHigh(symbol, PERIOD_H4, 100);
   double swingLow = FindLowestLow(symbol, PERIOD_H4, 100);
   
   if(swingHigh <= 0 || swingLow <= 0 || swingHigh <= swingLow) return;
   
   double range = swingHigh - swingLow;
   double fibLevels[] = {0.236, 0.382, 0.500, 0.618, 0.786};
   
   for(int i = 0; i < ArraySize(fibLevels) && zoneIndex < maxZones; i++)
   {
      // Retracement from high
      double fibPriceHigh = swingHigh - (range * fibLevels[i]);
      bool isSupport = (fibPriceHigh < SymbolInfoDouble(symbol, SYMBOL_BID));
      
      if(AddZone(fibPriceHigh, isSupport, !isSupport, zoneIndex))
      {
         zoneIndex++;
      }
      
      // Retracement from low
      double fibPriceLow = swingLow + (range * fibLevels[i]);
      bool isResistance = (fibPriceLow > SymbolInfoDouble(symbol, SYMBOL_BID));
      
      if(AddZone(fibPriceLow, !isResistance, isResistance, zoneIndex))
      {
         zoneIndex++;
      }
   }
}

//+------------------------------------------------------------------+
//| Check for zone rejections and execute trades                      |
//+------------------------------------------------------------------+
int CheckZoneRejections(string symbol)
{
   double currentPrice = SymbolInfoDouble(symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   if(currentPrice <= 0 || ask <= 0) return 0;
   
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits == 3 || digits == 5) point *= 10;
   
   double zoneTolerance = 10 * point; // 10 pips tolerance for zone (strict for quality entries)
   
   // Get current candle data
   double open[], high[], low[], close[];
   ArraySetAsSeries(open, true);
   ArraySetAsSeries(high, true);
   ArraySetAsSeries(low, true);
   ArraySetAsSeries(close, true);
   
   if(CopyOpen(symbol, PERIOD_M15, 0, 3, open) <= 0) return 0;
   if(CopyHigh(symbol, PERIOD_M15, 0, 3, high) <= 0) return 0;
   if(CopyLow(symbol, PERIOD_M15, 0, 3, low) <= 0) return 0;
   if(CopyClose(symbol, PERIOD_M15, 0, 3, close) <= 0) return 0;
   
   // Check each active zone
   for(int i = 0; i < maxZones; i++)
   {
      if(!keyZones[i].isActive) continue;
      
      double zonePrice = keyZones[i].price;
      double distance = MathAbs(currentPrice - zonePrice);
      
      // Check if price is testing the zone
      if(distance <= zoneTolerance)
      {
         // Price is near zone - check for rejection
         bool rejectionDetected = false;
         int signal = 0;
         
         // Support zone rejection (bounce up = BUY signal) - stricter quality control
         if(keyZones[i].isSupport)
         {
            // Price must have tested support (touched zone) and closed well above
            bool testedSupport = (low[0] <= zonePrice + zoneTolerance) || 
                                 (low[1] <= zonePrice + zoneTolerance);
            
            // Require strong rejection - close must be significantly above support
            if(testedSupport && close[0] > zonePrice + (zoneTolerance * 0.5))
            {
               // Additional confirmation: check if current candle shows bullish momentum
               if(close[0] > open[0]) // Bullish candle
               {
                  rejectionDetected = true;
                  signal = 1; // BUY
                  Print("=== SUPPORT ZONE REJECTION DETECTED ===");
                  Print("Zone Price: ", zonePrice);
                  Print("Test Price: ", low[0]);
                  Print("Close Price: ", close[0]);
               }
            }
         }
         // Resistance zone rejection (bounce down = SELL signal) - stricter quality control
         else if(keyZones[i].isResistance)
         {
            // Price must have tested resistance (touched zone) and closed well below
            bool testedResistance = (high[0] >= zonePrice - zoneTolerance) || 
                                    (high[1] >= zonePrice - zoneTolerance);
            
            // Require strong rejection - close must be significantly below resistance
            if(testedResistance && close[0] < zonePrice - (zoneTolerance * 0.5))
            {
               // Additional confirmation: check if current candle shows bearish momentum
               if(close[0] < open[0]) // Bearish candle
               {
                  rejectionDetected = true;
                  signal = -1; // SELL
                  Print("=== RESISTANCE ZONE REJECTION DETECTED ===");
                  Print("Zone Price: ", zonePrice);
                  Print("Test Price: ", high[0]);
                  Print("Close Price: ", close[0]);
               }
            }
         }
         
         if(rejectionDetected)
         {
            // Check if this is a valid rejection (not too recent) - increased cooldown for quality
            datetime currentTime = TimeCurrent();
            if(keyZones[i].lastTestTime == 0 || (currentTime - keyZones[i].lastTestTime) > 3600) // 1 hour cooldown (increased for quality)
            {
               // Update zone tracking
               keyZones[i].lastTestTime = currentTime;
               keyZones[i].testCount++;
               
               return signal;
            }
         }
      }
   }
   
   return 0; // No rejection detected
}

//+------------------------------------------------------------------+
//| Check for rejections (zones or EMA 200)                           |
//+------------------------------------------------------------------+
int CheckForRejections(string symbol)
{
   // First check zone rejections
   int zoneSignal = CheckZoneRejections(symbol);
   if(zoneSignal != 0)
   {
      return zoneSignal;
   }
   
   // Then check EMA 200 rejection
   int emaSignal = CheckEMA200Rejection(symbol);
   if(emaSignal != 0)
   {
      return emaSignal;
   }
   
   return 0; // No rejection detected
}

//+------------------------------------------------------------------+
//| Check for EMA 200 rejection on M15 timeframe                      |
//+------------------------------------------------------------------+
int CheckEMA200Rejection(string symbol)
{
   // Get EMA 200 on M15
   int emaHandle = iMA(symbol, PERIOD_M15, 200, 0, MODE_EMA, PRICE_CLOSE);
   if(emaHandle == INVALID_HANDLE) return 0;
   
   double ema[];
   ArraySetAsSeries(ema, true);
   ArrayResize(ema, 3);
   
   if(CopyBuffer(emaHandle, 0, 0, 3, ema) <= 0)
   {
      IndicatorRelease(emaHandle);
      return 0;
   }
   
   IndicatorRelease(emaHandle);
   
   // Get current price and candle data
   double currentPrice = SymbolInfoDouble(symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   
   double open[], high[], low[], close[];
   ArraySetAsSeries(open, true);
   ArraySetAsSeries(high, true);
   ArraySetAsSeries(low, true);
   ArraySetAsSeries(close, true);
   
   if(CopyOpen(symbol, PERIOD_M15, 0, 3, open) <= 0) return 0;
   if(CopyHigh(symbol, PERIOD_M15, 0, 3, high) <= 0) return 0;
   if(CopyLow(symbol, PERIOD_M15, 0, 3, low) <= 0) return 0;
   if(CopyClose(symbol, PERIOD_M15, 0, 3, close) <= 0) return 0;
   
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits == 3 || digits == 5) point *= 10;
   
   double emaTolerance = 15 * point; // 15 pips tolerance (strict for quality)
   double ema200 = ema[0];
   
   // Check if price tested EMA 200
   bool testedEMA = false;
   bool rejectionDetected = false;
   int signal = 0;
   
   // Check if price touched EMA 200 (within tolerance) - check current and previous candles
   if((low[0] <= ema200 + emaTolerance && low[0] >= ema200 - emaTolerance) ||
      (high[0] <= ema200 + emaTolerance && high[0] >= ema200 - emaTolerance) ||
      (low[1] <= ema200 + emaTolerance && low[1] >= ema200 - emaTolerance) ||
      (high[1] <= ema200 + emaTolerance && high[1] >= ema200 - emaTolerance) ||
      (low[2] <= ema200 + emaTolerance && low[2] >= ema200 - emaTolerance) ||
      (high[2] <= ema200 + emaTolerance && high[2] >= ema200 - emaTolerance))
   {
      testedEMA = true;
      
      // Check for rejection: Support rejection (bounce up from EMA 200) - stricter
      if((low[0] <= ema200 + emaTolerance || low[1] <= ema200 + emaTolerance) && 
         close[0] > ema200 + (emaTolerance * 0.5) && close[0] > open[0]) // Must close well above and be bullish candle
      {
         rejectionDetected = true;
         signal = 1; // BUY signal
         Print("=== EMA 200 SUPPORT REJECTION DETECTED ===");
         Print("EMA 200: ", ema200);
         Print("Test Low: ", low[0]);
         Print("Close Price: ", close[0]);
      }
      // Check for rejection: Resistance rejection (bounce down from EMA 200) - stricter
      else if((high[0] >= ema200 - emaTolerance || high[1] >= ema200 - emaTolerance) && 
              close[0] < ema200 - (emaTolerance * 0.5) && close[0] < open[0]) // Must close well below and be bearish candle
      {
         rejectionDetected = true;
         signal = -1; // SELL signal
         Print("=== EMA 200 RESISTANCE REJECTION DETECTED ===");
         Print("EMA 200: ", ema200);
         Print("Test High: ", high[0]);
         Print("Close Price: ", close[0]);
      }
   }
   
   if(rejectionDetected)
   {
      return signal;
   }
   
   return 0; // No EMA 200 rejection
}

//+------------------------------------------------------------------+
//| Find nearest support level below price                            |
//+------------------------------------------------------------------+
double FindNearestSupportLevel(string symbol, double price)
{
   double nearestSupport = 0.0;
   double minDistance = DBL_MAX;
   
   // Check identified zones first
   for(int i = 0; i < maxZones; i++)
   {
      if(!keyZones[i].isActive) continue;
      if(!keyZones[i].isSupport) continue;
      
      double zonePrice = keyZones[i].price;
      if(zonePrice < price)
      {
         double distance = price - zonePrice;
         if(distance < minDistance)
         {
            minDistance = distance;
            nearestSupport = zonePrice;
         }
      }
   }
   
   // Also check recent swing lows from M15
   double swingLow = FindLowestLow(symbol, PERIOD_M15, 30);
   if(swingLow > 0 && swingLow < price)
   {
      double distance = price - swingLow;
      if(distance < minDistance)
      {
         nearestSupport = swingLow;
      }
   }
   
   return nearestSupport;
}

//+------------------------------------------------------------------+
//| Find nearest resistance level above price                        |
//+------------------------------------------------------------------+
double FindNearestResistanceLevel(string symbol, double price)
{
   double nearestResistance = 0.0;
   double minDistance = DBL_MAX;
   
   // Check identified zones first
   for(int i = 0; i < maxZones; i++)
   {
      if(!keyZones[i].isActive) continue;
      if(!keyZones[i].isResistance) continue;
      
      double zonePrice = keyZones[i].price;
      if(zonePrice > price)
      {
         double distance = zonePrice - price;
         if(distance < minDistance)
         {
            minDistance = distance;
            nearestResistance = zonePrice;
         }
      }
   }
   
   // Also check recent swing highs from M15
   double swingHigh = FindHighestHigh(symbol, PERIOD_M15, 30);
   if(swingHigh > 0 && swingHigh > price)
   {
      double distance = swingHigh - price;
      if(distance < minDistance)
      {
         nearestResistance = swingHigh;
      }
   }
   
   return nearestResistance;
}

//+------------------------------------------------------------------+
//| Calculate take profit levels from market structure                |
//+------------------------------------------------------------------+
int CalculateTakeProfitsFromStructure(string symbol, bool isBuy, double entryPrice, double stopLoss, double &tps[])
{
   int tpCount = 0;
   ArrayInitialize(tps, 0.0);
   
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(digits == 3 || digits == 5) point *= 10;
   
   if(isBuy)
   {
      // For BUY: Find next resistance levels above entry
      double resistances[];
      ArrayResize(resistances, 10);
      int resCount = FindNextResistanceLevels(symbol, entryPrice, resistances);
      
      // Use first 3 resistance levels as TP targets
      for(int i = 0; i < resCount && tpCount < 3; i++)
      {
         if(resistances[i] > entryPrice)
         {
            // Ensure TP is at least 1.2x the stop distance (minimum R:R)
            double stopDistance = entryPrice - stopLoss;
            double minTP = entryPrice + (stopDistance * 1.2);
            
            if(resistances[i] >= minTP)
            {
               tps[tpCount] = NormalizeDouble(resistances[i], digits);
               tpCount++;
            }
         }
      }
      
      // If not enough resistance levels, use Fibonacci extensions
      if(tpCount < 3)
      {
         double stopDistance = entryPrice - stopLoss;
         double fibExtensions[] = {1.272, 1.618, 2.618};
         
         for(int i = tpCount; i < 3; i++)
         {
            double fibTP = entryPrice + (stopDistance * fibExtensions[i - tpCount]);
            tps[i] = NormalizeDouble(fibTP, digits);
            tpCount++;
         }
      }
   }
   else
   {
      // For SELL: Find next support levels below entry
      double supports[];
      ArrayResize(supports, 10);
      int supCount = FindNextSupportLevels(symbol, entryPrice, supports);
      
      // Use first 3 support levels as TP targets
      for(int i = 0; i < supCount && tpCount < 3; i++)
      {
         if(supports[i] < entryPrice)
         {
            // Ensure TP is at least 1.5x the stop distance (better R:R)
            double stopDistance = stopLoss - entryPrice;
            double minTP = entryPrice - (stopDistance * 1.5);
            
            if(supports[i] <= minTP)
            {
               tps[tpCount] = NormalizeDouble(supports[i], digits);
               tpCount++;
            }
         }
      }
      
      // If not enough support levels, use Fibonacci extensions with better R:R
      if(tpCount < 3)
      {
         double stopDistance = stopLoss - entryPrice;
         double fibExtensions[] = {1.5, 2.0, 3.0}; // Better risk:reward ratios
         
         for(int i = tpCount; i < 3; i++)
         {
            double fibTP = entryPrice - (stopDistance * fibExtensions[i - tpCount]);
            tps[i] = NormalizeDouble(fibTP, digits);
            tpCount++;
         }
      }
   }
   
   Print("=== TAKE PROFIT CALCULATION ===");
   Print("TP1: ", tps[0]);
   Print("TP2: ", tps[1]);
   Print("TP3: ", tps[2]);
   
   return tpCount;
}

//+------------------------------------------------------------------+
//| Find next resistance levels above price                          |
//+------------------------------------------------------------------+
int FindNextResistanceLevels(string symbol, double price, double &levels[])
{
   int count = 0;
   ArrayInitialize(levels, 0.0);
   
   // Collect all resistance levels above price
   double tempLevels[];
   ArrayResize(tempLevels, 50);
   int tempCount = 0;
   
   // From identified zones
   for(int i = 0; i < maxZones; i++)
   {
      if(!keyZones[i].isActive) continue;
      if(!keyZones[i].isResistance) continue;
      
      if(keyZones[i].price > price)
      {
         tempLevels[tempCount] = keyZones[i].price;
         tempCount++;
      }
   }
   
   // From swing highs
   for(int tf = 0; tf < 3; tf++)
   {
      ENUM_TIMEFRAMES timeframes[] = {PERIOD_M15, PERIOD_M30, PERIOD_H1};
      double swingHigh = FindHighestHigh(symbol, timeframes[tf], 50);
      
      if(swingHigh > price)
      {
         bool exists = false;
         for(int j = 0; j < tempCount; j++)
         {
            if(MathAbs(tempLevels[j] - swingHigh) < 10 * SymbolInfoDouble(symbol, SYMBOL_POINT))
            {
               exists = true;
               break;
            }
         }
         if(!exists)
         {
            tempLevels[tempCount] = swingHigh;
            tempCount++;
         }
      }
   }
   
   // Sort and return closest 10
   ArraySort(tempLevels);
   
   for(int i = 0; i < tempCount && count < 10; i++)
   {
      if(tempLevels[i] > price)
      {
         levels[count] = tempLevels[i];
         count++;
      }
   }
   
   return count;
}

//+------------------------------------------------------------------+
//| Find next support levels below price                              |
//+------------------------------------------------------------------+
int FindNextSupportLevels(string symbol, double price, double &levels[])
{
   int count = 0;
   ArrayInitialize(levels, 0.0);
   
   // Collect all support levels below price
   double tempLevels[];
   ArrayResize(tempLevels, 50);
   int tempCount = 0;
   
   // From identified zones
   for(int i = 0; i < maxZones; i++)
   {
      if(!keyZones[i].isActive) continue;
      if(!keyZones[i].isSupport) continue;
      
      if(keyZones[i].price < price)
      {
         tempLevels[tempCount] = keyZones[i].price;
         tempCount++;
      }
   }
   
   // From swing lows
   for(int tf = 0; tf < 3; tf++)
   {
      ENUM_TIMEFRAMES timeframes[] = {PERIOD_M15, PERIOD_M30, PERIOD_H1};
      double swingLow = FindLowestLow(symbol, timeframes[tf], 50);
      
      if(swingLow < price)
      {
         bool exists = false;
         for(int j = 0; j < tempCount; j++)
         {
            if(MathAbs(tempLevels[j] - swingLow) < 10 * SymbolInfoDouble(symbol, SYMBOL_POINT))
            {
               exists = true;
               break;
            }
         }
         if(!exists)
         {
            tempLevels[tempCount] = swingLow;
            tempCount++;
         }
      }
   }
   
   // Sort and return closest 10 (descending order for supports)
   // Sort ascending first, then reverse
   ArraySort(tempLevels);
   // Reverse array for descending order
   int size = ArraySize(tempLevels);
   for(int i = 0; i < size / 2; i++)
   {
      double temp = tempLevels[i];
      tempLevels[i] = tempLevels[size - 1 - i];
      tempLevels[size - 1 - i] = temp;
   }
   
   for(int i = 0; i < tempCount && count < 10; i++)
   {
      if(tempLevels[i] < price)
      {
         levels[count] = tempLevels[i];
         count++;
      }
   }
   
   return count;
}
//+------------------------------------------------------------------+

