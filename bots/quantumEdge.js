(() => {
  class QuantumEdgeBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;

      this.symbol = 'R_50'; // Optimal for mean reversion
      this.lookbackPeriod = 20; // Bollinger Bands period
      this.stdDevMultiplier = 2.0; // Standard deviation multiplier
      this.rsiPeriod = 14;
      this.minConfidence = 0.75; // 75% confidence threshold for high win rate

      this.resetState();
    }

    resetState() {
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.priceHistory = [];
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.balance = 0;
      this.currency = 'USD';
      this.runningTimer = null;
      this.startTime = null;
      this.hasOpenContract = false;
      this.pendingProposal = false;
      this.tradeInProgress = false;
      this.activeContractId = null;
      this.currentProposalId = null;
      this.lastTradeType = null;
      this.lastTradeTime = 0;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
      this.winRateHistory = []; // Track recent win rate for adaptive entry
      this.adaptiveConfidence = this.minConfidence; // Adaptive confidence threshold
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Quantum Edge is already running.', 'warning');
        return;
      }

      const token = this.resolveAuthToken();
      if (!token) {
        this.ui.showStatus('Connect your Deriv account from the dashboard first.', 'error');
        return;
      }

      this.storedToken = token;
      this.reconnectAttempts = 0;

      this.resetState();
      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Authorizing Quantum Edge...', 'info');

      this.isRunning = true;
      this.startTime = new Date();
      this.startRunningTimer();

      this.connectWebSocket();
    }

    connectWebSocket() {
      if (this.stopRequested) return;

      this.ws = new this.WebSocketImpl(this.wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
        const token = this.storedToken || this.resolveAuthToken();
        if (token) {
          this.ws.send(JSON.stringify({ authorize: token }));
        }
      };

      this.ws.onmessage = (event) => this.handleMessage(event.data);

      this.ws.onerror = () => {
        if (!this.stopRequested && !this.isReconnecting) {
          this.attemptReconnect('WebSocket error. Reconnecting...');
        }
      };

      this.ws.onclose = () => {
        if (this.stopRequested) {
          this.finishStop();
        } else if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost. Reconnecting...');
        }
      };
    }

    stop(message = 'Bot stopped', type = 'info') {
      this.stopRequested = true;
      this.ui.setRunningState(false);
      this.ui.showStatus(message, type);
      this.clearRunningTimer();
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close();
      } else {
        this.finishStop();
      }
    }

    attemptReconnect(message) {
      if (this.stopRequested || this.isReconnecting) return;

      this.isReconnecting = true;
      this.reconnectAttempts += 1;

      if (this.reconnectAttempts > 10) {
        this.ui.showStatus('Max reconnection attempts reached. Please restart the bot.', 'error');
        this.stop('Connection failed after multiple attempts', 'error');
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      this.ui.showStatus(`${message} (Attempt ${this.reconnectAttempts}/10)`, 'warning');

      if (this.ws) {
        try {
          this.ws.onopen = null;
          this.ws.onmessage = null;
          this.ws.onerror = null;
          this.ws.onclose = null;
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
          }
        } catch (e) {
          console.error('Error closing WebSocket', e);
        }
        this.ws = null;
      }

      this.reconnectTimeout = setTimeout(() => {
        if (!this.stopRequested && this.isRunning) {
          this.connectWebSocket();
        }
      }, delay);
    }

    finishStop() {
      this.isRunning = false;
      this.isReconnecting = false;
      this.pendingProposal = false;
      this.tradeInProgress = false;
      this.hasOpenContract = false;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (this.ws) {
        try {
          this.ws.onopen = null;
          this.ws.onmessage = null;
          this.ws.onerror = null;
          this.ws.onclose = null;
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
          }
        } catch (e) {
          console.error('Error closing WebSocket', e);
        }
      }
      this.ws = null;
      this.clearRunningTimer();
    }

    handleMessage(raw) {
      try {
        const data = JSON.parse(raw);
        if (data.error) {
          const errorCode = data.error?.code;
          const message = data.error.message || 'Deriv returned an error.';
          
          if (errorCode === 'InvalidToken' || errorCode === 'AuthorizationRequired') {
            this.ui.showStatus('Authorization expired. Reconnecting...', 'warning');
            this.attemptReconnect('Re-authenticating...');
            return;
          }
          
          if (errorCode === 'RateLimit' || errorCode === 'TooManyRequests') {
            this.ui.showStatus('Rate limited. Waiting before retry...', 'warning');
            setTimeout(() => {
              if (this.isRunning && !this.stopRequested) {
                this.attemptReconnect('Retrying after rate limit...');
              }
            }, 5000);
            return;
          }
          
          console.error('Deriv API error:', data.error);
          this.ui.showStatus(message, 'error');
          return;
        }

        switch (data.msg_type) {
          case 'authorize':
            if (!data.authorize) {
              console.error('Authorize response missing authorize data:', data);
              return;
            }
            this.handleAuthorize(data.authorize);
            break;
          case 'balance':
            this.handleBalance(data.balance);
            break;
          case 'tick':
            this.handleTick(data.tick);
            break;
          case 'proposal':
            this.handleProposal(data.proposal);
            break;
          case 'buy':
            this.handleBuy(data.buy);
            break;
          case 'proposal_open_contract':
            this.handleContractUpdate(data.proposal_open_contract);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('QuantumEdge message error', error);
        this.stop('Error processing Deriv response.', 'error');
      }
    }

    handleAuthorize(authorize) {
      if (!authorize) {
        console.error('handleAuthorize called with undefined authorize data');
        return;
      }
      this.currency = authorize.currency || 'USD';
      this.balance = Number(authorize.balance) || 0;
      this.ui.updateBalance(this.balance, this.currency);
      
      if (this.isReconnecting) {
        this.ui.showStatus('Reconnected. Resuming trading...', 'success');
        this.isReconnecting = false;
      } else {
        this.ui.showStatus('Quantum Edge connected. Analyzing mean reversion opportunities...', 'success');
      }

      this.subscribeToBalance();
      this.subscribeToTicks();
      this.subscribeToContracts();
    }

    subscribeToBalance() {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    }

    subscribeToTicks() {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ ticks: this.symbol, subscribe: 1 }));
    }

    subscribeToContracts() {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
    }

    handleBalance(balance) {
      if (typeof balance?.balance !== 'undefined') {
        this.balance = Number(balance.balance);
        this.ui.updateBalance(balance.currency || this.currency);
      }
    }

    handleTick(tick) {
      if (!tick?.quote) return;
      const price = parseFloat(tick.quote);
      this.priceHistory.unshift(price);
      if (this.priceHistory.length > Math.max(this.lookbackPeriod, this.rsiPeriod + 1)) {
        this.priceHistory.pop();
      }

      if (!this.hasOpenContract && !this.pendingProposal && this.priceHistory.length >= this.lookbackPeriod) {
        this.executeTrade();
      }
    }

    handleProposal(proposal) {
      if (!this.isRunning || !proposal?.id || !this.pendingProposal || !this.ws) return;
      this.currentProposalId = proposal.id;
      this.ws.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price }));
    }

    handleBuy(buy) {
      if (!buy?.contract_id) return;
      this.hasOpenContract = true;
      this.pendingProposal = false;
      this.currentProposalId = null;
      this.activeContractId = buy.contract_id;
    }

    handleContractUpdate(contract) {
      if (!contract?.is_sold || contract.contract_id !== this.activeContractId) {
        return;
      }

      const profit = parseFloat(contract.profit) || 0;
      const win = profit > 0;

      this.updateStats({
        stake: this.currentStake,
        profit,
        win,
        market: this.symbol,
        digit: this.lastTradeType || '-'
      });

      this.hasOpenContract = false;
      this.tradeInProgress = false;
      this.activeContractId = null;

      // Update adaptive confidence based on recent performance
      this.updateAdaptiveConfidence(win);

      if (!this.shouldStop()) {
        setTimeout(() => this.executeTrade(), 800);
      }
    }

    executeTrade() {
      if (!this.isRunning || this.hasOpenContract || this.pendingProposal || this.tradeInProgress) {
        return;
      }

      const now = Date.now();
      if (now - this.lastTradeTime < 2000) {
        return; // Cooldown between trades
      }

      const signal = this.analyzeMeanReversion();
      if (!signal) {
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost during trade. Reconnecting...');
        }
        return;
      }

      this.pendingProposal = true;
      this.tradeInProgress = true;
      this.lastTradeTime = now;
      this.lastTradeType = signal.type;
      this.ui.updateTargets(this.symbol, signal.type);

      this.ws.send(JSON.stringify({
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: signal.type,
        currency: this.currency,
        duration: signal.duration,
        duration_unit: 't',
        symbol: this.symbol
      }));
    }

    analyzeMeanReversion() {
      if (this.priceHistory.length < this.lookbackPeriod) {
        return null;
      }

      const prices = this.priceHistory.slice(0, this.lookbackPeriod);
      const bollinger = this.calculateBollingerBands(prices);
      const rsi = this.calculateRSI(prices);
      const currentPrice = prices[0];
      
      if (!bollinger || rsi === null) {
        return null;
      }

      // Calculate price position relative to Bollinger Bands
      const bandWidth = bollinger.upper - bollinger.lower;
      const pricePosition = (currentPrice - bollinger.lower) / bandWidth;
      
      // Calculate confidence score (0-1)
      let confidence = 0;
      let signalType = null;

      // Mean Reversion Strategy:
      // When price touches upper band (overbought) → PUT (expect price to fall back to mean)
      // When price touches lower band (oversold) → CALL (expect price to rise back to mean)
      
      // Upper band touch (overbought) - PUT signal
      if (currentPrice >= bollinger.upper) {
        confidence += 0.4; // Base confidence for band touch
        signalType = 'PUT';
        
        // RSI confirmation (>70 = overbought)
        if (rsi > 70) {
          confidence += 0.3;
        } else if (rsi > 60) {
          confidence += 0.15;
        }
        
        // Strong touch (price well above upper band)
        if (currentPrice > bollinger.upper * 1.001) {
          confidence += 0.2;
        }
      }
      // Lower band touch (oversold) - CALL signal
      else if (currentPrice <= bollinger.lower) {
        confidence += 0.4; // Base confidence for band touch
        signalType = 'CALL';
        
        // RSI confirmation (<30 = oversold)
        if (rsi < 30) {
          confidence += 0.3;
        } else if (rsi < 40) {
          confidence += 0.15;
        }
        
        // Strong touch (price well below lower band)
        if (currentPrice < bollinger.lower * 0.999) {
          confidence += 0.2;
        }
      }
      // Near bands but not touching - lower confidence
      else if (pricePosition > 0.85) {
        // Near upper band
        confidence = 0.3;
        signalType = 'PUT';
        if (rsi > 65) confidence += 0.2;
      } else if (pricePosition < 0.15) {
        // Near lower band
        confidence = 0.3;
        signalType = 'CALL';
        if (rsi < 35) confidence += 0.2;
      }

      // Require minimum confidence (adaptive based on recent win rate)
      if (confidence < this.adaptiveConfidence || !signalType) {
        return null;
      }

      // Determine duration based on band width (volatility)
      const duration = bandWidth > 0.01 ? 1 : 2; // Higher volatility = shorter duration

      return {
        type: signalType,
        duration: duration,
        confidence: confidence
      };
    }

    calculateBollingerBands(prices) {
      if (prices.length < this.lookbackPeriod) return null;

      // Calculate Simple Moving Average (SMA)
      const sma = prices.slice(0, this.lookbackPeriod).reduce((sum, price) => sum + price, 0) / this.lookbackPeriod;

      // Calculate Standard Deviation
      const variance = prices.slice(0, this.lookbackPeriod).reduce((sum, price) => {
        return sum + Math.pow(price - sma, 2);
      }, 0) / this.lookbackPeriod;
      const stdDev = Math.sqrt(variance);

      return {
        middle: sma,
        upper: sma + (this.stdDevMultiplier * stdDev),
        lower: sma - (this.stdDevMultiplier * stdDev),
        width: (this.stdDevMultiplier * stdDev * 2)
      };
    }

    calculateRSI(prices, period = this.rsiPeriod) {
      if (prices.length < period + 1) return null;
      let gains = 0;
      let losses = 0;
      for (let i = 1; i <= period; i += 1) {
        const diff = prices[i - 1] - prices[i];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      const avgGain = gains / period;
      const avgLoss = losses / period;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

    updateAdaptiveConfidence(win) {
      // Track recent win rate
      this.winRateHistory.push(win ? 1 : 0);
      if (this.winRateHistory.length > 20) {
        this.winRateHistory.shift();
      }

      // Calculate recent win rate
      const recentWinRate = this.winRateHistory.length > 0
        ? this.winRateHistory.reduce((sum, w) => sum + w, 0) / this.winRateHistory.length
        : 0.5;

      // Adapt confidence threshold:
      // If win rate is high (>70%), we can be slightly less strict (lower threshold)
      // If win rate is low (<60%), we need to be more strict (higher threshold)
      if (recentWinRate > 0.7) {
        this.adaptiveConfidence = Math.max(this.minConfidence, this.minConfidence - 0.05);
      } else if (recentWinRate < 0.6) {
        this.adaptiveConfidence = Math.min(0.85, this.minConfidence + 0.1);
      } else {
        this.adaptiveConfidence = this.minConfidence;
      }
    }

    updateStats(tradeResult) {
      this.totalTrades += 1;
      if (tradeResult.win) {
        this.wins += 1;
        this.consecutiveLosses = 0;
        this.currentStake = this.config.initialStake;
      } else {
        this.consecutiveLosses += 1;
        this.currentStake = parseFloat((this.currentStake * this.config.martingaleMultiplier).toFixed(2));
      }

      this.totalProfit = parseFloat((this.totalProfit + tradeResult.profit).toFixed(2));
      this.ui.addHistoryEntry({
        ...tradeResult,
        timestamp: new Date()
      });
      this.ui.updateStats(this.getStatsSnapshot());
    }

    getStatsSnapshot() {
      const winRate = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(2) : '0.00';
      return {
        balance: this.balance,
        currency: this.currency,
        totalProfit: this.totalProfit,
        totalTrades: this.totalTrades,
        winRate,
        currentStake: this.currentStake,
        consecutiveLosses: this.consecutiveLosses,
        market: this.symbol,
        digit: this.lastTradeType || '-',
        runningTime: this.getRunningTime()
      };
    }

    shouldStop() {
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showTakeProfit({
            profit: stats.totalProfit,
            trades: stats.totalTrades,
            time: stats.runningTime
          });
        }
        this.stop('Take profit reached. Quantum Edge stopped.', 'success');
        return true;
      }

      if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showStopLoss({
            profit: stats.totalProfit,
            trades: stats.totalTrades,
            time: stats.runningTime
          });
        }
        this.stop('Stop loss hit. Quantum Edge stopped.', 'error');
        return true;
      }

      return false;
    }

    startRunningTimer() {
      this.clearRunningTimer();
      this.runningTimer = setInterval(() => {
        if (this.isRunning) {
          this.ui.updateRunningTime(this.getRunningTime());
        }
      }, 1000);
    }

    clearRunningTimer() {
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
      }
    }

    getRunningTime() {
      if (!this.startTime) return '00:00:00';
      const diff = Math.max(0, Math.floor((Date.now() - this.startTime.getTime()) / 1000));
      const hours = Math.floor(diff / 3600).toString().padStart(2, '0');
      const minutes = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
      const seconds = (diff % 60).toString().padStart(2, '0');
      return `${hours}:${minutes}:${seconds}`;
    }
  }

  window.QuantumEdgeBot = QuantumEdgeBot;
})();

