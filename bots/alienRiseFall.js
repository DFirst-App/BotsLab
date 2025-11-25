(() => {
  class AlienRiseFallBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;

      this.symbol = 'R_10';
      this.trendWindow = 10;
      this.rsiPeriod = 7;
      this.resetState();
    }

    resetState() {
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.currentStake = this.config.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.balance = 0;
      this.currency = 'USD';
      this.priceHistory = [];
      this.currentDirection = null;
      this.hasOpenContract = false;
      this.pendingProposal = false;
      this.tradeInProgress = false;
      this.waitingForTrend = false;
      this.trendConfirmationCount = 0;
      this.lastContractId = null;
      this.currentProposalId = null;
      this.runningTimer = null;
      this.startTime = null;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Alien Rise/Fall is already running.', 'warning');
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
      this.ui.showStatus('Authorizing Alien Rise/Fall...', 'info');

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
          return; // Don't process message further if there's an error
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
        console.error('AlienRiseFall message error', error);
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
        this.ui.showStatus('Alien Rise/Fall connected. Waiting for momentum confirmation...', 'success');
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
      if (this.priceHistory.length > Math.max(this.trendWindow, this.rsiPeriod + 1)) {
        this.priceHistory.pop();
      }

      if (!this.hasOpenContract && !this.pendingProposal && this.priceHistory.length >= this.trendWindow) {
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

      const prices = this.priceHistory.slice(0, this.trendWindow);
      const rsi = this.calculateRSI(prices);
      const trend = this.calculateTrendStrength(prices);

      if (this.waitingForTrend) {
        if (trend.consistency > 0.7) {
          this.trendConfirmationCount += 1;
          if (this.trendConfirmationCount >= 2) {
            this.waitingForTrend = false;
            this.trendConfirmationCount = 0;
            return trend.direction;
          }
        } else {
          this.trendConfirmationCount = 0;
        }
        return null;
      }

      if (trend.consistency > 0.6) {
        return trend.direction;
      }

      if (rsi < 30) return 'rise';
      if (rsi > 70) return 'fall';
      return null;
    }

    calculateRSI(prices) {
      if (prices.length < this.rsiPeriod + 1) return 50;
      let gains = 0;
      let losses = 0;
      for (let i = 1; i <= this.rsiPeriod; i += 1) {
        const diff = prices[i - 1] - prices[i];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      const avgGain = gains / this.rsiPeriod;
      const avgLoss = losses / this.rsiPeriod;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

    calculateTrendStrength(prices) {
      if (prices.length < 3) return { direction: null, consistency: 0 };
      const shortTrend = prices[0] - prices[2];
      const direction = shortTrend > 0 ? 'rise' : 'fall';
      let consistentMoves = 0;
      for (let i = 1; i < prices.length; i += 1) {
        if ((shortTrend > 0 && prices[i - 1] > prices[i]) ||
            (shortTrend < 0 && prices[i - 1] < prices[i])) {
          consistentMoves += 1;
        }
      }
      const consistency = consistentMoves / (prices.length - 1);
      return { direction, consistency };
    }

    updateStats(tradeResult) {
      this.totalTrades += 1;
      if (tradeResult.win) {
        this.wins += 1;
        this.consecutiveLosses = 0;
        this.currentStake = this.config.initialStake;
        this.waitingForTrend = false;
      } else {
        this.consecutiveLosses += 1;
        this.currentStake = parseFloat((this.currentStake * this.config.martingaleMultiplier).toFixed(2));
        this.waitingForTrend = true;
        this.trendConfirmationCount = 0;
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
        this.stop('Take profit reached. Alien Rise/Fall stopped.', 'success');
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
        this.stop('Stop loss hit. Alien Rise/Fall stopped.', 'error');
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

  window.AlienRiseFallBot = AlienRiseFallBot;
})();

