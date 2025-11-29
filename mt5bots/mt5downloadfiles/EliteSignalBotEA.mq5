//+------------------------------------------------------------------+
//|                                          EliteSignalBotEA.mq5    |
//|                        Magic Automation Lab - Elite Signal Bot   |
//|                                    Fully Automated Trading EA    |
//+------------------------------------------------------------------+
#property copyright "Magic Automation Lab"
#property link      "https://magicbotslab.com"
#property version   "1.00"
#property description "Elite Signal Bot - Multi-indicator analysis with automatic trade execution"
#property description "Risks 1% of account balance per signal"
#property description "Runs 24/7 with automatic TP and SL management"

#include <Trade\Trade.mqh>
#include <Trade\AccountInfo.mqh>
#include <Trade\SymbolInfo.mqh>
#include <Trade\PositionInfo.mqh>

//--- Input Parameters
input group "=== Signal Generation Settings ==="
input int      InpRSIPeriod = 14;              // RSI Period
input int      InpMACDFast = 12;                // MACD Fast EMA
input int      InpMACDSlow = 26;                // MACD Slow EMA
input int      InpMACDSignal = 9;               // MACD Signal Period
input int      InpSMAPeriod = 20;               // SMA Period
input int      InpEMAPeriod = 12;               // EMA Period
input int      InpBBPeriod = 20;                 // Bollinger Bands Period
input double   InpBBDeviation = 2.0;            // Bollinger Bands Deviation
input int      InpATRPeriod = 14;               // ATR Period
input double   InpMinConfidence = 30.0;         // Minimum Confidence % (30-100) - Lowered for more signals
input int      InpSignalCooldown = 30;          // Signal Cooldown (seconds) - Reduced for more signals

input group "=== Risk Management ==="
input double   InpRiskPercent = 1.0;            // Risk Per Trade (% of balance)
input double   InpTP1Multiplier = 1.5;          // TP1 Risk:Reward Ratio
input double   InpTP2Multiplier = 2.5;          // TP2 Risk:Reward Ratio
input double   InpTP3Multiplier = 4.0;           // TP3 Risk:Reward Ratio
input bool     InpUseTP1 = true;                // Use TP1
input bool     InpUseTP2 = true;                // Use TP2
input bool     InpUseTP3 = true;                // Use TP3

input group "=== Trading Settings ==="
input string   InpSymbols = "EURUSD,GBPUSD,USDJPY,XAUUSD,AUDUSD,USDCAD,USDCHF,EURGBP,EURAUD,EURCAD"; // Symbols to Trade (comma-separated)
input ENUM_TIMEFRAMES InpTimeframe = PERIOD_M15; // Analysis Timeframe
input int      InpMagicNumber = 123456;          // Magic Number
input string   InpTradeComment = "EliteSignalBot"; // Trade Comment

//--- Global Variables
CTrade         trade;
CAccountInfo   account;
CSymbolInfo    symbolInfo;

string         symbols[];
datetime       lastSignalTime[];
double         priceHistory[][100];  // Fixed: Proper 2D array declaration
int            historySize = 100;

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
   
   // Parse symbols
   ParseSymbols();
   
   // Initialize last signal time array
   ArrayResize(lastSignalTime, ArraySize(symbols));
   ArrayInitialize(lastSignalTime, 0);
   
   // Initialize price history arrays
   int symbolCount = ArraySize(symbols);
   ArrayResize(priceHistory, symbolCount);
   for(int i = 0; i < symbolCount; i++)
   {
      // Initialize each element manually (MQL5 doesn't support ArrayInitialize on 2D array rows)
      for(int j = 0; j < historySize; j++)
      {
         priceHistory[i][j] = 0.0;
      }
   }
   
   Print("Elite Signal Bot EA initialized successfully");
   Print("Symbols to monitor: ", InpSymbols);
   Print("Number of symbols parsed: ", ArraySize(symbols));
   for(int i = 0; i < ArraySize(symbols); i++)
   {
      Print("Symbol ", i, ": ", symbols[i]);
   }
   Print("Risk per trade: ", InpRiskPercent, "%");
   Print("Minimum confidence: ", InpMinConfidence, "%");
   Print("Signal cooldown: ", InpSignalCooldown, " seconds");
   Print("Analysis timeframe: ", EnumToString(InpTimeframe));
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("Elite Signal Bot EA stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // Analyze all symbols
   static datetime lastAnalysisTime = 0;
   datetime currentTime = TimeCurrent();
   
   // Analyze every 1 second for faster signal generation
   if(currentTime - lastAnalysisTime < 1)
      return;
   
   lastAnalysisTime = currentTime;
   
   for(int i = 0; i < ArraySize(symbols); i++)
   {
      AnalyzeSymbol(symbols[i], i);
   }
}

