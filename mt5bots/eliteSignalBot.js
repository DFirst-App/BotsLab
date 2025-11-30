(() => {
  'use strict';

  // Global Signal Popup Queue Manager
  if (!window.SignalPopupQueue) {
    window.SignalPopupQueue = {
      queue: [],
      isShowing: false,
      currentPopup: null,
      popupCount: 0,
      pauseAfterCount: 3,
      pauseDuration: 60000, // 60 seconds pause after 3 popups to allow traders to execute
      pauseTimeout: null,
      isPaused: false,

      add(signalData) {
        this.queue.push(signalData);
        this.processQueue();
      },

      processQueue() {
        if (this.isPaused) {
          return;
        }

        if (this.isShowing || this.queue.length === 0) return;

        this.isShowing = true;
        const signalData = this.queue.shift();
        this.showPopup(signalData);
      },

      showPopup({ signal, details, directionColor, directionIcon, createPopupFn }) {
        const popup = createPopupFn(signal, details, directionColor, directionIcon);
        this.currentPopup = popup;
        this.popupCount++;

        // No auto-close - trader must close manually
        // Override close button to process next in queue
        const closeBtn = popup.querySelector('button[data-signal-popup="true"]');
        if (closeBtn) {
          closeBtn.onclick = () => {
            this.closeCurrent();
          };
        }

        // Check if we need to pause after 3 popups
        if (this.popupCount >= this.pauseAfterCount) {
          this.pause();
        }
      },

      pause() {
        this.isPaused = true;
        this.popupCount = 0; // Reset counter
        
        if (this.pauseTimeout) {
          clearTimeout(this.pauseTimeout);
        }
        
        this.pauseTimeout = setTimeout(() => {
          this.isPaused = false;
          this.processQueue();
        }, this.pauseDuration);
      },

      closeCurrent() {
        if (!this.currentPopup) {
          this.isShowing = false;
          this.processQueue();
          return;
        }

        const popup = this.currentPopup;
        popup.style.animation = 'signalPopupSlideOut 0.3s ease forwards';
        
        setTimeout(() => {
          if (popup.parentNode) {
            popup.parentNode.removeChild(popup);
          }
          this.currentPopup = null;
          this.isShowing = false;
          
          // Wait 5 seconds before showing next popup
          setTimeout(() => {
            this.processQueue();
          }, 5000);
        }, 300);
      }
    };
  }

  class EliteSignalBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;
      this.marketDataConnection = options.marketDataConnection || null;
      
      this.resetState();
    }

    resetState() {
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.priceHistory = new Map(); // symbol -> array of prices
      this.indicators = new Map(); // symbol -> {rsi, macd, sma, ema, bb}
      this.lastSignalTime = new Map(); // symbol -> timestamp (prevent spam)
      this.accountCurrency = 'USD';
      this.balance = 0;
      this.startTime = null;
      this.runningTimer = null;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
      this.analysisInterval = null;
      this.patienceMessageInterval = null;
      this.signalScheduler = null;
      this.scheduledSignalsCount = 0;
      // Use performance.timing if available, otherwise use current time
      this.pageLoadTime = (typeof performance !== 'undefined' && performance.timing && performance.timing.navigationStart) 
        ? performance.timing.navigationStart 
        : Date.now();
      
      // Multi-timeframe candle data
      this.candles15M = new Map(); // symbol -> array of 15M candles
      this.candles30M = new Map(); // symbol -> array of 30M candles
      this.candles1H = new Map(); // symbol -> array of 1H candles
      this.candles4H = new Map(); // symbol -> array of 4H candles
      this.swingHighs = new Map(); // symbol -> array of swing highs (15M)
      this.swingLows = new Map(); // symbol -> array of swing lows (15M)
      this.trendSignals = new Map(); // symbol -> {4H, 1H, 30M, overall}
      
      // Symbols to analyze (priority markets)
      this.analysisSymbols = [
        'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD',
        'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
        'BOOM_1000', 'CRASH_1000'
      ];
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Bot is already running. Stop it before starting again.', 'warning');
        return;
      }

      const token = this.resolveAuthToken();
      if (!token) {
        this.ui.showStatus('Connect your Deriv account on the dashboard before running bots.', 'error');
        return;
      }

      this.storedToken = token;
      this.reconnectAttempts = 0;
      this.config = { ...this.config, ...config };
      
      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('⚡ Strong Signal Incoming - Analyzing markets...', 'info');

      this.isRunning = true;
      this.stopRequested = false;
      this.startTime = new Date();
      // Use actual page load time if available, otherwise use current time
      if (typeof window !== 'undefined' && window.performance && window.performance.timing) {
        this.pageLoadTime = window.performance.timing.navigationStart || Date.now();
      } else {
        this.pageLoadTime = Date.now();
      }
      this.scheduledSignalsCount = 0;
      this.startRunningTimer();

      // Start analyzing markets
      this.startMarketAnalysis();
      
      // Start scheduled signal generation
      this.startScheduledSignals();
    }

    startMarketAnalysis() {
      // Patience messages to rotate during analysis
      const patienceMessages = [
        '⏳ Patience is key in trading. Real profits come from disciplined analysis, not rushed decisions.',
        '📊 Quality signals take time. We analyze multiple indicators to ensure accuracy.',
        '💎 Remember: Successful traders wait for the right opportunity, not every opportunity.',
        '🎯 Trading requires patience. We\'re analyzing markets thoroughly to find high-confidence signals.',
        '⚡ Good things come to those who wait. We\'re scanning markets for the best entry points.'
      ];
      let messageIndex = 0;

      // Show rotating patience messages
      this.patienceMessageInterval = setInterval(() => {
        if (!this.isRunning || this.stopRequested) {
          clearInterval(this.patienceMessageInterval);
          return;
        }
        this.ui.showStatus(patienceMessages[messageIndex], 'info');
        messageIndex = (messageIndex + 1) % patienceMessages.length;
      }, 8000); // Change message every 8 seconds

      // Analyze markets every 2 seconds
      this.analysisInterval = setInterval(() => {
        if (!this.isRunning || this.stopRequested) {
          this.stopAnalysis();
          return;
        }

        // Get market data from connection
        if (this.marketDataConnection) {
          this.analyzeAllMarkets();
        }
      }, 2000);

      // Initial analysis
      setTimeout(() => this.analyzeAllMarkets(), 1000);
    }

    stopAnalysis() {
      if (this.analysisInterval) {
        clearInterval(this.analysisInterval);
        this.analysisInterval = null;
      }
      if (this.patienceMessageInterval) {
        clearInterval(this.patienceMessageInterval);
        this.patienceMessageInterval = null;
      }
      if (this.signalScheduler) {
        clearTimeout(this.signalScheduler);
        this.signalScheduler = null;
      }
    }

    startScheduledSignals() {
      const now = Date.now();
      const pageLoadTime = this.pageLoadTime;
      const timeSincePageLoad = now - pageLoadTime;
      
      // First signal: 3 seconds after page load
      const firstSignalDelay = Math.max(0, 3000 - timeSincePageLoad);
      setTimeout(() => {
        if (this.isRunning && !this.stopRequested) {
          this.forceSignalGeneration('scheduled');
        }
      }, firstSignalDelay);

      // Second signal: 10 seconds after page load
      const secondSignalDelay = Math.max(0, 10000 - timeSincePageLoad);
      setTimeout(() => {
        if (this.isRunning && !this.stopRequested) {
          this.forceSignalGeneration('scheduled');
        }
      }, secondSignalDelay);

      // Third signal: 30 seconds after page load
      const thirdSignalDelay = Math.max(0, 30000 - timeSincePageLoad);
      setTimeout(() => {
        if (this.isRunning && !this.stopRequested) {
          this.forceSignalGeneration('scheduled');
        }
      }, thirdSignalDelay);

      // Next 3 signals: every 5 minutes (300000ms) after page load
      for (let i = 0; i < 3; i++) {
        const signalTime = 300000 * (i + 1); // 5min, 10min, 15min after page load
        const delay = Math.max(0, signalTime - timeSincePageLoad);
        setTimeout(() => {
          if (this.isRunning && !this.stopRequested) {
            this.forceSignalGeneration('scheduled');
          }
        }, delay);
      }
    }

    forceSignalGeneration(reason = 'forced') {
      if (!this.marketDataConnection || !this.marketDataConnection.isConnected) {
        return;
      }

      // Find the best symbol with indicators ready
      let bestSymbol = null;
      let bestScore = 0;

      for (const symbol of this.analysisSymbols) {
        const marketData = this.marketDataConnection.getMarketData(symbol);
        if (!marketData || !marketData.price) continue;

        const indicators = this.indicators.get(symbol);
        if (!indicators) continue;

        const history = this.priceHistory.get(symbol);
        if (!history || history.length < 20) continue;

        // Calculate a quick score to find best candidate
        const { rsi, macd } = indicators;
        let score = 0;
        
        // Prefer symbols with clear signals
        if (rsi < 40 || rsi > 60) score += 20;
        if (macd.histogram > 0 || macd.histogram < 0) score += 20;
        
        if (score > bestScore) {
          bestScore = score;
          bestSymbol = symbol;
        }
      }

      // If no best symbol found, use first available
      if (!bestSymbol) {
        for (const symbol of this.analysisSymbols) {
          const marketData = this.marketDataConnection.getMarketData(symbol);
          const indicators = this.indicators.get(symbol);
          if (marketData && marketData.price && indicators) {
            bestSymbol = symbol;
            break;
          }
        }
      }

      if (bestSymbol) {
        const marketData = this.marketDataConnection.getMarketData(bestSymbol);
        // Temporarily bypass cooldown for scheduled signals
        const originalLastSignal = this.lastSignalTime.get(bestSymbol);
        this.lastSignalTime.set(bestSymbol, 0); // Reset cooldown
        
        // Force signal check
        this.checkForSignal(bestSymbol, marketData);
        
        // Restore original cooldown if it was recent
        if (originalLastSignal && (Date.now() - originalLastSignal) < 60000) {
          this.lastSignalTime.set(bestSymbol, originalLastSignal);
        }
      }
    }

    analyzeAllMarkets() {
      if (!this.marketDataConnection || !this.marketDataConnection.isConnected) {
        return;
      }

      this.analysisSymbols.forEach(symbol => {
        const marketData = this.marketDataConnection.getMarketData(symbol);
        if (marketData && marketData.price) {
          this.updatePriceHistory(symbol, marketData.price);
          this.calculateIndicators(symbol);
          this.checkForSignal(symbol, marketData);
        }
      });
    }

    updatePriceHistory(symbol, price) {
      if (!this.priceHistory.has(symbol)) {
        this.priceHistory.set(symbol, []);
      }

      const history = this.priceHistory.get(symbol);
      history.push({
        price: price,
        timestamp: Date.now()
      });

      // Keep last 1000 prices for candle building
      if (history.length > 1000) {
        history.shift();
      }

      // Build candles from tick data
      this.buildCandles(symbol, price);
    }

    buildCandles(symbol, currentPrice) {
      const history = this.priceHistory.get(symbol);
      if (!history || history.length < 2) return;

      const now = Date.now();
      const candle15M = 15 * 60 * 1000; // 15 minutes in milliseconds
      const candle30M = 30 * 60 * 1000;
      const candle1H = 60 * 60 * 1000;
      const candle4H = 4 * 60 * 60 * 1000;

      // Initialize candle arrays if needed
      if (!this.candles15M.has(symbol)) this.candles15M.set(symbol, []);
      if (!this.candles30M.has(symbol)) this.candles30M.set(symbol, []);
      if (!this.candles1H.has(symbol)) this.candles1H.set(symbol, []);
      if (!this.candles4H.has(symbol)) this.candles4H.set(symbol, []);

      const candles15M = this.candles15M.get(symbol);
      const candles30M = this.candles30M.get(symbol);
      const candles1H = this.candles1H.get(symbol);
      const candles4H = this.candles4H.get(symbol);

      // Build 15M candles
      const lastCandle15M = candles15M.length > 0 ? candles15M[candles15M.length - 1] : null;
      const currentCandle15MTime = Math.floor(now / candle15M) * candle15M;

      if (!lastCandle15M || lastCandle15M.time !== currentCandle15MTime) {
        // New 15M candle
        candles15M.push({
          time: currentCandle15MTime,
          open: currentPrice,
          high: currentPrice,
          low: currentPrice,
          close: currentPrice
        });
        // Keep last 200 candles (50 hours of data)
        if (candles15M.length > 200) candles15M.shift();
      } else {
        // Update current 15M candle
        lastCandle15M.high = Math.max(lastCandle15M.high, currentPrice);
        lastCandle15M.low = Math.min(lastCandle15M.low, currentPrice);
        lastCandle15M.close = currentPrice;
      }

      // Build 30M candles from 15M
      this.aggregateCandles(candles15M, candles30M, candle30M, now, 200);
      // Build 1H candles from 15M
      this.aggregateCandles(candles15M, candles1H, candle1H, now, 200);
      // Build 4H candles from 15M
      this.aggregateCandles(candles15M, candles4H, candle4H, now, 200);

      // Update swing highs/lows on 15M (reduced requirement)
      if (candles15M.length >= 3) {
        this.updateSwingPoints(symbol, candles15M);
      }

      // Analyze trend from higher timeframes (reduced requirements)
      if (candles15M.length >= 3) {
        // Always analyze trend, even with minimal data
        this.analyzeMultiTimeframeTrend(symbol, candles4H, candles1H, candles30M, candles15M);
      }
    }

    aggregateCandles(sourceCandles, targetCandles, timeframeMs, now, maxCandles) {
      if (sourceCandles.length === 0) return;

      const currentCandleTime = Math.floor(now / timeframeMs) * timeframeMs;
      const lastTargetCandle = targetCandles.length > 0 ? targetCandles[targetCandles.length - 1] : null;

      if (!lastTargetCandle || lastTargetCandle.time !== currentCandleTime) {
        // Find all source candles in this timeframe
        const relevantCandles = sourceCandles.filter(c => 
          c.time >= currentCandleTime && c.time < currentCandleTime + timeframeMs
        );

        if (relevantCandles.length > 0) {
          const open = relevantCandles[0].open;
          const close = relevantCandles[relevantCandles.length - 1].close;
          const high = Math.max(...relevantCandles.map(c => c.high));
          const low = Math.min(...relevantCandles.map(c => c.low));

          targetCandles.push({
            time: currentCandleTime,
            open: open,
            high: high,
            low: low,
            close: close
          });

          if (targetCandles.length > maxCandles) targetCandles.shift();
        }
      } else {
        // Update current target candle
        const relevantCandles = sourceCandles.filter(c => 
          c.time >= lastTargetCandle.time && c.time < lastTargetCandle.time + timeframeMs
        );

        if (relevantCandles.length > 0) {
          lastTargetCandle.high = Math.max(...relevantCandles.map(c => c.high));
          lastTargetCandle.low = Math.min(...relevantCandles.map(c => c.low));
          lastTargetCandle.close = relevantCandles[relevantCandles.length - 1].close;
        }
      }
    }

    updateSwingPoints(symbol, candles) {
      if (candles.length < 3) return; // Reduced from 5 to 3 for faster detection

      if (!this.swingHighs.has(symbol)) {
        this.swingHighs.set(symbol, []);
        this.swingLows.set(symbol, []);
      }

      const swingHighs = this.swingHighs.get(symbol);
      const swingLows = this.swingLows.get(symbol);

      // Find swing highs (local maxima) - more lenient detection
      for (let i = 1; i < candles.length - 1; i++) {
        const candle = candles[i];
        // Check if it's higher than neighbors (more lenient - only need 1 candle on each side)
        const isSwingHigh = candle.high > candles[i - 1].high &&
                           candle.high > candles[i + 1].high &&
                           (i < 2 || candle.high > candles[i - 2].high) &&
                           (i >= candles.length - 2 || candle.high > candles[i + 2].high);

        if (isSwingHigh) {
          // Check if this swing high is already recorded
          const exists = swingHighs.some(sh => Math.abs(sh.price - candle.high) < 0.00001);
          if (!exists) {
            swingHighs.push({
              price: candle.high,
              time: candle.time
            });
            // Keep last 20 swing highs
            if (swingHighs.length > 20) swingHighs.shift();
          }
        }

        // Find swing lows (local minima) - more lenient detection
        const isSwingLow = candle.low < candles[i - 1].low &&
                          candle.low < candles[i + 1].low &&
                          (i < 2 || candle.low < candles[i - 2].low) &&
                          (i >= candles.length - 2 || candle.low < candles[i + 2].low);

        if (isSwingLow) {
          const exists = swingLows.some(sl => Math.abs(sl.price - candle.low) < 0.00001);
          if (!exists) {
            swingLows.push({
              price: candle.low,
              time: candle.time
            });
            // Keep last 20 swing lows
            if (swingLows.length > 20) swingLows.shift();
          }
        }
      }
    }

    analyzeMultiTimeframeTrend(symbol, candles4H, candles1H, candles30M, candles15M) {
      // Analyze trend from each timeframe using EMA (reduced requirements for faster signals)
      const getTrend = (candles, minPeriod = 5) => {
        if (candles.length < minPeriod) {
          // Use fewer candles if available
          if (candles.length >= 3) {
            const closes = candles.map(c => c.close);
            const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
            const currentPrice = candles[candles.length - 1].close;
            return currentPrice > sma ? 1 : (currentPrice < sma ? -1 : 0);
          }
          return 0;
        }
        
        // Use minimum of available candles or 10 (reduced from 20)
        const period = Math.min(10, candles.length);
        const closes = candles.slice(-period).map(c => c.close);
        const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
        const currentPrice = candles[candles.length - 1].close;
        
        // Trend: 1 = bullish, -1 = bearish, 0 = neutral (more lenient threshold)
        if (currentPrice > sma * 1.0005) return 1; // 0.05% above SMA = bullish (reduced from 0.1%)
        if (currentPrice < sma * 0.9995) return -1; // 0.05% below SMA = bearish
        return 0;
      };

      const trend4H = getTrend(candles4H, 3);
      const trend1H = getTrend(candles1H, 3);
      const trend30M = getTrend(candles30M, 3);
      
      // Use 15M as additional confirmation if higher timeframes not ready
      let trend15M = 0;
      if (candles15M && candles15M.length >= 3) {
        trend15M = getTrend(candles15M, 3);
      }

      // Overall trend: more lenient - if any 2 agree, or if 15M confirms, use that
      let overallTrend = 0;
      const trends = [trend4H, trend1H, trend30M, trend15M];
      const bullishCount = trends.filter(t => t === 1).length;
      const bearishCount = trends.filter(t => t === -1).length;

      // More lenient: if 2 or more agree, or if 15M is clear and at least 1 other agrees
      if (bullishCount >= 2 || (trend15M === 1 && bullishCount >= 1)) overallTrend = 1;
      else if (bearishCount >= 2 || (trend15M === -1 && bearishCount >= 1)) overallTrend = -1;
      else if (trend15M !== 0) overallTrend = trend15M; // Use 15M if higher timeframes unclear

      this.trendSignals.set(symbol, {
        '4H': trend4H,
        '1H': trend1H,
        '30M': trend30M,
        overall: overallTrend
      });
    }

    calculateIndicators(symbol) {
      const history = this.priceHistory.get(symbol);
      if (!history || history.length < 20) return; // Further reduced to 20 for faster signals

      const prices = history.map(h => h.price);
      const indicators = {
        rsi: this.calculateRSI(prices, 14),
        macd: this.calculateMACD(prices),
        sma20: this.calculateSMA(prices, 20),
        sma50: this.calculateSMA(prices, 50),
        ema12: this.calculateEMA(prices, 12),
        ema26: this.calculateEMA(prices, 26),
        bb: this.calculateBollingerBands(prices, 20, 2),
        atr: this.calculateATR(history, 14)
      };

      this.indicators.set(symbol, indicators);
    }

    calculateRSI(prices, period = 14) {
      if (prices.length < period + 1) return 50;

      const changes = [];
      for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i] - prices[i - 1]);
      }

      const gains = changes.filter(c => c > 0);
      const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

      const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;

      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

    calculateSMA(prices, period) {
      if (prices.length < period) return prices[prices.length - 1];
      const slice = prices.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / period;
    }

    calculateEMA(prices, period) {
      if (prices.length < period) return prices[prices.length - 1];
      
      const multiplier = 2 / (period + 1);
      let ema = this.calculateSMA(prices.slice(0, period), period);

      for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
      }

      return ema;
    }

    calculateMACD(prices) {
      const ema12 = this.calculateEMA(prices, 12);
      const ema26 = this.calculateEMA(prices, 26);
      const macd = ema12 - ema26;
      
      // Calculate signal line (EMA of MACD)
      const macdHistory = [];
      for (let i = 26; i < prices.length; i++) {
        const e12 = this.calculateEMA(prices.slice(0, i + 1), 12);
        const e26 = this.calculateEMA(prices.slice(0, i + 1), 26);
        macdHistory.push(e12 - e26);
      }
      const signal = macdHistory.length >= 9 ? this.calculateEMA(macdHistory, 9) : macd;

      return {
        macd: macd,
        signal: signal,
        histogram: macd - signal
      };
    }

    calculateBollingerBands(prices, period = 20, stdDev = 2) {
      if (prices.length < period) {
        const sma = this.calculateSMA(prices, prices.length);
        return { upper: sma, middle: sma, lower: sma };
      }

      const slice = prices.slice(-period);
      const sma = slice.reduce((a, b) => a + b, 0) / period;
      
      const variance = slice.reduce((sum, price) => {
        return sum + Math.pow(price - sma, 2);
      }, 0) / period;
      
      const std = Math.sqrt(variance);

      return {
        upper: sma + (std * stdDev),
        middle: sma,
        lower: sma - (std * stdDev)
      };
    }

    calculateATR(history, period = 14) {
      if (history.length < period + 1) return 0;

      const trueRanges = [];
      for (let i = 1; i < history.length; i++) {
        const high = Math.max(history[i].price, history[i - 1].price);
        const low = Math.min(history[i].price, history[i - 1].price);
        trueRanges.push(high - low);
      }

      if (trueRanges.length < period) return 0;
      const slice = trueRanges.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / period;
    }

    checkForSignal(symbol, marketData) {
      const indicators = this.indicators.get(symbol);
      if (!indicators) return;

      const currentPrice = marketData.price;
      const history = this.priceHistory.get(symbol);
      if (!history || history.length < 20) return;

      // Get trend analysis (create default if not available yet)
      let trendSignal = this.trendSignals.get(symbol);
      if (!trendSignal) {
        // Use 15M trend as fallback if higher timeframes not ready
        const candles15M = this.candles15M.get(symbol);
        if (candles15M && candles15M.length >= 5) {
          const closes = candles15M.slice(-10).map(c => c.close);
          const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
          const currentClose = candles15M[candles15M.length - 1].close;
          const trend15M = currentClose > sma ? 1 : (currentClose < sma ? -1 : 0);
          
          trendSignal = {
            '4H': 0,
            '1H': 0,
            '30M': 0,
            overall: trend15M // Use 15M trend as fallback
          };
          this.trendSignals.set(symbol, trendSignal);
        } else {
          // No trend data yet, allow signals anyway (will use ATR for SL/TP)
          trendSignal = {
            '4H': 0,
            '1H': 0,
            '30M': 0,
            overall: 0
          };
          this.trendSignals.set(symbol, trendSignal);
        }
      }

      // Prevent signal spam (max 1 signal per symbol per 2 minutes)
      const lastSignal = this.lastSignalTime.get(symbol) || 0;
      if (Date.now() - lastSignal < 120000) return; // 2 minutes

      // Multi-indicator signal analysis
      const signal = this.generateSignal(symbol, currentPrice, indicators, history, trendSignal);
      
      if (signal) {
        this.lastSignalTime.set(symbol, Date.now());
        this.showSignalPopup(signal);
        this.ui.addHistoryEntry({
          symbol: signal.displayName || symbol,
          direction: signal.direction,
          entryPrice: signal.entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit1: signal.takeProfit1,
          takeProfit2: signal.takeProfit2,
          takeProfit3: signal.takeProfit3,
          confidence: signal.confidence,
          timestamp: new Date()
        });
      }
    }

    generateSignal(symbol, currentPrice, indicators, history, trendSignal) {
      const { rsi, macd, sma20, sma50, ema12, ema26, bb, atr } = indicators;

      // Calculate signal strength (0-100)
      let buyScore = 0;
      let sellScore = 0;

      // RSI Analysis
      if (rsi < 40) buyScore += 25;
      else if (rsi < 50) buyScore += 15;
      else if (rsi > 60) sellScore += 25;
      else if (rsi > 50) sellScore += 15;

      // MACD Analysis
      if (macd.histogram > 0 && macd.macd > macd.signal) buyScore += 20;
      else if (macd.histogram < 0 && macd.macd < macd.signal) sellScore += 20;

      // Moving Average Crossover
      if (sma20 > sma50 && ema12 > ema26) buyScore += 20;
      else if (sma20 < sma50 && ema12 < ema26) sellScore += 20;

      // Bollinger Bands
      const bbRange = bb.upper - bb.lower;
      if (bbRange > 0) {
        const priceFromLower = (currentPrice - bb.lower) / bbRange;
        const priceFromUpper = (bb.upper - currentPrice) / bbRange;
        if (priceFromLower < 0.10) buyScore += 15;
        else if (priceFromUpper < 0.10) sellScore += 15;
      }

      // Trend confirmation from higher timeframes (bonus points, not required)
      if (trendSignal.overall === 1) buyScore += 30; // Strong bullish trend
      else if (trendSignal.overall === -1) sellScore += 30; // Strong bearish trend
      // If trend is neutral (0), no bonus but signal can still generate

      // Minimum confidence threshold (reduced to allow faster signals)
      const minConfidence = 40;
      let direction = null;
      let confidence = 0;

      if (buyScore >= minConfidence && buyScore > sellScore) {
        direction = 'BUY';
        confidence = Math.min(buyScore, 95);
      } else if (sellScore >= minConfidence && sellScore > buyScore) {
        direction = 'SELL';
        confidence = Math.min(sellScore, 95);
      }

      if (!direction) return null;

      // Prefer signals in trend direction, but allow high-confidence signals even if trend is neutral
      // Only reject if signal strongly contradicts a clear trend
      if (trendSignal.overall !== 0) {
        // If we have a clear trend, prefer signals in that direction
        // But allow high-confidence signals (60+) even if they don't match
        if ((direction === 'BUY' && trendSignal.overall === -1 && confidence < 60) ||
            (direction === 'SELL' && trendSignal.overall === 1 && confidence < 60)) {
          // Signal contradicts clear trend and confidence is not high enough
          return null;
        }
      }
      // If trend is neutral (0), allow any signal with sufficient confidence

      // Calculate stop loss and take profits from 15M market structure
      const stopLoss = this.calculateStopLossFromStructure(symbol, currentPrice, direction);
      if (!stopLoss || stopLoss === 0) return null; // Invalid stop loss

      const takeProfits = this.calculateTakeProfitsFromStructure(symbol, currentPrice, direction, stopLoss);
      if (!takeProfits || takeProfits.tp1 === 0) return null; // Invalid take profits

      return {
        symbol: symbol,
        displayName: this.getSymbolDisplayName(symbol),
        direction: direction,
        entryPrice: currentPrice,
        stopLoss: stopLoss,
        takeProfit1: takeProfits.tp1,
        takeProfit2: takeProfits.tp2,
        takeProfit3: takeProfits.tp3,
        confidence: confidence,
        riskReward1: this.calculateRiskReward(currentPrice, stopLoss, takeProfits.tp1, direction),
        riskReward2: this.calculateRiskReward(currentPrice, stopLoss, takeProfits.tp2, direction),
        riskReward3: this.calculateRiskReward(currentPrice, stopLoss, takeProfits.tp3, direction),
        timestamp: Date.now()
      };
    }

    calculateTrend(prices) {
      if (prices.length < 2) return 0;
      const first = prices[0];
      const last = prices[prices.length - 1];
      return ((last - first) / first) * 100;
    }

    calculateStopLossFromStructure(symbol, entryPrice, direction) {
      const candles15M = this.candles15M.get(symbol);
      const swingHighs = this.swingHighs.get(symbol) || [];
      const swingLows = this.swingLows.get(symbol) || [];
      const indicators = this.indicators.get(symbol);
      
      if (!candles15M || candles15M.length < 3) {
        // Fallback to ATR if no candles available yet (always available)
        if (indicators && indicators.atr > 0) {
          return this.normalizePrice(symbol, direction === 'BUY' 
            ? entryPrice - (indicators.atr * 1.5)
            : entryPrice + (indicators.atr * 1.5));
        }
        // Even if no ATR, use a reasonable default based on point value
        const point = this.getPointValue(symbol);
        return this.normalizePrice(symbol, direction === 'BUY' 
          ? entryPrice - (point * 30)
          : entryPrice + (point * 30));
      }

      // Get point value for this symbol (approximate)
      const point = this.getPointValue(symbol);
      const minStopDistance = point * 10; // Minimum 10 pips
      const maxStopDistance = point * 200; // Maximum 200 pips

      let stopLoss = 0;

      if (direction === 'BUY') {
        // Find nearest support level (swing low) below entry
        const supports = swingLows
          .filter(sl => sl.price < entryPrice)
          .sort((a, b) => b.price - a.price); // Sort descending (closest to entry first)

        if (supports.length > 0) {
          const nearestSupport = supports[0].price;
          const atr = indicators?.atr || 0;
          const buffer = Math.max(atr * 0.5, point * 10); // Half ATR or 10 pips
          stopLoss = nearestSupport - buffer;
        } else {
          // Use recent low from candles
          const recentLows = candles15M.slice(-20).map(c => c.low);
          const lowestLow = Math.min(...recentLows);
          if (lowestLow < entryPrice) {
            const atr = indicators?.atr || 0;
            const buffer = Math.max(atr * 0.5, point * 10);
            stopLoss = lowestLow - buffer;
          } else {
            // Fallback to ATR
            const atr = indicators?.atr || point * 30;
            stopLoss = entryPrice - (atr * 1.5);
          }
        }
      } else {
        // SELL: Find nearest resistance level (swing high) above entry
        const resistances = swingHighs
          .filter(sh => sh.price > entryPrice)
          .sort((a, b) => a.price - b.price); // Sort ascending (closest to entry first)

        if (resistances.length > 0) {
          const nearestResistance = resistances[0].price;
          const atr = indicators?.atr || 0;
          const buffer = Math.max(atr * 0.5, point * 10);
          stopLoss = nearestResistance + buffer;
        } else {
          // Use recent high from candles
          const recentHighs = candles15M.slice(-20).map(c => c.high);
          const highestHigh = Math.max(...recentHighs);
          if (highestHigh > entryPrice) {
            const atr = indicators?.atr || 0;
            const buffer = Math.max(atr * 0.5, point * 10);
            stopLoss = highestHigh + buffer;
          } else {
            // Fallback to ATR
            const atr = indicators?.atr || point * 30;
            stopLoss = entryPrice + (atr * 1.5);
          }
        }
      }

      // Validate stop loss distance
      const stopDistance = Math.abs(entryPrice - stopLoss);
      if (stopDistance < minStopDistance) {
        stopLoss = direction === 'BUY' 
          ? entryPrice - minStopDistance
          : entryPrice + minStopDistance;
      } else if (stopDistance > maxStopDistance) {
        stopLoss = direction === 'BUY'
          ? entryPrice - maxStopDistance
          : entryPrice + maxStopDistance;
      }

      return this.normalizePrice(symbol, stopLoss);
    }

    calculateTakeProfitsFromStructure(symbol, entryPrice, direction, stopLoss) {
      const candles15M = this.candles15M.get(symbol);
      const swingHighs = this.swingHighs.get(symbol) || [];
      const swingLows = this.swingLows.get(symbol) || [];
      const indicators = this.indicators.get(symbol);
      
      if (!candles15M || candles15M.length < 3) {
        // Fallback to risk:reward if no candles (always works)
        const stopDistance = Math.abs(entryPrice - stopLoss);
        if (direction === 'BUY') {
          return {
            tp1: this.normalizePrice(symbol, entryPrice + (stopDistance * 1.5)),
            tp2: this.normalizePrice(symbol, entryPrice + (stopDistance * 2.5)),
            tp3: this.normalizePrice(symbol, entryPrice + (stopDistance * 4.0))
          };
        } else {
          return {
            tp1: this.normalizePrice(symbol, entryPrice - (stopDistance * 1.5)),
            tp2: this.normalizePrice(symbol, entryPrice - (stopDistance * 2.5)),
            tp3: this.normalizePrice(symbol, entryPrice - (stopDistance * 4.0))
          };
        }
      }

      const stopDistance = Math.abs(entryPrice - stopLoss);
      const minRR = 1.2; // Minimum 1.2:1 risk:reward
      const point = this.getPointValue(symbol);

      let tps = { tp1: 0, tp2: 0, tp3: 0 };

      if (direction === 'BUY') {
        // Find next resistance levels above entry
        const resistances = swingHighs
          .filter(sh => sh.price > entryPrice)
          .sort((a, b) => a.price - b.price); // Sort ascending

        const minTP = entryPrice + (stopDistance * minRR);
        let tpCount = 0;

        // Use first 3 resistance levels that meet minimum R:R
        for (let i = 0; i < resistances.length && tpCount < 3; i++) {
          if (resistances[i].price >= minTP) {
            if (tpCount === 0) tps.tp1 = resistances[i].price;
            else if (tpCount === 1) tps.tp2 = resistances[i].price;
            else if (tpCount === 2) tps.tp3 = resistances[i].price;
            tpCount++;
          }
        }

        // Fill remaining TPs with Fibonacci extensions if needed
        const fibExtensions = [1.5, 2.5, 4.0];
        for (let i = tpCount; i < 3; i++) {
          const fibTP = entryPrice + (stopDistance * fibExtensions[i]);
          if (i === 0) tps.tp1 = fibTP;
          else if (i === 1) tps.tp2 = fibTP;
          else if (i === 2) tps.tp3 = fibTP;
        }
      } else {
        // SELL: Find next support levels below entry
        const supports = swingLows
          .filter(sl => sl.price < entryPrice)
          .sort((a, b) => b.price - a.price); // Sort descending

        const minTP = entryPrice - (stopDistance * minRR);
        let tpCount = 0;

        // Use first 3 support levels that meet minimum R:R
        for (let i = 0; i < supports.length && tpCount < 3; i++) {
          if (supports[i].price <= minTP) {
            if (tpCount === 0) tps.tp1 = supports[i].price;
            else if (tpCount === 1) tps.tp2 = supports[i].price;
            else if (tpCount === 2) tps.tp3 = supports[i].price;
            tpCount++;
          }
        }

        // Fill remaining TPs with Fibonacci extensions if needed
        const fibExtensions = [1.5, 2.5, 4.0];
        for (let i = tpCount; i < 3; i++) {
          const fibTP = entryPrice - (stopDistance * fibExtensions[i]);
          if (i === 0) tps.tp1 = fibTP;
          else if (i === 1) tps.tp2 = fibTP;
          else if (i === 2) tps.tp3 = fibTP;
        }
      }

      // Normalize all TPs
      tps.tp1 = this.normalizePrice(symbol, tps.tp1);
      tps.tp2 = this.normalizePrice(symbol, tps.tp2);
      tps.tp3 = this.normalizePrice(symbol, tps.tp3);

      return tps;
    }

    getPointValue(symbol) {
      // Approximate point value based on symbol type
      if (symbol.includes('XAU') || symbol.includes('XAG')) {
        return 0.01; // Gold/Silver: 0.01
      } else if (symbol.startsWith('R_') || symbol.includes('BOOM') || symbol.includes('CRASH')) {
        return 0.01; // Volatility indices: 0.01
      } else if (symbol.includes('JPY')) {
        return 0.001; // JPY pairs: 0.001 (1 pip = 0.01)
      } else {
        return 0.0001; // Standard pairs: 0.0001 (1 pip = 0.0001)
      }
    }

    normalizePrice(symbol, price) {
      // Normalize price to appropriate decimal places
      if (symbol.includes('XAU') || symbol.includes('XAG')) {
        return Math.round(price * 100) / 100;
      } else if (symbol.startsWith('R_') || symbol.includes('BOOM') || symbol.includes('CRASH')) {
        return Math.round(price * 100) / 100;
      } else if (symbol.includes('JPY')) {
        return Math.round(price * 1000) / 1000;
      } else {
        return Math.round(price * 100000) / 100000;
      }
    }

    calculateRiskReward(entryPrice, stopLoss, takeProfit, direction) {
      const risk = Math.abs(entryPrice - stopLoss);
      const reward = Math.abs(takeProfit - entryPrice);
      return risk > 0 ? (reward / risk).toFixed(2) : '0.00';
    }

    getSymbolDisplayName(symbol) {
      const symbolMap = {
        'frxEURUSD': 'EURUSD',
        'frxGBPUSD': 'GBPUSD',
        'frxUSDJPY': 'USDJPY',
        'frxXAUUSD': 'XAUUSD',
        'R_10': 'Volatility 10',
        'R_25': 'Volatility 25',
        'R_50': 'Volatility 50',
        'R_75': 'Volatility 75',
        'R_100': 'Volatility 100',
        'BOOM_1000': 'Boom 1000',
        'CRASH_1000': 'Crash 1000'
      };
      return symbolMap[symbol] || symbol.replace(/^frx/, '');
    }

    showSignalPopup(signal) {
      if (typeof window.PopupNotifications === 'undefined') {
        console.warn('PopupNotifications not available');
        return;
      }

      const directionColor = signal.direction === 'BUY' ? '#24d970' : '#ff5f6d';
      const directionIcon = signal.direction === 'BUY' ? '📈' : '📉';
      
      // Format prices based on symbol type
      const formatPrice = (price) => {
        if (signal.symbol.includes('XAU') || signal.symbol.includes('XAG')) {
          return price.toFixed(2);
        } else if (signal.symbol.startsWith('R_') || signal.symbol.includes('BOOM') || signal.symbol.includes('CRASH')) {
          return price.toFixed(2);
        }
        return price.toFixed(5);
      };

      const details = {
        symbol: signal.displayName,
        direction: signal.direction,
        entryPrice: formatPrice(signal.entryPrice),
        stopLoss: formatPrice(signal.stopLoss),
        takeProfit1: formatPrice(signal.takeProfit1),
        takeProfit2: formatPrice(signal.takeProfit2),
        takeProfit3: formatPrice(signal.takeProfit3),
        confidence: signal.confidence,
        riskReward1: signal.riskReward1,
        riskReward2: signal.riskReward2,
        riskReward3: signal.riskReward3
      };

      // Add to queue instead of showing immediately
      window.SignalPopupQueue.add({
        signal,
        details,
        directionColor,
        directionIcon,
        createPopupFn: (sig, det, color, icon) => this.createSignalPopup(sig, det, color, icon)
      });
    }

    createSignalPopup(signal, details, directionColor, directionIcon) {
      // Initialize popup container if needed
      let container = document.getElementById('popupNotificationsContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'popupNotificationsContainer';
        container.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          box-sizing: border-box;
          overflow: hidden;
        `;
        
        // Add responsive container styles
        if (!document.getElementById('signalPopupContainerStyles')) {
          const containerStyle = document.createElement('style');
          containerStyle.id = 'signalPopupContainerStyles';
          containerStyle.textContent = `
            @media (max-width: 768px) {
              #popupNotificationsContainer {
                padding: 16px !important;
              }
            }
            @media (max-width: 480px) {
              #popupNotificationsContainer {
                padding: 12px !important;
              }
            }
          `;
          document.head.appendChild(containerStyle);
        }
        document.body.appendChild(container);
      }

      const popup = document.createElement('div');
      popup.className = 'signal-popup';
      popup.style.cssText = `
        background: linear-gradient(135deg, rgba(0, 210, 255, 0.15) 0%, rgba(110, 243, 180, 0.12) 100%);
        border: 2px solid ${directionColor};
        border-radius: 20px;
        padding: 20px;
        max-width: 420px;
        width: calc(100% - 40px);
        max-width: min(420px, calc(100vw - 40px));
        max-height: calc(100vh - 60px);
        overflow-y: auto;
        box-shadow: 0 25px 70px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        pointer-events: auto;
        position: relative;
        animation: signalPopupSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        backdrop-filter: blur(15px);
        box-sizing: border-box;
      `;

      // Add animation styles if not already added
      if (!document.getElementById('signalPopupAnimations')) {
        const style = document.createElement('style');
        style.id = 'signalPopupAnimations';
        style.textContent = `
          @keyframes signalPopupSlideIn {
            from {
              opacity: 0;
              transform: scale(0.85) translateY(-30px) rotateX(10deg);
            }
            to {
              opacity: 1;
              transform: scale(1) translateY(0) rotateX(0deg);
            }
          }
          @keyframes signalPulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }
          @keyframes signalPopupSlideOut {
            to {
              opacity: 0;
              transform: scale(0.9) translateY(-20px);
            }
          }
          .signal-icon {
            animation: signalPulse 2s ease-in-out infinite;
          }
          @media (max-width: 768px) {
            .signal-popup {
              padding: 16px !important;
              max-width: calc(100% - 32px) !important;
              max-height: calc(100vh - 40px) !important;
            }
            .signal-popup h3 {
              font-size: 18px !important;
            }
            .signal-popup > div:first-child {
              width: 50px !important;
              height: 50px !important;
              font-size: 24px !important;
              margin-bottom: 10px !important;
            }
          }
          @media (max-width: 480px) {
            .signal-popup {
              padding: 14px !important;
              max-width: calc(100% - 24px) !important;
              max-height: calc(100vh - 30px) !important;
            }
            .signal-popup h3 {
              font-size: 16px !important;
            }
            .signal-popup > div:first-child {
              width: 44px !important;
              height: 44px !important;
              font-size: 22px !important;
              margin-bottom: 8px !important;
            }
          }
        `;
        document.head.appendChild(style);
      }

      const iconCircle = document.createElement('div');
      iconCircle.className = 'signal-icon';
      iconCircle.style.cssText = `
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: ${directionColor}20;
        border: 2px solid ${directionColor};
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 12px;
        font-size: 30px;
      `;
      iconCircle.textContent = directionIcon;

      const title = document.createElement('h3');
      title.textContent = `🎯 ${signal.direction} Signal Detected`;
      title.style.cssText = `
        margin: 0 0 6px;
        font-size: 20px;
        font-weight: 700;
        color: #f5f7ff;
        text-align: center;
        letter-spacing: -0.02em;
      `;

      const symbolName = document.createElement('div');
      symbolName.textContent = signal.displayName;
      symbolName.style.cssText = `
        text-align: center;
        font-size: 16px;
        font-weight: 600;
        color: ${directionColor};
        margin-bottom: 12px;
        letter-spacing: 0.05em;
      `;

      const confidenceBadge = document.createElement('div');
      confidenceBadge.textContent = `${signal.confidence}% Confidence`;
      confidenceBadge.style.cssText = `
        text-align: center;
        font-size: 11px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.8);
        background: rgba(0, 210, 255, 0.2);
        border: 1px solid rgba(0, 210, 255, 0.4);
        border-radius: 10px;
        padding: 4px 12px;
        display: inline-block;
        margin: 0 auto 12px;
        letter-spacing: 0.05em;
      `;

      // Helper function to create copy button
      const createCopyButton = (textToCopy, label) => {
        const copyBtn = document.createElement('button');
        copyBtn.innerHTML = '📋';
        copyBtn.title = `Copy ${label}`;
        copyBtn.style.cssText = `
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 6px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.2s ease;
          margin-left: 8px;
        `;
        copyBtn.onmouseover = () => {
          copyBtn.style.background = 'rgba(255, 255, 255, 0.2)';
        };
        copyBtn.onmouseout = () => {
          copyBtn.style.background = 'rgba(255, 255, 255, 0.1)';
        };
        copyBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(textToCopy);
            const originalText = copyBtn.innerHTML;
            copyBtn.innerHTML = '✓';
            copyBtn.style.background = 'rgba(36, 217, 112, 0.3)';
            setTimeout(() => {
              copyBtn.innerHTML = originalText;
              copyBtn.style.background = 'rgba(255, 255, 255, 0.1)';
            }, 1000);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        };
        return copyBtn;
      };

      // Entry Price
      const entryRow = document.createElement('div');
      entryRow.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: rgba(0, 210, 255, 0.1);
        border-radius: 10px;
        margin-bottom: 12px;
        border: 1px solid rgba(0, 210, 255, 0.2);
      `;
      const entryLabel = document.createElement('span');
      entryLabel.textContent = 'Entry Price';
      entryLabel.style.cssText = 'color: rgba(255, 255, 255, 0.8); font-size: 12px; font-weight: 600;';
      const entryValue = document.createElement('span');
      entryValue.textContent = details.entryPrice;
      entryValue.style.cssText = `color: ${directionColor}; font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; display: flex; align-items: center;`;
      const entryCopyBtn = createCopyButton(details.entryPrice, 'Entry Price');
      entryValue.appendChild(entryCopyBtn);
      entryRow.appendChild(entryLabel);
      entryRow.appendChild(entryValue);

      // Trading Tip
      const tipBox = document.createElement('div');
      tipBox.style.cssText = `
        background: rgba(255, 193, 7, 0.15);
        border: 1px solid rgba(255, 193, 7, 0.4);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 12px;
      `;
      const tipIcon = document.createElement('div');
      tipIcon.textContent = '💡';
      tipIcon.style.cssText = 'font-size: 18px; margin-bottom: 6px; text-align: center;';
      const tipText = document.createElement('div');
      tipText.innerHTML = `
        <div style="color: rgba(255, 255, 255, 0.9); font-size: 12px; line-height: 1.5; text-align: center;">
          <strong style="color: #ffc107;">Trading Tip:</strong><br>
          Set your stop loss ${signal.direction === 'BUY' ? 'below' : 'above'} the nearest swing ${signal.direction === 'BUY' ? 'low' : 'high'} on the 15-minute chart. 
          Set 3 take profit levels targeting important resistance/support levels for optimal risk management.
        </div>
      `;
      tipBox.appendChild(tipIcon);
      tipBox.appendChild(tipText);

      // Account Info Section
      const accountSection = document.createElement('div');
      accountSection.style.cssText = `
        background: rgba(0, 210, 255, 0.08);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 12px;
      `;

      // Get account info from marketDataConnection
      const accountInfo = this.marketDataConnection?.accountInfo || null;
      // Check for MT5 accounts - try multiple possible properties
      const mt5Accounts = this.marketDataConnection?.mt5Accounts || 
                         this.marketDataConnection?.mt5AccountInfo || 
                         (this.marketDataConnection?.accountInfo?.mt5Accounts) || 
                         [];
      const hasMT5Account = Array.isArray(mt5Accounts) ? mt5Accounts.length > 0 : (mt5Accounts && Object.keys(mt5Accounts).length > 0);

      if (accountInfo && accountInfo.balance !== undefined) {
        const balanceRow = document.createElement('div');
        balanceRow.style.cssText = `
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        `;
        const balanceLabel = document.createElement('span');
        balanceLabel.textContent = 'Account Balance';
        balanceLabel.style.cssText = 'color: rgba(255, 255, 255, 0.8); font-size: 12px; font-weight: 600;';
        const balanceValue = document.createElement('span');
        balanceValue.textContent = `${accountInfo.balance.toFixed(2)} ${accountInfo.currency || 'USD'}`;
        balanceValue.style.cssText = 'color: #24d970; font-size: 14px; font-weight: 700;';
        balanceRow.appendChild(balanceLabel);
        balanceRow.appendChild(balanceValue);
        accountSection.appendChild(balanceRow);
      }

      // Deposit Button
      const depositBtn = document.createElement('a');
      depositBtn.href = 'https://p2p.deriv.com/advertiser/426826?advert_id=3182910&t=_30qaRjl291dMjdsyM5hasGNd7ZgqdRLk';
      depositBtn.target = '_blank';
      depositBtn.rel = 'noopener';
      depositBtn.textContent = '💰 Deposit to Account';
      depositBtn.style.cssText = `
        width: 100%;
        padding: 10px;
        border-radius: 8px;
        border: 2px solid #24d970;
        background: rgba(36, 217, 112, 0.2);
        color: #24d970;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        text-align: center;
        text-decoration: none;
        display: block;
        margin-bottom: ${hasMT5Account ? '0' : '10px'};
        transition: all 0.2s ease;
      `;
      depositBtn.onmouseover = () => {
        depositBtn.style.background = 'rgba(36, 217, 112, 0.3)';
        depositBtn.style.transform = 'translateY(-2px)';
      };
      depositBtn.onmouseout = () => {
        depositBtn.style.background = 'rgba(36, 217, 112, 0.2)';
        depositBtn.style.transform = 'translateY(0)';
      };
      accountSection.appendChild(depositBtn);

      // Create MT5 Account Button (if no MT5 account)
      if (!hasMT5Account) {
        const createMT5Btn = document.createElement('a');
        createMT5Btn.href = 'https://app.deriv.com/?t=_30qaRjl291dMjdsyM5hasGNd7ZgqdRLk';
        createMT5Btn.target = '_blank';
        createMT5Btn.rel = 'noopener';
        createMT5Btn.textContent = '📊 Create MT5 Account';
        createMT5Btn.style.cssText = `
          width: 100%;
          padding: 10px;
          border-radius: 8px;
          border: 2px solid #00d2ff;
          background: rgba(0, 210, 255, 0.2);
          color: #00d2ff;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          text-align: center;
          text-decoration: none;
          display: block;
          transition: all 0.2s ease;
        `;
        createMT5Btn.onmouseover = () => {
          createMT5Btn.style.background = 'rgba(0, 210, 255, 0.3)';
          createMT5Btn.style.transform = 'translateY(-2px)';
        };
        createMT5Btn.onmouseout = () => {
          createMT5Btn.style.background = 'rgba(0, 210, 255, 0.2)';
          createMT5Btn.style.transform = 'translateY(0)';
        };
        accountSection.appendChild(createMT5Btn);
      }

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Got It';
      closeBtn.style.cssText = `
        width: 100%;
        padding: 10px 20px;
        border-radius: 10px;
        border: 2px solid ${directionColor};
        background: ${directionColor}25;
        color: ${directionColor};
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s ease;
        letter-spacing: 0.05em;
      `;
      closeBtn.onmouseover = () => {
        closeBtn.style.background = `${directionColor}40`;
        closeBtn.style.transform = 'translateY(-2px)';
      };
      closeBtn.onmouseout = () => {
        closeBtn.style.background = `${directionColor}25`;
        closeBtn.style.transform = 'translateY(0)';
      };
      // Close handler will be set by queue manager
      closeBtn.dataset.signalPopup = 'true';

      popup.appendChild(iconCircle);
      popup.appendChild(title);
      popup.appendChild(symbolName);
      popup.appendChild(confidenceBadge);
      popup.appendChild(entryRow);
      popup.appendChild(tipBox);
      popup.appendChild(accountSection);
      popup.appendChild(closeBtn);

      container.appendChild(popup);
      
      return popup;
    }

    stop(message = 'Bot stopped', type = 'info') {
      this.stopRequested = true;
      this.stopAnalysis();
      
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close();
      } else {
        this.finishStop(message, type);
      }
    }

    finishStop(message, type) {
      this.isRunning = false;
      this.isReconnecting = false;
      this.stopAnalysis();
      this.clearRunningTimer();
      this.ui.setRunningState(false);
      this.ui.showStatus(message, type);
    }

    startRunningTimer() {
      this.clearRunningTimer();
      this.runningTimer = setInterval(() => {
        if (this.startTime) {
          const elapsed = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
          const hours = Math.floor(elapsed / 3600);
          const minutes = Math.floor((elapsed % 3600) / 60);
          const seconds = elapsed % 60;
          const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
          // Timer is handled by UI
        }
      }, 1000);
    }

    clearRunningTimer() {
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
      }
    }

    getStatsSnapshot() {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        currentStake: 0,
        runningTime: this.startTime ? this.getRunningTime() : '00:00:00'
      };
    }

    getRunningTime() {
      if (!this.startTime) return '00:00:00';
      const elapsed = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      const hours = Math.floor(elapsed / 3600);
      const minutes = Math.floor((elapsed % 3600) / 60);
      const seconds = elapsed % 60;
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  }

  // Export for use in other files
  if (typeof window !== 'undefined') {
    window.EliteSignalBot = EliteSignalBot;
  }
})();

