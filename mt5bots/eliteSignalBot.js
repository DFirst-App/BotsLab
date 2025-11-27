(() => {
  'use strict';

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
      this.patienceMessageInterval = null;
      
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
      this.ui.showStatus('⏳ Patience is key in trading. Real profits come from disciplined analysis, not rushed decisions. Analyzing markets...', 'info');

      this.isRunning = true;
      this.stopRequested = false;
      this.startTime = new Date();
      this.startRunningTimer();

      // Start analyzing markets
      this.startMarketAnalysis();
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

      // Keep last 100 prices for analysis (reduced for faster signal generation)
      if (history.length > 100) {
        history.shift();
      }
    }

    calculateIndicators(symbol) {
      const history = this.priceHistory.get(symbol);
      if (!history || history.length < 30) return; // Reduced from 50 to 30

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
      if (!history || history.length < 30) return; // Reduced from 50 to 30

      // Prevent signal spam (max 1 signal per symbol per 3 minutes) - Reduced from 5 minutes
      const lastSignal = this.lastSignalTime.get(symbol) || 0;
      if (Date.now() - lastSignal < 180000) return; // 3 minutes

      // Multi-indicator signal analysis
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

      // Calculate signal strength (0-100)
      let buyScore = 0;
      let sellScore = 0;

      // RSI Analysis (more lenient scoring)
      if (rsi < 35) buyScore += 25;
      else if (rsi < 45) buyScore += 15;
      else if (rsi > 65) sellScore += 25;
      else if (rsi > 55) sellScore += 15;

      // MACD Analysis
      if (macd.histogram > 0 && macd.macd > macd.signal) buyScore += 20;
      else if (macd.histogram < 0 && macd.macd < macd.signal) sellScore += 20;

      // Moving Average Crossover
      if (sma20 > sma50 && ema12 > ema26) buyScore += 20;
      else if (sma20 < sma50 && ema12 < ema26) sellScore += 20;

      // Bollinger Bands (more lenient - within 5% of bands)
      const bbRange = bb.upper - bb.lower;
      const priceFromLower = (currentPrice - bb.lower) / bbRange;
      const priceFromUpper = (bb.upper - currentPrice) / bbRange;
      if (priceFromLower < 0.05) buyScore += 15; // Price near lower band
      else if (priceFromUpper < 0.05) sellScore += 15; // Price near upper band

      // Trend confirmation
      const recentPrices = history.slice(-20).map(h => h.price);
      const trend = this.calculateTrend(recentPrices);
      if (trend > 0) buyScore += 10;
      else if (trend < 0) sellScore += 10;

      // Minimum confidence threshold (50% - lowered to generate more signals)
      const minConfidence = 50;
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

      // Calculate stop loss and take profits
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
      // Use ATR-based stop loss (2x ATR) or Bollinger Band, whichever is larger
      const atrStop = atr > 0 ? (direction === 'BUY' ? entryPrice - (atr * 2) : entryPrice + (atr * 2)) : null;
      const bbStop = direction === 'BUY' ? bb.lower * 0.999 : bb.upper * 1.001;

      if (atrStop) {
        // Use the tighter stop loss for better risk management
        return direction === 'BUY' 
          ? Math.max(atrStop, bbStop)
          : Math.min(atrStop, bbStop);
      }

      return bbStop;
    }

    calculateTakeProfits(entryPrice, direction, stopLoss, atr) {
      const stopDistance = Math.abs(entryPrice - stopLoss);
      
      // TP1: 1.5x risk (conservative)
      // TP2: 2.5x risk (moderate)
      // TP3: 4x risk (aggressive)
      
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

      // Create custom signal popup
      this.createSignalPopup(signal, details, directionColor, directionIcon);
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
        `;
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
        width: 100%;
        box-shadow: 0 25px 70px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        pointer-events: auto;
        position: relative;
        animation: signalPopupSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        backdrop-filter: blur(15px);
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
          .signal-icon {
            animation: signalPulse 2s ease-in-out infinite;
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
      title.textContent = `🎯 ${signal.direction} Signal Detected`;
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

      // Entry Price
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

      // Stop Loss
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

      // Take Profits
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
      closeBtn.onclick = () => {
        popup.style.animation = 'signalPopupSlideOut 0.3s ease forwards';
        setTimeout(() => {
          if (popup.parentNode) {
            popup.parentNode.removeChild(popup);
          }
        }, 300);
      };

      // Add slide out animation
      if (!document.getElementById('signalPopupSlideOut')) {
        const style = document.createElement('style');
        style.id = 'signalPopupSlideOut';
        style.textContent = `
          @keyframes signalPopupSlideOut {
            to {
              opacity: 0;
              transform: scale(0.9) translateY(-20px);
            }
          }
        `;
        document.head.appendChild(style);
      }

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

