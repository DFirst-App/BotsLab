(() => {
  class RiseFallBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;

      this.symbol = 'R_10';
      this.trendWindow = 15;

      this.resetState();
    }

    resetState() {
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.balance = 0;
      this.currency = 'USD';
      this.tradeHistory = [];
      this.priceHistory = [];
      this.priceMovements = [];
      this.volumeProfile = [];
      this.currentDirection = null;
      this.hasOpenContract = false;
      this.pendingProposal = false;
      this.tradeInProgress = false;
      this.currentProposalId = null;
      this.lastContractId = null;
      this.runningTimer = null;
      this.startTime = null;
      this.lastSignalStrength = 0;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Rise/Fall Pro is already running.', 'warning');
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
      this.ui.showStatus('Authorizing Rise/Fall Pro...', 'info');

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
      this.currentProposalId = null;
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
        }

        switch (data.msg_type) {
          case 'authorize':
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
        console.error('RiseFall message error', error);
        this.stop('Error processing Deriv response.', 'error');
      }
    }

    handleAuthorize(authorize) {
      this.currency = authorize.currency || 'USD';
      this.balance = Number(authorize.balance) || 0;
      this.ui.updateBalance(this.balance, this.currency);
      
      if (this.isReconnecting) {
        this.ui.showStatus('Reconnected. Resuming trading...', 'success');
        this.isReconnecting = false;
      } else {
        this.ui.showStatus('Rise/Fall Pro connected. Watching R10 momentum...', 'success');
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
        this.ui.updateBalance(this.balance, balance.currency || this.currency);
      }
    }

    handleTick(tick) {
      if (!tick?.quote) return;
      const price = parseFloat(tick.quote);
      this.priceHistory.unshift(price);
      if (this.priceHistory.length > Math.max(this.trendWindow, 26)) {
        this.priceHistory.pop();
      }

      const currentMovement = this.priceHistory[0] - (this.priceHistory[1] || this.priceHistory[0]);
      this.priceMovements.unshift(currentMovement);
      if (this.priceMovements.length > 5) this.priceMovements.pop();

      this.volumeProfile.unshift(Math.abs(currentMovement));
      if (this.volumeProfile.length > 10) this.volumeProfile.pop();

      if (!this.hasOpenContract && !this.pendingProposal && this.priceHistory.length >= this.trendWindow) {
        this.executeTrade();
      }
    }

    handleProposal(proposal) {
      if (!this.isRunning || !proposal?.id || !this.pendingProposal || !this.ws) return;
      this.ws.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price }));
    }

    handleBuy(buy) {
      if (!buy?.contract_id) return;
      this.hasOpenContract = true;
      this.pendingProposal = false;
      this.currentProposalId = null;
      this.lastContractId = buy.contract_id;
    }

    handleContractUpdate(contract) {
      if (!contract?.is_sold || contract.contract_id !== this.lastContractId) {
        return;
      }

      const profit = parseFloat(contract.profit) || 0;
      const win = profit > 0;
      this.updateStats({
        stake: this.currentStake,
        profit,
        win,
        market: this.symbol,
        digit: this.currentDirection ? this.currentDirection.toUpperCase() : '-'
      });

      this.hasOpenContract = false;
      this.tradeInProgress = false;
      this.lastContractId = null;

      if (!this.shouldStop()) {
        setTimeout(() => this.executeTrade(), 600);
      }
    }

    executeTrade() {
      if (!this.isRunning || this.hasOpenContract || this.pendingProposal || this.tradeInProgress) {
        return;
      }

      const direction = this.analyzeMarket();
      if (!direction) {
        return;
      }

      this.currentDirection = direction;
      const contractType = direction === 'rise' ? 'CALL' : 'PUT';

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost during trade. Reconnecting...');
        }
        return;
      }

      this.pendingProposal = true;
      this.tradeInProgress = true;
      this.ui.updateTargets(this.symbol, contractType);

      this.ws.send(JSON.stringify({
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: contractType,
        currency: this.currency,
        duration: 5,
        duration_unit: 't',
        symbol: this.symbol
      }));
    }

    analyzeMarket() {
      if (this.priceHistory.length < this.trendWindow) {
        return null;
      }

      const prices = this.priceHistory;
      const shortMomentum = prices[0] - (prices[3] || prices[0]);
      const mediumMomentum = prices[0] - (prices[7] || prices[0]);
      const longMomentum = prices[0] - (prices[14] || prices[0]);
      const rsi = this.calculateRSI(prices);
      const macd = this.calculateMACD(prices);
      const volatility = this.calculateVolatility(prices);
      const pattern = this.detectPattern(prices);

      let signal = null;
      let strength = 0;

      if (pattern) {
        signal = pattern;
        strength += 2;
      }

      if (shortMomentum > 0 && mediumMomentum > 0 && longMomentum > 0) {
        signal = 'rise';
        strength += 1;
      } else if (shortMomentum < 0 && mediumMomentum < 0 && longMomentum < 0) {
        signal = 'fall';
        strength += 1;
      }

      if (rsi < 30) strength += signal === 'rise' ? 1 : -1;
      else if (rsi > 70) strength += signal === 'fall' ? 1 : -1;

      if (macd.histogram > 0 && macd.macd > 0) strength += signal === 'rise' ? 1 : -1;
      else if (macd.histogram < 0 && macd.macd < 0) strength += signal === 'fall' ? 1 : -1;

      const requiredStrength = volatility > 0.001 ? 3 : 2;
      if (Math.abs(strength) < requiredStrength) {
        return null;
      }

      this.lastSignalStrength = strength;
      return signal;
    }

    detectPattern(prices) {
      if (prices.length < 5) return null;
      const diffs = [];
      for (let i = 1; i < 5; i += 1) {
        diffs.push(prices[i - 1] - prices[i]);
      }
      const doubleTop = diffs[0] < 0 && diffs[1] > 0 && diffs[2] < 0 && diffs[3] > 0;
      const doubleBottom = diffs[0] > 0 && diffs[1] < 0 && diffs[2] > 0 && diffs[3] < 0;
      if (doubleTop) return 'fall';
      if (doubleBottom) return 'rise';
      return null;
    }

    calculateRSI(prices, period = 14) {
      if (prices.length < period + 1) return 50;
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

    calculateEMA(prices, period) {
      if (prices.length < period) return null;
      const multiplier = 2 / (period + 1);
      let ema = prices[prices.length - 1];
      for (let i = prices.length - 2; i >= 0; i -= 1) {
        ema = (prices[i] - ema) * multiplier + ema;
      }
      return ema;
    }

    calculateMACD(prices) {
      const fastEMA = this.calculateEMA(prices, 12);
      const slowEMA = this.calculateEMA(prices, 26);
      if (!fastEMA || !slowEMA) return { macd: 0, signal: 0, histogram: 0 };
      const macd = fastEMA - slowEMA;
      const signalLine = this.calculateEMA([...prices, macd], 9) || 0;
      return { macd, signal: signalLine, histogram: macd - signalLine };
    }

    calculateVolatility(prices) {
      if (prices.length < 2) return 0;
      const returns = [];
      for (let i = 1; i < prices.length; i += 1) {
        returns.push((prices[i - 1] - prices[i]) / prices[i]);
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      return Math.sqrt(variance);
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
        digit: this.currentDirection ? this.currentDirection.toUpperCase() : '-',
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
        this.stop('Take profit reached. Rise/Fall Pro stopped.', 'success');
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
        this.stop('Stop loss hit. Rise/Fall Pro stopped.', 'error');
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

  window.RiseFallBot = RiseFallBot;
})();