//+------------------------------------------------------------------+
//| Parse symbols from input string                                  |
//+------------------------------------------------------------------+
void ParseSymbols()
{
   string tempSymbols = InpSymbols;
   int count = 0;
   string result[];
   
   // Count symbols
   int pos = 0;
   while(pos >= 0)
   {
      pos = StringFind(tempSymbols, ",", pos);
      if(pos >= 0)
      {
         count++;
         pos++;
      }
   }
   count++; // Last symbol
   
   ArrayResize(result, count);
   pos = 0;
   int start = 0;
   count = 0;
   
   while(pos >= 0 && count < ArraySize(result))
   {
      pos = StringFind(tempSymbols, ",", start);
      if(pos >= 0)
      {
         result[count] = StringSubstr(tempSymbols, start, pos - start);
         StringTrimLeft(result[count]);
         StringTrimRight(result[count]);
         start = pos + 1;
         count++;
      }
      else
      {
         result[count] = StringSubstr(tempSymbols, start);
         StringTrimLeft(result[count]);
         StringTrimRight(result[count]);
         count++;
      }
   }
   
   ArrayResize(symbols, count);
   ArrayCopy(symbols, result, 0, 0, count);
}

//+------------------------------------------------------------------+
//| Analyze symbol and generate signals                              |
//+------------------------------------------------------------------+
void AnalyzeSymbol(string symbolName, int symbolIndex)
{
   // Set and refresh symbol info for this symbol
   if(!symbolInfo.Name(symbolName))
   {
      static datetime lastError = 0;
      if(TimeCurrent() - lastError > 300)
      {
         Print("Invalid symbol: ", symbolName);
         lastError = TimeCurrent();
      }
      return;
   }
   
   // Refresh rates to get current prices
   if(!symbolInfo.RefreshRates())
   {
      static datetime lastError2 = 0;
      if(TimeCurrent() - lastError2 > 300)
      {
         Print("Failed to refresh rates for: ", symbolName);
         lastError2 = TimeCurrent();
      }
      return;
   }
   
   // Check cooldown period
   if(TimeCurrent() - lastSignalTime[symbolIndex] < InpSignalCooldown)
      return;
   
   // Update price history
   UpdatePriceHistory(symbolName, symbolIndex);
   
   // Need at least 20 candles for analysis (further reduced for faster signal generation)
   int historyCount = 0;
   for(int i = 0; i < historySize; i++)
   {
      if(priceHistory[symbolIndex][i] > 0) historyCount++;
   }
   if(historyCount < 20)
   {
      static datetime lastWarning = 0;
      if(TimeCurrent() - lastWarning > 60) // Warn once per minute
      {
         Print("Waiting for more data: ", symbolName, " - ", historyCount, "/20 candles");
         lastWarning = TimeCurrent();
      }
      return;
   }
   
   // Calculate indicators
   double rsi = CalculateRSI(symbolName, symbolIndex);
   if(rsi <= 0 || rsi >= 100)
   {
      static datetime lastError3 = 0;
      if(TimeCurrent() - lastError3 > 300)
      {
         Print("Invalid RSI for ", symbolName, ": ", rsi);
         lastError3 = TimeCurrent();
      }
      return;
   }
   
   double macd[], macdSignal[], macdHistogram[];
   CalculateMACD(symbolName, symbolIndex, macd, macdSignal, macdHistogram);
   double sma20 = CalculateSMA(symbolName, symbolIndex, InpSMAPeriod);
   double ema12 = CalculateEMA(symbolName, symbolIndex, InpEMAPeriod);
   double ema26 = CalculateEMA(symbolName, symbolIndex, 26);
   double bbUpper[], bbMiddle[], bbLower[];
   CalculateBollingerBands(symbolName, symbolIndex, bbUpper, bbMiddle, bbLower);
   double atr = CalculateATR(symbolName, symbolIndex);
   
   // Validate critical indicators
   if(sma20 <= 0 || ema12 <= 0 || ema26 <= 0 || atr <= 0)
   {
      return; // Skip if indicators are invalid
   }
   
   // Get current price - use Bid for analysis (will use correct price in ExecuteTrade)
   double currentPrice = symbolInfo.Bid();
   if(currentPrice <= 0)
   {
      Print("Invalid price for ", symbolName, ": ", currentPrice);
      return;
   }
   
   // Generate signal
   int signal = GenerateSignal(symbolName, currentPrice, rsi, macd, macdSignal, macdHistogram, 
                              sma20, ema12, ema26, bbUpper, bbMiddle, bbLower, atr, symbolIndex);
   
   // Debug: Log analysis results periodically
   static datetime lastDebugTime = 0;
   static int debugCounter = 0;
   if(TimeCurrent() - lastDebugTime > 300) // Every 5 minutes
   {
      int digits = symbolInfo.Digits();
      Print("Analysis: ", symbolName, " | RSI: ", DoubleToString(rsi, 2), 
            " | Price: ", DoubleToString(currentPrice, digits), " | Signal: ", (signal == 0 ? "NONE" : (signal == ORDER_TYPE_BUY ? "BUY" : "SELL")));
      lastDebugTime = TimeCurrent();
      debugCounter++;
   }
   
   // Execute trade if signal generated
   if(signal != 0)
   {
      int digits = symbolInfo.Digits();
      double askPrice = symbolInfo.Ask();
      double bidPrice = symbolInfo.Bid();
      
      Print("=== SIGNAL GENERATED ===");
      Print("Symbol: ", symbolName);
      Print("Signal Type: ", (signal == ORDER_TYPE_BUY ? "BUY" : "SELL"));
      Print("Bid Price: ", DoubleToString(bidPrice, digits));
      Print("Ask Price: ", DoubleToString(askPrice, digits));
      Print("RSI: ", DoubleToString(rsi, 2));
      Print("ATR: ", DoubleToString(atr, digits));
      Print("Attempting to execute trade...");
      
      lastSignalTime[symbolIndex] = TimeCurrent();
      ExecuteTrade(symbolName, signal, atr, bbUpper, bbLower);
   }
}

