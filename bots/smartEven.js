(() => {
  class SmartEvenBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;

      this.symbol = 'R_50';
      this.trendWindow = 12;
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
      this.startTime = null;
      this.runningTimer = null;

      this.priceHistory = [];
      this.digitHistory = [];
      this.currentMode = null;
      this.hasOpenContract = false;
      this.pendingProposal = false;
      this.tradeInProgress = false;
      this.waitingForPattern = false;
      this.evenOddDistribution = { even: 0, odd: 0 };
      this.streakCounter = { even: 0, odd: 0 };
      this.lastContractId = null;
      this.currentProposalId = null;
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Smart Even is already running.', 'warning');
        return;
      }

      const token = this.resolveAuthToken();
      if (!token) {
        this.ui.showStatus('Connect your Deriv account from the dashboard first.', 'error');
        return;
      }

      this.resetState();
      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Authorizing Smart Even...', 'info');

      this.isRunning = true;
      this.startTime = new Date();
      this.startRunningTimer();

      this.ws = new this.WebSocketImpl(this.wsUrl);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ authorize: token }));
      };
      this.ws.onmessage = (event) => this.handleMessage(event.data);
      this.ws.onerror = () => {
        this.ui.showStatus('WebSocket error encountered.', 'error');
        this.stop('Connection error', 'error');
      };
      this.ws.onclose = () => {
        if (!this.stopRequested) {
          this.ui.showStatus('Connection closed unexpectedly.', 'error');
        }
        this.finishStop();
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

    finishStop() {
      this.isRunning = false;
      this.pendingProposal = false;
      this.tradeInProgress = false;
      this.hasOpenContract = false;
      this.currentProposalId = null;
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
      }
      this.ws = null;
      this.clearRunningTimer();
    }

    handleMessage(raw) {
      try {
        const data = JSON.parse(raw);
        if (data.error) {
          const message = data.error.message || 'Deriv returned an error.';
          this.ui.showStatus(message, 'error');
          this.stop(message, 'error');
          return;
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
        console.error('SmartEven message error', error);
        this.stop('Error processing Deriv response.', 'error');
      }
    }

    handleAuthorize(authorize) {
      this.currency = authorize.currency || 'USD';
      this.balance = Number(authorize.balance) || 0;
      this.ui.updateBalance(this.balance, this.currency);
      this.ui.showStatus('Smart Even connected. Waiting for pattern confirmation...', 'success');

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
      const digit = parseInt(tick.quote.toString().slice(-1), 10);
      if (Number.isNaN(digit)) return;

      this.updateDistribution(digit);
      this.priceHistory.unshift(price);
      this.digitHistory.unshift(digit);
      if (this.priceHistory.length > this.trendWindow) {
        this.priceHistory.pop();
        this.digitHistory.pop();
      }

      if (!this.hasOpenContract && !this.pendingProposal && this.digitHistory.length >= this.trendWindow) {
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
        digit: this.currentMode ? this.currentMode.toUpperCase() : '-'
      });

      this.hasOpenContract = false;
      this.tradeInProgress = false;
      this.lastContractId = null;

      if (!this.shouldStop()) {
        setTimeout(() => this.executeTrade(), 600);
      }
    }

    updateDistribution(digit) {
      if (digit % 2 === 0) {
        this.evenOddDistribution.even += 1;
        this.streakCounter.even += 1;
        this.streakCounter.odd = 0;
      } else {
        this.evenOddDistribution.odd += 1;
        this.streakCounter.odd += 1;
        this.streakCounter.even = 0;
      }
    }

    calculateProbability() {
      const total = this.evenOddDistribution.even + this.evenOddDistribution.odd;
      if (total === 0) return null;
      return {
        even: this.evenOddDistribution.even / total,
        odd: this.evenOddDistribution.odd / total,
        evenStreak: this.streakCounter.even,
        oddStreak: this.streakCounter.odd
      };
    }

    analyzePattern() {
      if (this.digitHistory.length < this.trendWindow) {
        return null;
      }
      const probs = this.calculateProbability();
      if (!probs) return null;

      if (this.waitingForPattern) {
        const threshold = 0.55;
        if (probs.even > threshold) return 'odd';
        if (probs.odd > threshold) return 'even';
        if (probs.evenStreak >= 2) return 'odd';
        if (probs.oddStreak >= 2) return 'even';
        return null;
      }

      if (probs.evenStreak >= 3) return 'odd';
      if (probs.oddStreak >= 3) return 'even';
      if (probs.even > 0.55) return 'odd';
      if (probs.odd > 0.55) return 'even';
      return null;
    }

    executeTrade() {
      if (!this.isRunning || this.hasOpenContract || this.pendingProposal || this.tradeInProgress) {
        return;
      }

      const mode = this.analyzePattern();
      if (!mode) {
        if (this.isRunning) {
          setTimeout(() => this.executeTrade(), 500);
        }
        return;
      }

      this.currentMode = mode;
      const contractType = mode === 'even' ? 'DIGITEVEN' : 'DIGITODD';

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stop('Connection closed. Please restart Smart Even.', 'error');
        return;
      }

      this.pendingProposal = true;
      this.tradeInProgress = true;
      this.ui.updateTargets(this.symbol, contractType === 'DIGITEVEN' ? 'Even' : 'Odd');

      this.ws.send(JSON.stringify({
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: contractType,
        currency: this.currency,
        duration: 1,
        duration_unit: 't',
        symbol: this.symbol
      }));
    }

    updateStats(tradeResult) {
      this.totalTrades += 1;
      if (tradeResult.win) {
        this.wins += 1;
        this.consecutiveLosses = 0;
        this.currentStake = this.config.initialStake;
        this.waitingForPattern = false;
      } else {
        this.consecutiveLosses += 1;
        this.currentStake = parseFloat((this.currentStake * this.config.martingaleMultiplier).toFixed(2));
        this.waitingForPattern = true;
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
        digit: this.currentMode ? this.currentMode.toUpperCase() : '-',
        runningTime: this.getRunningTime()
      };
    }

    shouldStop() {
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        this.stop('Take profit reached. Smart Even stopped.', 'success');
        return true;
      }
      if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
        this.stop('Stop loss hit. Smart Even stopped.', 'error');
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

  window.SmartEvenBot = SmartEvenBot;
})();

