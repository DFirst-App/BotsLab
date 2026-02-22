(() => {
  class SimMagicRandomBot {
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
      this.currentTradeType = null; // 'DIFF', 'UNDER', 'OVER'
      this.currentDigit = null;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.balance = 0;
      this.accountCurrency = 'USD';
      this.startTime = null;
      this.runningTimer = null;
      this.tradeTimeout = null;
      this.pendingStopReason = null;
      this.tradeHistory = [];
    }

    async start(config) {
      if (this.isRunning) return;
      const urlParams = new URLSearchParams(window.location.search);
      const simBalance = parseFloat(localStorage.getItem('simBalance')) || parseFloat(urlParams.get('balance')) || 1000;
      this.balance = simBalance;
      this.accountCurrency = 'USD';
      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.pendingStopReason = null;
      this.tradeHistory = [];
      this.ui.resetHistory();
      this.ui.updateBalance(this.balance, this.accountCurrency);
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Starting magic random strategy...', 'success');
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

      // Randomly select trade type: DIFF, OVER, or UNDER
      const tradeTypes = ['DIFF', 'OVER', 'UNDER'];
      const selectedType = tradeTypes[Math.floor(Math.random() * tradeTypes.length)];
      const market = this.getNextMarket();
      let contractType, displayDigit;

      if (selectedType === 'DIFF') {
        const digit = Math.floor(Math.random() * 10);
        contractType = 'DIGITDIFF';
        displayDigit = digit;
      } else if (selectedType === 'OVER') {
        contractType = 'DIGITOVER_0';
        displayDigit = 'Over 0';
      } else {
        contractType = 'DIGITUNDER_9';
        displayDigit = 'Under 9';
      }

      this.tradeInProgress = true;
      this.currentMarket = market;
      this.currentTradeType = selectedType;
      this.currentDigit = displayDigit;
      this.ui.updateTargets(market, displayDigit);

      const duration = this.simBase.getContractDuration(1);
      this.tradeTimeout = setTimeout(() => {
        this.executeTrade(market, contractType, displayDigit);
      }, duration);
    }

    getNextMarket() {
      const options = this.markets.filter((m) => m !== this.lastMarket);
      const market = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : this.markets[Math.floor(Math.random() * this.markets.length)];
      this.lastMarket = market;
      return market;
    }

    executeTrade(market, contractType, displayDigit) {
      if (!this.isRunning || this.stopRequested) return;

      const win = this.simBase.simulateTradeWithConstraints(contractType, true, this.consecutiveLosses, this.tradeHistory);
      const profit = this.simBase.calculateProfit(this.currentStake, contractType, win);
      this.balance = parseFloat((this.balance + profit).toFixed(2));

      if (win) {
        this.wins += 1;
        this.consecutiveLosses = 0;
        this.currentStake = this.config.initialStake;
        // Check if we should stop after win (win-gated stops)
        if (this.pendingStopReason) {
          this.stop(this.pendingStopReason.message, this.pendingStopReason.type);
          return;
        }
      } else {
        this.consecutiveLosses += 1;
        this.currentStake = parseFloat((this.currentStake * this.config.martingaleMultiplier).toFixed(2));
      }

      this.totalTrades += 1;
      this.totalProfit = parseFloat((this.totalProfit + profit).toFixed(2));
      this.ui.addHistoryEntry({
        win,
        profit,
        market,
        digit: displayDigit,
        stake: this.currentStake,
        timestamp: new Date()
      });

      this.ui.updateBalance(this.balance, this.accountCurrency);
      this.ui.updateStats(this.getStatsSnapshot());

      this.tradeHistory.push(win);
      if (this.tradeHistory.length > 10) this.tradeHistory.shift();
      this.tradeInProgress = false;

      // Check stop conditions (but only stop after a win)
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showTakeProfit({ profit: stats.totalProfit, trades: stats.totalTrades, time: stats.runningTime });
        }
        this.pendingStopReason = { message: 'Take profit reached. Stopping after next win...', type: 'success' };
      } else if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showStopLoss({ profit: stats.totalProfit, trades: stats.totalTrades, time: stats.runningTime });
        }
        this.pendingStopReason = { message: 'Stop loss hit. Stopping after next win...', type: 'error' };
      }

      if (this.shouldStop()) return;
      setTimeout(() => this.queueNextTrade(), this.simBase.getNextTradeDelay(1));
    }

    shouldStop() {
      if (this.pendingStopReason && this.wins > 0) {
        this.stop(this.pendingStopReason.message.replace(' after next win...', '.'), this.pendingStopReason.type);
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
        market: this.currentMarket || '-',
        digit: this.currentDigit || '-',
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

  window.SimMagicRandomBot = SimMagicRandomBot;
})();