//+------------------------------------------------------------------+
//| Update price history                                             |
//+------------------------------------------------------------------+
void UpdatePriceHistory(string symbolName, int symbolIndex)
{
   double close[];
   ArraySetAsSeries(close, true);
   
   int copied = CopyClose(symbolName, InpTimeframe, 0, historySize, close);
   if(copied <= 0)
   {
      static datetime lastError = 0;
      if(TimeCurrent() - lastError > 60) // Log error once per minute
      {
         Print("Failed to copy close prices for ", symbolName, " | Error: ", GetLastError());
         lastError = TimeCurrent();
      }
      return;
   }
   
   // Store in reverse order (newest first)
   int closeCount = ArraySize(close);
   int copyCount = (closeCount < historySize) ? closeCount : historySize;
   for(int i = 0; i < copyCount; i++)
   {
      priceHistory[symbolIndex][historySize - 1 - i] = close[i];
   }
}

//+------------------------------------------------------------------+
//| Calculate RSI                                                   |
//+------------------------------------------------------------------+
double CalculateRSI(string symbolName, int symbolIndex)
{
   int rsiHandle = iRSI(symbolName, InpTimeframe, InpRSIPeriod, PRICE_CLOSE);
   if(rsiHandle == INVALID_HANDLE)
   {
      Print("Failed to create RSI indicator for ", symbolName);
      return 50.0;
   }
   
   double rsi[];
   ArraySetAsSeries(rsi, true);
   if(CopyBuffer(rsiHandle, 0, 0, 1, rsi) <= 0)
   {
      IndicatorRelease(rsiHandle);
      return 50.0;
   }
   
   IndicatorRelease(rsiHandle);
   return rsi[0];
}

//+------------------------------------------------------------------+
//| Calculate MACD                                                  |
//+------------------------------------------------------------------+
void CalculateMACD(string symbolName, int symbolIndex, double &macd[], double &signal[], double &histogram[])
{
   int macdHandle = iMACD(symbolName, InpTimeframe, InpMACDFast, InpMACDSlow, InpMACDSignal, PRICE_CLOSE);
   if(macdHandle == INVALID_HANDLE)
   {
      Print("Failed to create MACD indicator for ", symbolName);
      ArrayResize(macd, 1);
      ArrayResize(signal, 1);
      ArrayResize(histogram, 1);
      macd[0] = 0.0;
      signal[0] = 0.0;
      histogram[0] = 0.0;
      return;
   }
   
   ArraySetAsSeries(macd, true);
   ArraySetAsSeries(signal, true);
   ArraySetAsSeries(histogram, true);
   ArrayResize(macd, 1);
   ArrayResize(signal, 1);
   ArrayResize(histogram, 1);
   
   if(CopyBuffer(macdHandle, 0, 0, 1, macd) <= 0 ||
      CopyBuffer(macdHandle, 1, 0, 1, signal) <= 0 ||
      CopyBuffer(macdHandle, 2, 0, 1, histogram) <= 0)
   {
      IndicatorRelease(macdHandle);
      macd[0] = 0.0;
      signal[0] = 0.0;
      histogram[0] = 0.0;
      return;
   }
   
   IndicatorRelease(macdHandle);
}

