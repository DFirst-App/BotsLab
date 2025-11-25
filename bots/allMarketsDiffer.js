(() => {
  class AllMarketsDifferBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.markets = options.markets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;

      this.resetState();
    }

    resetState() {
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.stopMessage = null;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.activeContractId = null;
      this.tradeInProgress = false;
      this.lastMarket = null;
      this.lastDigit = null;
      this.currentMarket = null;
      this.currentDigit = null;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.balance = 0;
      this.accountCurrency = 'USD';
      this.startTime = null;
      this.runningTimer = null;
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

      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.lastMarket = null;
      this.lastDigit = null;
      this.activeContractId = null;
      this.tradeInProgress = false;

      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Authorizing with Deriv...', 'info');

      this.isRunning = true;
      this.stopRequested = false;
      this.startTime = new Date();
      this.startRunningTimer();

      this.ws = new this.WebSocketImpl(this.wsUrl);

      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ authorize: token }));
      };

      this.ws.onmessage = (event) => this.handleMessage(event.data);

      this.ws.onerror = () => {
        this.ui.showStatus('WebSocket error. Stopping bot.', 'error');
        this.stop('Connection error', 'error');
      };

      this.ws.onclose = () => {
        if (this.stopRequested) {
          this.finishStop();
        } else {
          this.stopMessage = { message: 'Connection closed unexpectedly.', type: 'error' };
          this.finishStop();
        }
      };
    }

    stop(message = 'Bot stopped', type = 'info') {
      if (!this.isRunning && !this.ws) {
        this.ui.showStatus('Bot is already stopped.', 'warning');
        return;
      }
      this.stopRequested = true;
      this.stopMessage = { message, type };
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close();
      } else {
        this.finishStop();
      }
    }

    finishStop() {
      this.isRunning = false;
      this.tradeInProgress = false;
      this.activeContractId = null;
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
      }
      this.ws = null;
      this.clearRunningTimer();
      this.ui.setRunningState(false);
      if (this.stopMessage) {
        this.ui.showStatus(this.stopMessage.message, this.stopMessage.type);
        this.stopMessage = null;
      }
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
            this.accountCurrency = data.authorize.currency || 'USD';
            this.balance = Number(data.authorize.balance) || 0;
            this.ui.updateBalance(this.balance, this.accountCurrency);
            this.ui.showStatus('Connected. Starting digit differ sequence...', 'success');

            this.subscribeToBalance();
            this.subscribeToContracts();
            this.queueNextTrade();
            break;
          case 'balance':
            if (typeof data.balance?.balance !== 'undefined') {
              this.balance = Number(data.balance.balance);
              this.ui.updateBalance(this.balance, data.balance.currency || this.accountCurrency);
            }
            break;
          case 'proposal':
            if (this.isRunning && data.proposal?.id && this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({
                buy: data.proposal.id,
                price: data.proposal.ask_price
              }));
            }
            break;
          case 'buy':
            if (data.buy?.contract_id) {
              this.activeContractId = data.buy.contract_id;
            }
            break;
          case 'proposal_open_contract':
            this.handleContractUpdate(data.proposal_open_contract);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('Error handling message', error);
      }
    }

    subscribeToBalance() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    }

    subscribeToContracts() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
    }

    queueNextTrade() {
      if (!this.isRunning || this.tradeInProgress) {
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stop('Connection closed. Please restart the bot.', 'error');
        return;
      }

      const market = this.getNextMarket();
      const digit = this.getNextDigit();

      this.tradeInProgress = true;
      this.currentMarket = market;
      this.currentDigit = digit;
      this.ui.updateTargets(market, digit);

      const proposal = {
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: 'DIGITDIFF',
        currency: this.accountCurrency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: market,
        barrier: digit.toString()
      };

      this.ws.send(JSON.stringify(proposal));
    }

    getNextMarket() {
      const options = this.markets.filter((m) => m !== this.lastMarket);
      if (options.length === 0) {
        return this.markets[Math.floor(Math.random() * this.markets.length)];
      }
      const market = options[Math.floor(Math.random() * options.length)];
      this.lastMarket = market;
      return market;
    }

    getNextDigit() {
      let digit = Math.floor(Math.random() * 10);
      if (digit === this.lastDigit) {
        digit = (digit + 3) % 10;
      }
      this.lastDigit = digit;
      return digit;
    }

    handleContractUpdate(contract) {
      if (!contract || !contract.contract_id) return;
      if (this.activeContractId && contract.contract_id !== this.activeContractId) return;

      if (contract.is_sold) {
        const profit = parseFloat(contract.profit) || 0;
        const win = profit > 0;

        this.updateStats({
          profit,
          win,
          market: this.currentMarket,
          digit: this.currentDigit,
          stake: this.currentStake
        });

        this.tradeInProgress = false;
        this.activeContractId = null;

        if (this.shouldStop()) {
          return;
        }

        setTimeout(() => this.queueNextTrade(), 900);
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

      this.ui.updateStats(this.getStatsSnapshot(tradeResult));
    }

    shouldStop() {
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        this.stop('Take profit reached. Bot stopped.', 'success');
        return true;
      }

      if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
        this.stop('Stop loss hit. Bot stopped.', 'error');
        return true;
      }

      return false;
    }

    getStatsSnapshot(lastTrade) {
      const winRate = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(2) : '0.00';
      return {
        balance: this.balance,
        currency: this.accountCurrency,
        totalProfit: this.totalProfit,
        totalTrades: this.totalTrades,
        winRate,
        currentStake: this.currentStake,
        consecutiveLosses: this.consecutiveLosses,
        market: this.currentMarket || '-',
        digit: typeof this.currentDigit === 'number' ? this.currentDigit : '-',
        lastProfit: lastTrade ? lastTrade.profit : 0,
        runningTime: this.getRunningTime()
      };
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

  window.AllMarketsDifferBot = AllMarketsDifferBot;
})();

