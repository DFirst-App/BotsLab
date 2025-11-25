(() => {
  class SmartVolatilityBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;

      this.symbol = 'R_75';
      this.volatilityWindow = 10;
      this.atrPeriod = 5;
      this.volatilityThreshold = 0.0015;

      this.resetState();
    }

    resetState() {
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.priceHistory = [];
      this.lastVolatility = null;
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
      this.proposalTimeout = null;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Smart Volatility is already running.', 'warning');
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
      this.ui.showStatus('Authorizing Smart Volatility...', 'info');

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
      this.clearTimers();
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
      this.activeContractId = null;
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
      this.clearTimers();
    }

    clearTimers() {
      this.clearRunningTimer();
      this.clearProposalTimeout();
    }

    clearRunningTimer() {
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
      }
    }

    clearProposalTimeout() {
      if (this.proposalTimeout) {
        clearTimeout(this.proposalTimeout);
        this.proposalTimeout = null;
      }
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
        console.error('SmartVolatility message error', error);
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
        this.ui.showStatus('Smart Volatility connected. Waiting for volatility signal...', 'success');
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
      if (this.priceHistory.length > this.volatilityWindow) {
        this.priceHistory.pop();
      }

      if (!this.hasOpenContract && !this.pendingProposal && this.priceHistory.length >= this.volatilityWindow) {
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
      this.clearProposalTimeout();
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
      this.clearProposalTimeout();

      if (!this.shouldStop()) {
        setTimeout(() => this.executeTrade(), 900);
      }
    }

    executeTrade() {
      if (
        !this.isRunning ||
        this.pendingProposal ||
        this.tradeInProgress ||
        this.hasOpenContract
      ) {
        return;
      }

      const now = Date.now();
      if (now - this.lastTradeTime < 2000) {
        return;
      }

      const signal = this.analyzeVolatility();
      if (!signal) {
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost during trade. Reconnecting...');
        }
        return;
      }

      const stake = this.adjustStakeByVolatility(this.lastVolatility) || this.config.initialStake;
      const duration = this.adjustDurationByVolatility(this.lastVolatility);

      this.pendingProposal = true;
      this.tradeInProgress = true;
      this.lastTradeTime = now;
      this.lastTradeType = signal;
      this.currentStake = stake;
      this.ui.updateTargets(this.symbol, signal);

      this.ws.send(JSON.stringify({
        proposal: 1,
        amount: stake.toFixed(2),
        basis: 'stake',
        contract_type: signal,
        currency: this.currency,
        duration,
        duration_unit: 't',
        symbol: this.symbol
      }));

      this.proposalTimeout = setTimeout(() => {
        if (this.pendingProposal) {
          this.pendingProposal = false;
          this.tradeInProgress = false;
        }
      }, 5000);
    }

    analyzeVolatility() {
      if (this.priceHistory.length < this.atrPeriod) {
        return null;
      }

      const atr = this.calculateATR();
      if (!atr) return null;
      this.lastVolatility = atr;

      const latest = this.priceHistory[0];
      const previous = this.priceHistory[1];
      const change = Math.abs(latest - previous);

      if (change > atr * 1.2) {
        return latest > previous ? 'CALL' : 'PUT';
      }

      if (atr > this.volatilityThreshold) {
        const avg = this.priceHistory.slice(0, 3).reduce((sum, value) => sum + value, 0) / 3;
        return latest > avg ? 'CALL' : 'PUT';
      }

      return null;
    }

    calculateATR() {
      if (this.priceHistory.length < this.atrPeriod) return null;
      let atr = 0;
      for (let i = 1; i < this.atrPeriod; i += 1) {
        const high = Math.max(this.priceHistory[i], this.priceHistory[i - 1]);
        const low = Math.min(this.priceHistory[i], this.priceHistory[i - 1]);
        atr += (high - low);
      }
      return atr / this.atrPeriod;
    }

    adjustStakeByVolatility(volatility) {
      if (!volatility) return this.config.initialStake;
      if (volatility > this.volatilityThreshold * 1.5) {
        return this.roundStake(this.config.initialStake * 0.8);
      }
      if (volatility < this.volatilityThreshold * 0.5) {
        return this.roundStake(this.config.initialStake * 1.2);
      }
      return this.roundStake(this.config.initialStake);
    }

    adjustDurationByVolatility(volatility) {
      if (!volatility) return 1;
      if (volatility > this.volatilityThreshold * 1.5) {
        return 1;
      }
      if (volatility < this.volatilityThreshold * 0.5) {
        return 2;
      }
      return 1;
    }

    roundStake(value) {
      return Math.max(this.defaults.minStake, Math.round(value * 100) / 100);
    }

    updateStats(tradeResult) {
      this.totalTrades += 1;
      if (tradeResult.win) {
        this.wins += 1;
        this.consecutiveLosses = 0;
      } else {
        this.consecutiveLosses += 1;
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
        this.stop('Take profit reached. Smart Volatility stopped.', 'success');
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
        this.stop('Stop loss hit. Smart Volatility stopped.', 'error');
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

    getRunningTime() {
      if (!this.startTime) return '00:00:00';
      const diff = Math.max(0, Math.floor((Date.now() - this.startTime.getTime()) / 1000));
      const hours = Math.floor(diff / 3600).toString().padStart(2, '0');
      const minutes = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
      const seconds = (diff % 60).toString().padStart(2, '0');
      return `${hours}:${minutes}:${seconds}`;
    }
  }

  window.SmartVolatilityBot = SmartVolatilityBot;
})();

