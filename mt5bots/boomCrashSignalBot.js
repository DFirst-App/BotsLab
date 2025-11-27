(() => {
  'use strict';

  // Use the global SignalPopupQueue (created by EliteSignalBot or use existing)
  if (!window.SignalPopupQueue) {
    window.SignalPopupQueue = {
      queue: [],
      isShowing: false,
      currentPopup: null,
      popupCount: 0,
      pauseAfterCount: 5,
      pauseDuration: 10000, // 10 seconds pause after 5 popups
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

        // Auto-close after 8 seconds
        const autoCloseTimeout = setTimeout(() => {
          this.closeCurrent();
        }, 8000);

        // Override close button to process next in queue
        const closeBtn = popup.querySelector('button');
        if (closeBtn) {
          closeBtn.onclick = () => {
            clearTimeout(autoCloseTimeout);
            this.closeCurrent();
          };
        }

        // Check if we need to pause after 5 popups
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
          
          // Wait 1 second before showing next popup
          setTimeout(() => {
            this.processQueue();
          }, 1000);
        }, 300);
      }
    };
  }

  class BoomCrashSignalBot {
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
      this.priceHistory = new Map();
      this.indicators = new Map();
      this.lastSignalTime = new Map();
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
      
      // Focus on Boom and Crash markets only
      this.analysisSymbols = [
        'BOOM_1000', 'CRASH_1000',
        'BOOM_500', 'CRASH_500',
        'BOOM_300', 'CRASH_300'
      ];
    }

    async start(config) {
      if (this.isRunning) {
        return;
      }

      const token = this.resolveAuthToken();
      if (!token) {
        this.ui.showStatus('Waiting for market data connection...', 'warning');
        return;
      }

      this.storedToken = token;
      this.reconnectAttempts = 0;
      this.config = { ...this.config, ...config };
      
      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Auto-analyzing Boom & Crash markets...', 'info');

      this.isRunning = true;
      this.stopRequested = false;
      this.startTime = new Date();
      this.startRunningTimer();

      // Start analyzing markets immediately
      this.startMarketAnalysis();
    }

    startMarketAnalysis() {
      // Analyze markets every 1 second (faster for Boom/Crash)
      this.analysisInterval = setInterval(() => {
        if (!this.isRunning || this.stopRequested) {
          this.stopAnalysis();
          return;
        }

        if (this.marketDataConnection) {
          this.analyzeAllMarkets();
        }
      }, 1000);

      // Initial analysis
      setTimeout(() => this.analyzeAllMarkets(), 500);
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
    }

    analyzeAllMarkets() {
      if (!this.marketDataConnection || !this.marketDataConnection.isConnected) {
        return;
      }

      this.analysisSymbols.forEach(symbol => {
        const marketData = this.marketDataConnection.getMarketData(symbol);
        if (marketData && marketData.price && marketData.price > 0) {
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

      // Keep last 80 prices for analysis
      if (history.length > 80) {
        history.shift();
      }
    }

    calculateIndicators(symbol) {
      const history = this.priceHistory.get(symbol);
      if (!history || history.length < 15) return; // Further reduced to 15 for faster signals

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
      if (!history || history.length < 15) return; // Further reduced to 15 for faster signals

      // Prevent signal spam (max 1 signal per symbol per 2 minutes) - Further reduced
      const lastSignal = this.lastSignalTime.get(symbol) || 0;
      if (Date.now() - lastSignal < 120000) return; // 2 minutes

      const signal = this.generateSignal(symbol, currentPrice, indicators, history);
      
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

    generateSignal(symbol, currentPrice, indicators, history) {
      const { rsi, macd, sma20, sma50, ema12, ema26, bb, atr } = indicators;

      let buyScore = 0;
      let sellScore = 0;

      // RSI Analysis (more sensitive for Boom/Crash)
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
        if (priceFromLower < 0.08) buyScore += 15;
        else if (priceFromUpper < 0.08) sellScore += 15;
      }

      // Trend confirmation
      const recentPrices = history.slice(-15).map(h => h.price);
      const trend = this.calculateTrend(recentPrices);
      if (trend > 0.1) buyScore += 10;
      else if (trend < -0.1) sellScore += 10;

      // Lower threshold for Boom/Crash (35% - further lowered to generate more signals)
      const minConfidence = 35;
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

      const stopLoss = this.calculateStopLoss(currentPrice, direction, atr, bb);
      const takeProfits = this.calculateTakeProfits(currentPrice, direction, stopLoss, atr);

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

    calculateStopLoss(entryPrice, direction, atr, bb) {
      const atrStop = atr > 0 ? (direction === 'BUY' ? entryPrice - (atr * 1.5) : entryPrice + (atr * 1.5)) : null;
      const bbStop = direction === 'BUY' ? bb.lower * 0.998 : bb.upper * 1.002;

      if (atrStop) {
        return direction === 'BUY' 
          ? Math.max(atrStop, bbStop)
          : Math.min(atrStop, bbStop);
      }

      return bbStop;
    }

    calculateTakeProfits(entryPrice, direction, stopLoss, atr) {
      const stopDistance = Math.abs(entryPrice - stopLoss);
      
      if (direction === 'BUY') {
        return {
          tp1: entryPrice + (stopDistance * 1.5),
          tp2: entryPrice + (stopDistance * 2.5),
          tp3: entryPrice + (stopDistance * 4.0)
        };
      } else {
        return {
          tp1: entryPrice - (stopDistance * 1.5),
          tp2: entryPrice - (stopDistance * 2.5),
          tp3: entryPrice - (stopDistance * 4.0)
        };
      }
    }

    calculateRiskReward(entryPrice, stopLoss, takeProfit, direction) {
      const risk = Math.abs(entryPrice - stopLoss);
      const reward = Math.abs(takeProfit - entryPrice);
      return risk > 0 ? (reward / risk).toFixed(2) : '0.00';
    }

    getSymbolDisplayName(symbol) {
      const symbolMap = {
        'BOOM_1000': 'Boom 1000',
        'CRASH_1000': 'Crash 1000',
        'BOOM_500': 'Boom 500',
        'CRASH_500': 'Crash 500',
        'BOOM_300': 'Boom 300',
        'CRASH_300': 'Crash 300'
      };
      return symbolMap[symbol] || symbol;
    }

    showSignalPopup(signal) {
      if (typeof window.PopupNotifications === 'undefined') {
        console.warn('PopupNotifications not available');
        return;
      }

      const directionColor = signal.direction === 'BUY' ? '#24d970' : '#ff5f6d';
      const directionIcon = signal.direction === 'BUY' ? '📈' : '📉';
      
      const formatPrice = (price) => price.toFixed(2);

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
        
        // Add responsive container styles (only if not already added)
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
        border-radius: 24px;
        padding: 32px;
        max-width: 520px;
        width: calc(100% - 40px);
        max-width: min(520px, calc(100vw - 40px));
        max-height: calc(100vh - 40px);
        overflow-y: auto;
        box-shadow: 0 25px 70px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        pointer-events: auto;
        position: relative;
        animation: signalPopupSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        backdrop-filter: blur(15px);
        box-sizing: border-box;
      `;

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
              padding: 24px !important;
              max-width: calc(100% - 32px) !important;
              max-height: calc(100vh - 32px) !important;
            }
            .signal-popup h3 {
              font-size: 22px !important;
            }
            .signal-popup > div:first-child {
              width: 64px !important;
              height: 64px !important;
              font-size: 32px !important;
            }
          }
          @media (max-width: 480px) {
            .signal-popup {
              padding: 20px !important;
              max-width: calc(100% - 24px) !important;
              max-height: calc(100vh - 24px) !important;
            }
            .signal-popup h3 {
              font-size: 20px !important;
            }
            .signal-popup > div:first-child {
              width: 56px !important;
              height: 56px !important;
              font-size: 28px !important;
              margin-bottom: 16px !important;
            }
          }
        `;
        document.head.appendChild(style);
      }

      const iconCircle = document.createElement('div');
      iconCircle.className = 'signal-icon';
      iconCircle.style.cssText = `
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: ${directionColor}20;
        border: 3px solid ${directionColor};
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 20px;
        font-size: 40px;
      `;
      iconCircle.textContent = directionIcon;

      const title = document.createElement('h3');
      title.textContent = `🎯 ${signal.direction} Signal - Boom & Crash`;
      title.style.cssText = `
        margin: 0 0 8px;
        font-size: 26px;
        font-weight: 700;
        color: #f5f7ff;
        text-align: center;
        letter-spacing: -0.02em;
      `;

      const symbolName = document.createElement('div');
      symbolName.textContent = signal.displayName;
      symbolName.style.cssText = `
        text-align: center;
        font-size: 18px;
        font-weight: 600;
        color: ${directionColor};
        margin-bottom: 24px;
        letter-spacing: 0.05em;
      `;

      const confidenceBadge = document.createElement('div');
      confidenceBadge.textContent = `${signal.confidence}% Confidence`;
      confidenceBadge.style.cssText = `
        text-align: center;
        font-size: 12px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.8);
        background: rgba(0, 210, 255, 0.2);
        border: 1px solid rgba(0, 210, 255, 0.4);
        border-radius: 12px;
        padding: 6px 16px;
        display: inline-block;
        margin: 0 auto 24px;
        letter-spacing: 0.05em;
      `;

      const entryRow = document.createElement('div');
      entryRow.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: rgba(0, 210, 255, 0.1);
        border-radius: 12px;
        margin-bottom: 12px;
        border: 1px solid rgba(0, 210, 255, 0.2);
      `;
      entryRow.innerHTML = `
        <span style="color: rgba(255, 255, 255, 0.8); font-size: 13px; font-weight: 600;">Entry Price</span>
        <span style="color: ${directionColor}; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;">${details.entryPrice}</span>
      `;

      const slRow = document.createElement('div');
      slRow.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: rgba(255, 95, 109, 0.1);
        border-radius: 12px;
        margin-bottom: 12px;
        border: 1px solid rgba(255, 95, 109, 0.2);
      `;
      slRow.innerHTML = `
        <span style="color: rgba(255, 255, 255, 0.8); font-size: 13px; font-weight: 600;">Stop Loss</span>
        <span style="color: #ff5f6d; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;">${details.stopLoss}</span>
      `;

      const tp1Row = document.createElement('div');
      tp1Row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: rgba(36, 217, 112, 0.1);
        border-radius: 12px;
        margin-bottom: 8px;
        border: 1px solid rgba(36, 217, 112, 0.2);
      `;
      tp1Row.innerHTML = `
        <span style="color: rgba(255, 255, 255, 0.8); font-size: 13px; font-weight: 600;">Take Profit 1 (R:R ${details.riskReward1})</span>
        <span style="color: #24d970; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;">${details.takeProfit1}</span>
      `;

      const tp2Row = document.createElement('div');
      tp2Row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: rgba(36, 217, 112, 0.1);
        border-radius: 12px;
        margin-bottom: 8px;
        border: 1px solid rgba(36, 217, 112, 0.2);
      `;
      tp2Row.innerHTML = `
        <span style="color: rgba(255, 255, 255, 0.8); font-size: 13px; font-weight: 600;">Take Profit 2 (R:R ${details.riskReward2})</span>
        <span style="color: #24d970; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;">${details.takeProfit2}</span>
      `;

      const tp3Row = document.createElement('div');
      tp3Row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: rgba(36, 217, 112, 0.1);
        border-radius: 12px;
        margin-bottom: 20px;
        border: 1px solid rgba(36, 217, 112, 0.2);
      `;
      tp3Row.innerHTML = `
        <span style="color: rgba(255, 255, 255, 0.8); font-size: 13px; font-weight: 600;">Take Profit 3 (R:R ${details.riskReward3})</span>
        <span style="color: #24d970; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;">${details.takeProfit3}</span>
      `;

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Got It';
      closeBtn.style.cssText = `
        width: 100%;
        padding: 14px 24px;
        border-radius: 12px;
        border: 2px solid ${directionColor};
        background: ${directionColor}25;
        color: ${directionColor};
        font-size: 15px;
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
      popup.appendChild(slRow);
      popup.appendChild(tp1Row);
      popup.appendChild(tp2Row);
      popup.appendChild(tp3Row);
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

  if (typeof window !== 'undefined') {
    window.BoomCrashSignalBot = BoomCrashSignalBot;
  }
})();

