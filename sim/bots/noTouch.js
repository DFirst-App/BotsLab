(() => {
  class SimNoTouchBot {
    constructor(ui, options) {
      this.ui = ui;
      this.defaults = options.defaults;
      this.simBase = new SimBase();
      this.symbol = 'R_100';
      this.resetState();
    }

    resetState() {
      this.isRunning = false;
      this.stopRequested = false;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.tradeInProgress = false;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.balance = 0;
      this.accountCurrency = 'USD';
      this.startTime = null;
      this.runningTimer = null;
      this.tradeTimeout = null;
      this.currentBarrier = null;
      this.tradeHistory = [];
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
      this.ui.showStatus('Simulation mode: Starting No Touch Sentinel...', 'success');
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

      // Simulate trend-sensing: randomly choose barrier direction
      const barrier = Math.random() < 0.5 ? '+0.63' : '-0.63';
      this.tradeInProgress = true;
      this.currentBarrier = barrier;
      this.ui.updateTargets(this.symbol, `CALL ${barrier}`);

      const duration = this.simBase.getContractDuration(5); // 5 ticks for NOTOUCH
      this.tradeTimeout = setTimeout(() => {
        this.executeTrade(barrier);
      }, duration);
    }

    executeTrade(barrier) {
      if (!this.isRunning || this.stopRequested) return;

      const win = this.simBase.simulateTradeWithConstraints('NOTOUCH', false, this.consecutiveLosses, this.tradeHistory);
      const profit = this.simBase.calculateProfit(this.currentStake, 'NOTOUCH', win);
      this.balance = parseFloat((this.balance + profit).toFixed(2));

      if (win) {
        this.wins += 1;
        this.consecutiveLosses = 0;
        this.currentStake = this.config.initialStake;
      } else {
        this.consecutiveLosses += 1;
        this.currentStake = parseFloat((this.currentStake * this.config.martingaleMultiplier).toFixed(2));
      }

      this.totalTrades += 1;
      this.totalProfit = parseFloat((this.totalProfit + profit).toFixed(2));
      this.ui.addHistoryEntry({
        win,
        profit,
        market: this.symbol,
        digit: `NOTOUCH ${barrier}`,
        stake: this.currentStake,
        timestamp: new Date()
      });

      this.ui.updateBalance(this.balance, this.accountCurrency);
      this.ui.updateStats(this.getStatsSnapshot());

      this.tradeHistory.push(win);
      if (this.tradeHistory.length > 10) this.tradeHistory.shift();
      this.tradeInProgress = false;
      if (this.shouldStop()) return;
      setTimeout(() => this.queueNextTrade(), this.simBase.getNextTradeDelay(5));
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

    getStatsSnapshot() {
      const winRate = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(2) : '0.00';
      return {
        balance: this.balance,
        currency: this.accountCurrency,
        totalProfit: this.totalProfit,
        totalTrades: this.totalTrades,
        winRate,
        currentStake: this.currentStake,
        consecutiveLosses: this.consecutiveLosses,
        market: this.symbol,
        digit: this.currentBarrier ? `NOTOUCH ${this.currentBarrier}` : '-',
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

  window.SimNoTouchBot = SimNoTouchBot;
})();
