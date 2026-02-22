(() => {
  class SimAllMarketsUnderBot {
    constructor(ui, options) {
      this.ui = ui;
      this.defaults = options.defaults;
      this.markets = options.markets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
      this.simBase = new SimBase();
      this.resetState();
    }

    resetState() {
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.tradeInProgress = false;
      this.lastMarket = null;
      this.currentMarket = null;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.balance = 0;
      this.accountCurrency = 'USD';
      this.startTime = null;
      this.runningTimer = null;
      this.tradeTimeout = null;
    }

    async start(config) {
      if (this.isRunning) return;
      const urlParams = new URLSearchParams(window.location.search);
      const simBalance = parseFloat(urlParams.get('balance')) || parseFloat(localStorage.getItem('simBalance')) || 1000;
      this.balance = simBalance;
      this.accountCurrency = 'USD';
      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.ui.resetHistory();
      this.ui.updateBalance(this.balance, this.accountCurrency);
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Simulation mode: Starting Under 9 sequence...', 'success');
      this.isRunning = true;
      this.stopRequested = false;
      this.startTime = new Date();
      this.startRunningTimer();
      setTimeout(() => this.queueNextTrade(), 500);
    }

    stop(message = 'Bot stopped', type = 'info') {
      if (!this.isRunning) return;
      this.stopRequested = true;
      this.finishStop(message, type);
    }

    finishStop(message, type) {
      this.isRunning = false;
      if (this.tradeTimeout) clearTimeout(this.tradeTimeout);
      this.clearRunningTimer();
      this.ui.setRunningState(false);
      this.ui.showStatus(message, type);
    }

    queueNextTrade() {
      if (!this.isRunning || this.tradeInProgress || this.stopRequested) return;
      const market = this.getNextMarket();
      this.tradeInProgress = true;
      this.currentMarket = market;
      this.ui.updateTargets(market, 'Under 9');
      const duration = this.simBase.getContractDuration(1);
      this.tradeTimeout = setTimeout(() => this.executeTrade(market), duration);
    }

    getNextMarket() {
      const options = this.markets.filter((m) => m !== this.lastMarket);
      const market = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : this.markets[Math.floor(Math.random() * this.markets.length)];
      this.lastMarket = market;
      return market;
    }

    executeTrade(market) {
      if (!this.isRunning || this.stopRequested) return;
      const win = this.simBase.simulateTradeWithConstraints('DIGITUNDER_9', true, this.consecutiveLosses, this.tradeHistory);
      const profit = this.simBase.calculateProfit(this.currentStake, 'DIGITUNDER_9', win);
      this.balance = parseFloat((this.balance + profit).toFixed(2));
      this.updateStats({ profit, win, market, digit: 'Under 9', stake: this.currentStake });
      this.tradeHistory.push(win);
      if (this.tradeHistory.length > 10) this.tradeHistory.shift();
      this.tradeInProgress = false;
      if (this.shouldStop()) return;
      setTimeout(() => this.queueNextTrade(), this.simBase.getNextTradeDelay(1));
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
      this.ui.addHistoryEntry({ ...tradeResult, timestamp: new Date() });
      this.ui.updateBalance(this.balance, this.accountCurrency);
      this.ui.updateStats(this.getStatsSnapshot(tradeResult));
    }

    shouldStop() {
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showTakeProfit({ profit: stats.totalProfit, trades: stats.totalTrades, time: stats.runningTime });
        }
        this.stop('Take profit reached. Bot stopped.', 'success');
        return true;
      }
      if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showStopLoss({ profit: stats.totalProfit, trades: stats.totalTrades, time: stats.runningTime });
        }
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
        digit: 'Under 9',
        runningTime: this.getRunningTime()
      };
    }

    startRunningTimer() {
      this.clearRunningTimer();
      this.runningTimer = setInterval(() => {
        if (this.isRunning) this.ui.updateRunningTime(this.getRunningTime());
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

  window.SimAllMarketsUnderBot = SimAllMarketsUnderBot;
})();
