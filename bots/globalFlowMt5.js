(() => {
  const MT5_SYMBOLS = [
    { symbol: 'Volatility 10 Index', short: 'V10', category: 'synthetic', tickValue: 1, contractSize: 1, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 25, referencePrice: 2500, priceDp: 2 },
    { symbol: 'Volatility 25 Index', short: 'V25', category: 'synthetic', tickValue: 1, contractSize: 1, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 30, referencePrice: 3500, priceDp: 2 },
    { symbol: 'Volatility 50 Index', short: 'V50', category: 'synthetic', tickValue: 1, contractSize: 1, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 45, referencePrice: 7500, priceDp: 2 },
    { symbol: 'Volatility 75 Index', short: 'V75', category: 'synthetic', tickValue: 1, contractSize: 1, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 70, referencePrice: 12500, priceDp: 2 },
    { symbol: 'Volatility 100 Index', short: 'V100', category: 'synthetic', tickValue: 1, contractSize: 1, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 95, referencePrice: 16500, priceDp: 2 },
    { symbol: 'Boom 500 Index', short: 'BOOM500', category: 'boomCrash', tickValue: 1, contractSize: 1, minVolume: 0.2, volumeStep: 0.1, typicalAtr: 80, referencePrice: 10000, priceDp: 1 },
    { symbol: 'Crash 500 Index', short: 'CRASH500', category: 'boomCrash', tickValue: 1, contractSize: 1, minVolume: 0.2, volumeStep: 0.1, typicalAtr: 80, referencePrice: 10000, priceDp: 1 },
    { symbol: 'Step Index', short: 'STEP', category: 'synthetic', tickValue: 1, contractSize: 1, minVolume: 0.1, volumeStep: 0.1, typicalAtr: 4, referencePrice: 10000, priceDp: 1 },
    { symbol: 'EURUSD', short: 'EURUSD', category: 'forex', tickValue: 10, contractSize: 100000, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 0.0011, referencePrice: 1.0850, priceDp: 5 },
    { symbol: 'GBPUSD', short: 'GBPUSD', category: 'forex', tickValue: 10, contractSize: 100000, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 0.0015, referencePrice: 1.2650, priceDp: 5 },
    { symbol: 'XAUUSD', short: 'XAUUSD', category: 'metals', tickValue: 100, contractSize: 100, minVolume: 0.01, volumeStep: 0.01, typicalAtr: 3.5, referencePrice: 2300, priceDp: 2 },
    { symbol: 'US500', short: 'US500', category: 'indices', tickValue: 50, contractSize: 50, minVolume: 0.1, volumeStep: 0.1, typicalAtr: 5.5, referencePrice: 4500, priceDp: 1 }
  ];

  const DEFAULT_CATEGORIES = ['synthetic', 'boomCrash', 'forex', 'metals', 'indices'];

  class GlobalFlowMt5Bot {
    constructor(ui, options) {
      this.ui = ui;
      this.options = options || {};
      this.symbols = MT5_SYMBOLS;
      this.wsUrl = this.options.wsUrl;
      this.resolveAuthToken = this.options.resolveAuthToken;
      this.isRunning = false;
      this.stopRequested = false;
      this.currentConfig = null;
      this.ws = null;
      this.mt5Login = null;
      this.balance = 0;
      this.completedTrades = 0;
      this.cycleProfit = 0;
      this.openRiskPct = 0;
      this.runningStart = null;
      this.runningTimer = null;
      this.tradeInterval = null;
      this.pendingPlans = [];
      this.categoriesAllowed = DEFAULT_CATEGORIES.slice();
    }

    start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Global Flow MT5 is already running.', 'warning');
        return;
      }

      const token = this.resolveAuthToken?.();
      if (!token) {
        this.ui.showStatus('Connect your Deriv account before starting the MT5 bot.', 'error');
        return;
      }

      this.currentConfig = {
        riskPercent: config.riskPercent || 1,
        takeProfit: config.takeProfit || 1000,
        stopLoss: config.stopLoss || 10000,
        maxSymbols: Math.min(Math.max(config.maxSymbols || 3, 1), 6),
        categories: config.categories?.length ? config.categories : DEFAULT_CATEGORIES,
        allowHedging: !!config.allowHedging
      };
      this.categoriesAllowed = this.currentConfig.categories;
      this.stopRequested = false;
      this.ui.setRunningState(true);
      this.ui.showStatus('Authorizing MT5 session...', 'running');

      this.connectWebSocket(token);
    }

    stop(message = 'Bot stopped', statusType = 'warning') {
      this.stopRequested = true;
      this.isRunning = false;
      this.clearTimers();
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.pendingPlans = [];
      this.ui.setRunningState(false);
      this.ui.showStatus(message, statusType);
    }

    connectWebSocket(token) {
      if (this.ws) {
        this.ws.close();
      }
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ authorize: token }));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('Failed to parse MT5 bot message', error);
        }
      };

      this.ws.onerror = () => {
        this.ui.showStatus('WebSocket error. Retrying...', 'error');
      };

      this.ws.onclose = () => {
        if (!this.stopRequested) {
          this.ui.showStatus('Connection lost. Attempting to reconnect...', 'error');
          setTimeout(() => this.connectWebSocket(this.resolveAuthToken?.()), 2000);
        }
      };
    }

    handleMessage(data) {
      if (data.error) {
        this.ui.showStatus(data.error.message || 'MT5 error occurred.', 'error');
        return;
      }

      switch (data.msg_type) {
        case 'authorize':
          this.balance = Number(data.authorize.balance) || 0;
          this.ui.updateBalance(this.balance, data.authorize.currency || 'USD');
          this.requestBalanceStream();
          this.requestMt5Accounts();
          break;
        case 'balance':
          if (typeof data.balance?.balance !== 'undefined') {
            this.balance = Number(data.balance.balance);
            this.ui.updateBalance(this.balance, data.balance.currency || 'USD');
          }
          break;
        case 'mt5_login_list':
          this.handleMt5LoginList(data.mt5_login_list);
          break;
        default:
          break;
      }
    }

    requestBalanceStream() {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    }

    requestMt5Accounts() {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ mt5_login_list: 1 }));
    }

    handleMt5LoginList(accounts) {
      if (!accounts || !accounts.length) {
        this.ui.showStatus('No MT5 accounts found. Create one in Deriv before running this bot.', 'error');
        this.stopRequested = true;
        this.ui.setRunningState(false);
        return;
      }

      const primary = accounts.find((acc) => acc.account_type === 'real') || accounts[0];
      this.mt5Login = primary;

      const parts = [];
      if (primary.account_type) {
        parts.push(primary.account_type === 'demo' ? 'Standard Demo' : 'Real');
      }
      if (primary.market_type) {
        parts.push(primary.market_type === 'financial' ? 'Financial' : primary.market_type);
      }
      if (primary.landing_company_short) {
        parts.push(primary.landing_company_short.toUpperCase());
      }
      const label = parts.join(' · ') || primary.login;

      this.ui.updateAccountHint?.(`MT5 account: ${label} (${primary.login})`);
      this.ui.showStatus(`Connected to MT5 login ${primary.login}`, 'running');
      this.beginTradingLoop();
    }

    beginTradingLoop() {
      if (this.isRunning) return;
      this.isRunning = true;
      this.runningStart = new Date();
      this.updateRunningTimer();
      this.tradeInterval = setInterval(() => this.runCycle(), 20000);
      this.runCycle();
    }

    runCycle() {
      if (!this.isRunning || !this.mt5Login) return;

      const riskBudgetUsd = this.calculateRiskBudget();
      if (riskBudgetUsd <= 0) {
        this.ui.showStatus('Risk budget is zero. Adjust your risk per cycle.', 'warning');
        return;
      }

      const selectedSymbols = this.selectSymbols(this.currentConfig.maxSymbols);
      if (!selectedSymbols.length) {
        this.ui.showStatus('No symbols match the selected buckets. Enable at least one category.', 'warning');
        return;
      }

      const perSymbolRisk = riskBudgetUsd / selectedSymbols.length;
      this.openRiskPct = (perSymbolRisk * selectedSymbols.length) / (this.balance || 1) * 100;

      selectedSymbols.forEach((symbolMeta) => {
        const plan = this.buildTradePlan(symbolMeta, perSymbolRisk);
        if (plan) {
          this.executePlan(plan);
        }
      });

      this.ui.updateStats({
        cycleProfit: this.cycleProfit,
        openRiskPct: this.openRiskPct,
        activeSymbols: selectedSymbols.length,
        completedTrades: this.completedTrades,
        runningTime: this.getRunningTime()
      });
    }

    calculateRiskBudget() {
      const riskPct = Math.max(this.currentConfig.riskPercent || 1, 0.1);
      return ((this.balance || 0) * riskPct) / 100;
    }

    selectSymbols(maxSymbols) {
      const allowed = this.symbols.filter((meta) => this.categoriesAllowed.includes(meta.category));
      if (!allowed.length) return [];

      const selected = [];
      const pool = [...allowed];
      while (selected.length < maxSymbols && pool.length) {
        const index = Math.floor(Math.random() * pool.length);
        selected.push(pool.splice(index, 1)[0]);
      }
      return selected;
    }

    buildTradePlan(symbolMeta, riskUsd) {
      const atr = symbolMeta.typicalAtr || 1;
      const stopDistance = atr * 1.5;
      const tickValuePerLot = (symbolMeta.tickValue || 1) * (symbolMeta.contractSize || 1);
      const stopValuePerLot = stopDistance * tickValuePerLot;
      if (stopValuePerLot <= 0) return null;

      let rawVolume = riskUsd / stopValuePerLot;
      const minVol = symbolMeta.minVolume || 0.01;
      const step = symbolMeta.volumeStep || 0.01;
      rawVolume = Math.max(minVol, Math.floor(rawVolume / step) * step);

      const direction = Math.random() > 0.5 ? 'buy' : 'sell';
      const entry = symbolMeta.referencePrice || 1000;
      const priceDp = symbolMeta.priceDp ?? 2;
      const stopLoss = direction === 'buy' ? entry - stopDistance : entry + stopDistance;
      const takeProfit = direction === 'buy' ? entry + (stopDistance * 2) : entry - (stopDistance * 2);

      return {
        symbol: symbolMeta.symbol,
        short: symbolMeta.short,
        category: symbolMeta.category,
        direction,
        entryPrice: entry,
        stopLoss,
        takeProfit,
        stopDistance,
        volume: rawVolume,
        riskUsd,
        riskPct: ((riskUsd / (this.balance || 1)) * 100),
        priceDp
      };
    }

    executePlan(plan) {
      // NOTE: Deriv's public WebSocket API does not support placing MT5 trades directly.
      // This step generates risk-based trade plans and logs them as signals only.
      this.ui.addHistoryEntry({
        symbol: plan.symbol,
        direction: plan.direction,
        volume: plan.volume,
        entryPrice: plan.entryPrice,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
        profit: 0,
        riskPct: plan.riskPct,
        priceDp: plan.priceDp,
        timestamp: new Date(),
        result: 'signal'
      });

      this.completedTrades += 1;
      this.ui.updateStats({
        cycleProfit: this.cycleProfit,
        openRiskPct: this.openRiskPct,
        activeSymbols: this.currentConfig.maxSymbols,
        completedTrades: this.completedTrades,
        runningTime: this.getRunningTime()
      });

      this.ui.showStatus(`Signal generated for ${plan.symbol} (${plan.direction.toUpperCase()}) — execute via MT5 EA.`, 'running');
    }

    clearTimers() {
      if (this.tradeInterval) {
        clearInterval(this.tradeInterval);
        this.tradeInterval = null;
      }
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
      }
    }

    updateRunningTimer() {
      if (this.runningTimer) clearInterval(this.runningTimer);
      this.runningTimer = setInterval(() => {
        if (this.isRunning) {
          this.ui.updateStats({
            runningTime: this.getRunningTime()
          });
        }
      }, 1000);
    }

    getRunningTime() {
      if (!this.runningStart) return '00:00:00';
      const diff = Math.floor((Date.now() - this.runningStart.getTime()) / 1000);
      const hours = Math.floor(diff / 3600).toString().padStart(2, '0');
      const minutes = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
      const seconds = (diff % 60).toString().padStart(2, '0');
      return `${hours}:${minutes}:${seconds}`;
    }
  }

  window.GlobalFlowMt5Bot = GlobalFlowMt5Bot;
})();