//+------------------------------------------------------------------+
//| Calculate SMA                                                   |
//+------------------------------------------------------------------+
double CalculateSMA(string symbolName, int symbolIndex, int period)
{
   int smaHandle = iMA(symbolName, InpTimeframe, period, 0, MODE_SMA, PRICE_CLOSE);
   if(smaHandle == INVALID_HANDLE)
   {
      Print("Failed to create SMA indicator for ", symbolName);
      return 0.0;
   }
   
   double sma[];
   ArraySetAsSeries(sma, true);
   if(CopyBuffer(smaHandle, 0, 0, 1, sma) <= 0)
   {
      IndicatorRelease(smaHandle);
      return 0.0;
   }
   
   IndicatorRelease(smaHandle);
   return sma[0];
}

//+------------------------------------------------------------------+
//| Calculate EMA                                                   |
//+------------------------------------------------------------------+
double CalculateEMA(string symbolName, int symbolIndex, int period)
{
   int emaHandle = iMA(symbolName, InpTimeframe, period, 0, MODE_EMA, PRICE_CLOSE);
   if(emaHandle == INVALID_HANDLE)
   {
      Print("Failed to create EMA indicator for ", symbolName);
      return 0.0;
   }
   
   double ema[];
   ArraySetAsSeries(ema, true);
   if(CopyBuffer(emaHandle, 0, 0, 1, ema) <= 0)
   {
      IndicatorRelease(emaHandle);
      return 0.0;
   }
   
   IndicatorRelease(emaHandle);
   return ema[0];
}

//+------------------------------------------------------------------+
//| Calculate Bollinger Bands                                       |
//+------------------------------------------------------------------+
void CalculateBollingerBands(string symbolName, int symbolIndex, double &upper[], double &middle[], double &lower[])
{
   int bbHandle = iBands(symbolName, InpTimeframe, InpBBPeriod, 0, InpBBDeviation, PRICE_CLOSE);
   if(bbHandle == INVALID_HANDLE)
   {
      Print("Failed to create Bollinger Bands indicator for ", symbolName);
      ArrayResize(upper, 1);
      ArrayResize(middle, 1);
      ArrayResize(lower, 1);
      upper[0] = 0.0;
      middle[0] = 0.0;
      lower[0] = 0.0;
      return;
   }
   
   ArraySetAsSeries(upper, true);
   ArraySetAsSeries(middle, true);
   ArraySetAsSeries(lower, true);
   ArrayResize(upper, 1);
   ArrayResize(middle, 1);
   ArrayResize(lower, 1);
   
   if(CopyBuffer(bbHandle, 1, 0, 1, upper) <= 0 ||
      CopyBuffer(bbHandle, 0, 0, 1, middle) <= 0 ||
      CopyBuffer(bbHandle, 2, 0, 1, lower) <= 0)
   {
      IndicatorRelease(bbHandle);
      upper[0] = 0.0;
      middle[0] = 0.0;
      lower[0] = 0.0;
      return;
   }
   
   IndicatorRelease(bbHandle);
}

//+------------------------------------------------------------------+
//| Calculate ATR                                                   |
//+------------------------------------------------------------------+
double CalculateATR(string symbolName, int symbolIndex)
{
   int atrHandle = iATR(symbolName, InpTimeframe, InpATRPeriod);
   if(atrHandle == INVALID_HANDLE)
   {
      Print("Failed to create ATR indicator for ", symbolName);
      return 0.0;
   }
   
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
//| Generate trading signal                                         |
//+------------------------------------------------------------------+
int GenerateSignal(string symbolName, double currentPrice, double rsi, double &macd[], double &signal[], 
                   double &histogram[], double sma20, double ema12, double ema26, 
                   double &bbUpper[], double &bbLower[], double &bbMiddle[], double atr, int symbolIndex)
{
   double buyScore = 0.0;
   double sellScore = 0.0;
   
   // RSI Analysis (balanced for both BUY and SELL signals - independent scoring)
   if(rsi < 40.0) buyScore += 30.0;        // Strong oversold - strong buy signal
   if(rsi < 45.0 && rsi >= 40.0) buyScore += 25.0;   // Oversold - buy signal
   if(rsi < 50.0 && rsi >= 45.0) buyScore += 15.0;   // Below neutral - slight buy bias
   if(rsi > 60.0) sellScore += 30.0;       // Strong overbought - strong sell signal
   if(rsi > 55.0 && rsi <= 60.0) sellScore += 25.0;  // Overbought - sell signal
   if(rsi > 50.0 && rsi <= 55.0) sellScore += 15.0;  // Above neutral - slight sell bias
   
   // Additional balanced scoring for neutral RSI (40-60 range)
   if(rsi >= 40.0 && rsi <= 60.0)
   {
      // Give points to both sides based on other factors when RSI is neutral
      if(rsi < 50.0) buyScore += 5.0;  // Slight buy bias when below 50
      if(rsi > 50.0) sellScore += 5.0; // Slight sell bias when above 50
   }
   
   // MACD Analysis (more balanced)
   if(ArraySize(histogram) > 0 && ArraySize(macd) > 0 && ArraySize(signal) > 0)
   {
      if(histogram[0] > 0 && macd[0] > signal[0]) 
      {
         buyScore += 20.0;  // Bullish MACD
      }
      else if(histogram[0] < 0 && macd[0] < signal[0]) 
      {
         sellScore += 20.0; // Bearish MACD
      }
      // Also give points when MACD is crossing (potential reversal)
      if(histogram[0] > 0 && macd[0] < signal[0]) buyScore += 10.0;  // MACD crossing up
      if(histogram[0] < 0 && macd[0] > signal[0]) sellScore += 10.0; // MACD crossing down
   }
   
   // Moving Average Crossover (balanced for both directions)
   if(sma20 > 0 && ema12 > 0 && ema26 > 0)
   {
      double sma50 = CalculateSMA(symbolName, symbolIndex, 50);
      if(sma50 > 0)
      {
         if(sma20 > sma50 && ema12 > ema26) buyScore += 20.0;   // Uptrend - buy signal
         else if(sma20 < sma50 && ema12 < ema26) sellScore += 20.0; // Downtrend - sell signal
         // Also check price position relative to MAs for additional signals
         if(currentPrice > sma20 && currentPrice > sma50) buyScore += 10.0;  // Price above MAs - bullish
         else if(currentPrice < sma20 && currentPrice < sma50) sellScore += 10.0; // Price below MAs - bearish
      }
   }
   
   // Bollinger Bands (more balanced)
   if(ArraySize(bbUpper) > 0 && ArraySize(bbLower) > 0 && ArraySize(bbMiddle) > 0)
   {
      double bbRange = bbUpper[0] - bbLower[0];
      if(bbRange > 0)
      {
         double priceFromLower = (currentPrice - bbLower[0]) / bbRange;
         double priceFromUpper = (bbUpper[0] - currentPrice) / bbRange;
         double priceFromMiddle = (currentPrice - bbMiddle[0]) / bbRange;
         
         // Near lower band - buy signal
         if(priceFromLower < 0.10) buyScore += 20.0;
         else if(priceFromLower < 0.20) buyScore += 10.0;
         
         // Near upper band - sell signal
         if(priceFromUpper < 0.10) sellScore += 20.0;
         else if(priceFromUpper < 0.20) sellScore += 10.0;
         
         // Price position relative to middle band
         if(priceFromMiddle > 0.5) sellScore += 5.0;  // Price in upper half
         else if(priceFromMiddle < 0.5) buyScore += 5.0; // Price in lower half
      }
   }
   
   // Trend confirmation (balanced for both directions)
   int validHistoryCount = 0;
   for(int i = 0; i < historySize; i++)
   {
      if(priceHistory[symbolIndex][i] > 0) validHistoryCount++;
   }
   if(validHistoryCount >= 20)
   {
      double trend = CalculateTrend(symbolIndex);
      if(trend > 0.1) buyScore += 15.0;      // Strong uptrend - buy signal
      else if(trend > 0) buyScore += 10.0;  // Weak uptrend - slight buy bias
      else if(trend < -0.1) sellScore += 15.0; // Strong downtrend - sell signal
      else if(trend < 0) sellScore += 10.0;   // Weak downtrend - slight sell bias
   }
   
   // Log scores for debugging (always log when scores are significant)
   static datetime lastScoreLog = 0;
   if(TimeCurrent() - lastScoreLog > 30) // Log every 30 seconds
   {
      if(buyScore >= InpMinConfidence || sellScore >= InpMinConfidence)
      {
         Print("Signal Scores - ", symbolName, " | BuyScore: ", DoubleToString(buyScore, 1), 
               " | SellScore: ", DoubleToString(sellScore, 1), " | RSI: ", DoubleToString(rsi, 2),
               " | MinConfidence: ", InpMinConfidence);
      }
      lastScoreLog = TimeCurrent();
   }
   
   // Check minimum confidence - ensure both can trigger
   if(buyScore >= InpMinConfidence && buyScore > sellScore)
   {
      Print("=== BUY SIGNAL GENERATED ===");
      Print("Symbol: ", symbolName);
      Print("BuyScore: ", DoubleToString(buyScore, 1));
      Print("SellScore: ", DoubleToString(sellScore, 1));
      Print("RSI: ", DoubleToString(rsi, 2));
      Print("Confidence: ", DoubleToString(buyScore, 1), "%");
      return ORDER_TYPE_BUY;
   }
   else if(sellScore >= InpMinConfidence && sellScore > buyScore)
   {
      Print("=== SELL SIGNAL GENERATED ===");
      Print("Symbol: ", symbolName);
      Print("BuyScore: ", DoubleToString(buyScore, 1));
      Print("SellScore: ", DoubleToString(sellScore, 1));
      Print("RSI: ", DoubleToString(rsi, 2));
      Print("Confidence: ", DoubleToString(sellScore, 1), "%");
      return ORDER_TYPE_SELL;
   }
   
   return 0; // No signal
}

//+------------------------------------------------------------------+
//| Calculate trend                                                 |
//+------------------------------------------------------------------+
double CalculateTrend(int symbolIndex)
{
   // Find first and last valid prices
   double first = 0.0;
   double last = 0.0;
   int firstIndex = -1;
   int lastIndex = -1;
   
   // Find first valid price (oldest)
   for(int i = historySize - 1; i >= 0; i--)
   {
      if(priceHistory[symbolIndex][i] > 0)
      {
         first = priceHistory[symbolIndex][i];
         firstIndex = i;
         break;
      }
   }
   
   // Find last valid price (newest)
   for(int i = 0; i < historySize; i++)
   {
      if(priceHistory[symbolIndex][i] > 0)
      {
         last = priceHistory[symbolIndex][i];
         lastIndex = i;
      }
   }
   
   if(first == 0.0 || last == 0.0 || firstIndex == -1 || lastIndex == -1)
      return 0.0;
   
   // Need at least 20 candles difference
   if(MathAbs(lastIndex - firstIndex) < 20)
      return 0.0;
   
   return ((last - first) / first) * 100.0;
}

//+------------------------------------------------------------------+
//| Execute trade                                                    |
//+------------------------------------------------------------------+
void ExecuteTrade(string symbolName, int signalType, double atr, double &bbUpper[], double &bbLower[])
{
   // Set and refresh symbol info
   if(!symbolInfo.Name(symbolName))
   {
      Print("ERROR: Invalid symbol for trade: ", symbolName);
      return;
   }
   
   // Refresh rates to get current prices
   if(!symbolInfo.RefreshRates())
   {
      Print("ERROR: Failed to refresh rates for: ", symbolName);
      return;
   }
   
   // Check if we already have a position on this symbol with our magic number
   bool hasPosition = false;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         if(PositionGetString(POSITION_SYMBOL) == symbolName && 
            PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
         {
            hasPosition = true;
            Print("Position already exists for ", symbolName, " - Skipping");
            break;
         }
      }
   }
   
   if(hasPosition)
   {
      return; // Position already exists, skip
   }
   
   // Get correct entry price (Ask for BUY, Bid for SELL)
   double entryPrice = 0.0;
   if(signalType == ORDER_TYPE_BUY)
   {
      entryPrice = symbolInfo.Ask();
      Print("BUY Entry Price (Ask): ", DoubleToString(entryPrice, symbolInfo.Digits()));
   }
   else
   {
      entryPrice = symbolInfo.Bid();
      Print("SELL Entry Price (Bid): ", DoubleToString(entryPrice, symbolInfo.Digits()));
   }
   
   if(entryPrice <= 0)
   {
      Print("ERROR: Invalid entry price: ", entryPrice, " for ", symbolName);
      return;
   }
   
   // Get account balance
   double balance = account.Balance();
   if(balance <= 0)
   {
      Print("Invalid account balance: ", balance);
      return;
   }
   
   // Calculate risk amount (1% of balance)
   double riskAmount = balance * (InpRiskPercent / 100.0);
   
   // Calculate stop loss
   double stopLoss = CalculateStopLoss(entryPrice, signalType, atr, bbUpper, bbLower, symbolName);
   if(stopLoss <= 0)
   {
      Print("Invalid stop loss calculated: ", stopLoss);
      return;
   }
   
   // Get broker's minimum stop level
   long stopLevel = symbolInfo.StopsLevel();
   double point = symbolInfo.Point();
   int digits = symbolInfo.Digits();
   
   // Adjust point for 3/5 digit symbols
   if(digits == 3 || digits == 5)
      point *= 10;
   
   double minStopDistance = stopLevel * point;
   
   // Calculate stop loss distance
   double stopDistance = MathAbs(entryPrice - stopLoss);
   if(stopDistance <= 0)
   {
      Print("Invalid stop distance: ", stopDistance);
      return;
   }
   
   // Ensure stop loss meets minimum distance requirement
   if(stopDistance < minStopDistance)
   {
      if(signalType == ORDER_TYPE_BUY)
         stopLoss = entryPrice - minStopDistance;
      else
         stopLoss = entryPrice + minStopDistance;
      
      stopDistance = MathAbs(entryPrice - stopLoss);
      Print("Stop loss adjusted to meet minimum distance: ", stopLoss);
   }
   
   // Validate stop loss position
   if(signalType == ORDER_TYPE_BUY && stopLoss >= entryPrice)
   {
      Print("Invalid stop loss for BUY: SL (", stopLoss, ") must be below entry (", entryPrice, ")");
      return;
   }
   if(signalType == ORDER_TYPE_SELL && stopLoss <= entryPrice)
   {
      Print("Invalid stop loss for SELL: SL (", stopLoss, ") must be above entry (", entryPrice, ")");
      return;
   }
   
   // Calculate stop loss in points
   long stopLossPoints = (long)(stopDistance / point);
   
   // Calculate lot size based on risk
   double tickValue = symbolInfo.TickValue();
   double tickSize = symbolInfo.TickSize();
   double contractSize = symbolInfo.ContractSize();
   
   if(tickValue == 0 || tickSize == 0 || contractSize == 0)
   {
      Print("Invalid tick value, tick size, or contract size");
      return;
   }
   
   // Get account currency
   string accountCurrency = account.Currency();
   string symbolCurrency = symbolInfo.CurrencyProfit();
   
   // Calculate loss per lot in account currency
   // Loss per lot = (Stop Loss Points * Point) * Contract Size
   // Then convert to account currency if needed
   double lossPerLot = (stopLossPoints * point) * contractSize;
   
   // If symbol profit currency differs from account currency, we need to convert
   if(symbolCurrency != accountCurrency)
   {
      // Get conversion rate (price of 1 unit of profit currency in account currency)
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
      return;
   }
   
   // Normalize lot size
   double minLot = symbolInfo.LotsMin();
   double maxLot = symbolInfo.LotsMax();
   double lotStep = symbolInfo.LotsStep();
   
   // Round down to nearest lot step
   lotSize = MathFloor(lotSize / lotStep) * lotStep;
   
   // Ensure within broker limits
   if(lotSize < minLot) 
   {
      Print("WARNING: Calculated lot size (", lotSize, ") below minimum (", minLot, "). Using minimum.");
      lotSize = minLot;
   }
   if(lotSize > maxLot) 
   {
      Print("WARNING: Calculated lot size (", lotSize, ") above maximum (", maxLot, "). Using maximum.");
      lotSize = maxLot;
   }
   
   // Debug output
   Print("Lot Size Calculation:");
   Print("  Balance: ", DoubleToString(balance, 2));
   Print("  Risk Amount (", InpRiskPercent, "%): ", DoubleToString(riskAmount, 2));
   Print("  Stop Loss Points: ", stopLossPoints);
   Print("  Stop Distance: ", DoubleToString(stopDistance, digits));
   Print("  Point: ", DoubleToString(point, digits));
   Print("  Contract Size: ", contractSize);
   Print("  Loss per Lot: ", DoubleToString(lossPerLot, 2));
   Print("  Calculated Lot Size: ", DoubleToString(lotSize, 2));
   
   // Calculate take profit levels
   double tp1 = 0.0, tp2 = 0.0, tp3 = 0.0;
   if(signalType == ORDER_TYPE_BUY)
   {
      tp1 = entryPrice + (stopDistance * InpTP1Multiplier);
      tp2 = entryPrice + (stopDistance * InpTP2Multiplier);
      tp3 = entryPrice + (stopDistance * InpTP3Multiplier);
      
      // Ensure TP meets minimum distance
      if(tp1 > 0 && tp1 - entryPrice < minStopDistance) tp1 = entryPrice + minStopDistance;
      if(tp2 > 0 && tp2 - entryPrice < minStopDistance) tp2 = entryPrice + minStopDistance;
      if(tp3 > 0 && tp3 - entryPrice < minStopDistance) tp3 = entryPrice + minStopDistance;
   }
   else
   {
      tp1 = entryPrice - (stopDistance * InpTP1Multiplier);
      tp2 = entryPrice - (stopDistance * InpTP2Multiplier);
      tp3 = entryPrice - (stopDistance * InpTP3Multiplier);
      
      // Ensure TP meets minimum distance
      if(tp1 > 0 && entryPrice - tp1 < minStopDistance) tp1 = entryPrice - minStopDistance;
      if(tp2 > 0 && entryPrice - tp2 < minStopDistance) tp2 = entryPrice - minStopDistance;
      if(tp3 > 0 && entryPrice - tp3 < minStopDistance) tp3 = entryPrice - minStopDistance;
   }
   
   // Normalize prices
   entryPrice = NormalizeDouble(entryPrice, digits);
   stopLoss = NormalizeDouble(stopLoss, digits);
   tp1 = NormalizeDouble(tp1, digits);
   tp2 = NormalizeDouble(tp2, digits);
   tp3 = NormalizeDouble(tp3, digits);
   
   // Final validation
   if(signalType == ORDER_TYPE_BUY)
   {
      if(stopLoss >= entryPrice || (tp1 > 0 && tp1 <= entryPrice) || (tp2 > 0 && tp2 <= entryPrice) || (tp3 > 0 && tp3 <= entryPrice))
      {
         Print("Invalid price levels for BUY: Entry=", entryPrice, " SL=", stopLoss, " TP1=", tp1, " TP2=", tp2, " TP3=", tp3);
         return;
      }
   }
   else
   {
      if(stopLoss <= entryPrice || (tp1 > 0 && tp1 >= entryPrice) || (tp2 > 0 && tp2 >= entryPrice) || (tp3 > 0 && tp3 >= entryPrice))
      {
         Print("Invalid price levels for SELL: Entry=", entryPrice, " SL=", stopLoss, " TP1=", tp1, " TP2=", tp2, " TP3=", tp3);
         return;
      }
   }
   
   // Execute trade
   bool result = false;
   if(signalType == ORDER_TYPE_BUY)
   {
      if(InpUseTP3 && tp3 > 0)
         result = trade.Buy(lotSize, symbolName, 0, stopLoss, tp3, InpTradeComment);
      else if(InpUseTP2 && tp2 > 0)
         result = trade.Buy(lotSize, symbolName, 0, stopLoss, tp2, InpTradeComment);
      else if(InpUseTP1 && tp1 > 0)
         result = trade.Buy(lotSize, symbolName, 0, stopLoss, tp1, InpTradeComment);
      else
         result = trade.Buy(lotSize, symbolName, 0, stopLoss, 0, InpTradeComment);
   }
   else
   {
      if(InpUseTP3 && tp3 > 0)
         result = trade.Sell(lotSize, symbolName, 0, stopLoss, tp3, InpTradeComment);
      else if(InpUseTP2 && tp2 > 0)
         result = trade.Sell(lotSize, symbolName, 0, stopLoss, tp2, InpTradeComment);
      else if(InpUseTP1 && tp1 > 0)
         result = trade.Sell(lotSize, symbolName, 0, stopLoss, tp1, InpTradeComment);
      else
         result = trade.Sell(lotSize, symbolName, 0, stopLoss, 0, InpTradeComment);
   }
   
   if(result)
   {
      Print("Trade executed successfully: ", symbolName, " | Type: ", EnumToString((ENUM_ORDER_TYPE)signalType), 
            " | Lot: ", lotSize, " | Entry: ", entryPrice, " | SL: ", stopLoss, 
            " | TP1: ", tp1, " | TP2: ", tp2, " | TP3: ", tp3);
   }
   else
   {
      Print("Trade execution failed: ", symbolName, " | Error: ", GetLastError(), 
            " | Entry: ", entryPrice, " | SL: ", stopLoss, " | TP: ", (InpUseTP3 ? tp3 : (InpUseTP2 ? tp2 : tp1)));
   }
}

//+------------------------------------------------------------------+
//| Calculate stop loss                                              |
//+------------------------------------------------------------------+
double CalculateStopLoss(double entryPrice, int signalType, double atr, double &bbUpper[], double &bbLower[], string symbolName)
{
   double stopLoss = 0.0;
   
   // Use ATR-based stop loss (2x ATR)
   double atrStop = 0.0;
   if(atr > 0)
   {
      if(signalType == ORDER_TYPE_BUY)
         atrStop = entryPrice - (atr * 2.0);
      else
         atrStop = entryPrice + (atr * 2.0);
   }
   
   // Use Bollinger Band stop
   double bbStop = 0.0;
   if(ArraySize(bbLower) > 0 && ArraySize(bbUpper) > 0)
   {
      if(signalType == ORDER_TYPE_BUY)
         bbStop = bbLower[0] * 0.999;
      else
         bbStop = bbUpper[0] * 1.001;
   }
   
   // Use the tighter stop loss for better risk management
   if(atrStop > 0 && bbStop > 0)
   {
      if(signalType == ORDER_TYPE_BUY)
         stopLoss = MathMax(atrStop, bbStop);
      else
         stopLoss = MathMin(atrStop, bbStop);
   }
   else if(atrStop > 0)
   {
      stopLoss = atrStop;
   }
   else if(bbStop > 0)
   {
      stopLoss = bbStop;
   }
   else
   {
      // Fallback: 50 pips stop loss
      // Use a default point value (0.0001 for most pairs, 0.01 for JPY pairs)
      double point = 0.0001;
      if(symbolInfo.Name(symbolName))
      {
         point = symbolInfo.Point();
         if(symbolInfo.Digits() == 3 || symbolInfo.Digits() == 5)
            point *= 10;
      }
      
      if(signalType == ORDER_TYPE_BUY)
         stopLoss = entryPrice - (50 * point);
      else
         stopLoss = entryPrice + (50 * point);
   }
   
   return stopLoss;
}
//+------------------------------------------------------------------+

