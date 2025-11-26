(() => {
  class MagicRandomBot {
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
      this.currentMarket = null;
      this.currentTradeType = null; // 'DIFF', 'UNDER', 'OVER'
      this.currentDigit = null;
      this.displayTarget = null;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.balance = 0;
      this.accountCurrency = 'USD';
      this.startTime = null;
      this.runningTimer = null;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
      this.digitAppearances = {}; // Track digit appearances for differ trades
      this.pendingStopReason = null; // Track if we need to stop after a win
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

      this.storedToken = token;
      this.reconnectAttempts = 0;

      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.tradeHistory = [];
      this.lastMarket = null;
      this.activeContractId = null;
      this.tradeInProgress = false;
      this.digitAppearances = {};
      this.pendingStopReason = null;

      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Authorizing with Deriv...', 'info');

      this.isRunning = true;
      this.stopRequested = false;
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
      this.tradeInProgress = false;
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
            this.accountCurrency = data.authorize.currency || 'USD';
            this.balance = Number(data.authorize.balance) || 0;
            this.ui.updateBalance(this.balance, this.accountCurrency);
            
            if (this.isReconnecting) {
              this.ui.showStatus('Reconnected. Resuming trading...', 'success');
              this.isReconnecting = false;
            } else {
              this.ui.showStatus('Connected. Starting random strategy sequence...', 'success');
            }

            this.subscribeToBalance();
            this.subscribeToContracts();
            
            // After reconnection, if trade was in progress but no active contract ID,
            // the contract subscription will receive updates for any active contracts.
            // If no contract is active, we'll reset and continue after a brief delay
            if (this.isReconnecting && this.tradeInProgress && !this.activeContractId) {
              // Wait briefly for contract subscription to receive any active contract updates
              setTimeout(() => {
                if (this.isRunning && this.tradeInProgress && !this.activeContractId && this.ws?.readyState === WebSocket.OPEN) {
                  // No active contract found, reset and continue
                  this.tradeInProgress = false;
                  this.queueNextTrade();
                }
              }, 1500);
            }
            
            if (!this.tradeInProgress) {
              this.queueNextTrade();
            }
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
        if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost during trade. Reconnecting...');
        }
        return;
      }

      // Check stop conditions (but wait for win if needed)
      // Only block if we have a pending stop AND a trade is currently in progress
      // If no trade in progress, we need to start one to get the required win
      if (this.pendingStopReason && this.tradeInProgress) {
        // Don't queue new trade, wait for current one to finish
        return;
      }

      const market = this.getNextMarket();
      const tradeType = this.getRandomTradeType();
      this.tradeInProgress = true;
      this.currentMarket = market;
      this.currentTradeType = tradeType;

      let proposal;
      if (tradeType === 'DIFF') {
        const digit = this.getNextDigit();
        this.currentDigit = digit;
        this.displayTarget = `Differ ${digit}`;
        proposal = {
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
      } else if (tradeType === 'UNDER') {
        this.currentDigit = 9;
        this.displayTarget = 'Under 9';
        proposal = {
          proposal: 1,
          amount: this.currentStake.toFixed(2),
          basis: 'stake',
          contract_type: 'DIGITUNDER',
          currency: this.accountCurrency || 'USD',
          duration: 1,
          duration_unit: 't',
          symbol: market,
          barrier: '9'
        };
      } else { // OVER
        this.currentDigit = 0;
        this.displayTarget = 'Over 0';
        proposal = {
          proposal: 1,
          amount: this.currentStake.toFixed(2),
          basis: 'stake',
          contract_type: 'DIGITOVER',
          currency: this.accountCurrency || 'USD',
          duration: 1,
          duration_unit: 't',
          symbol: market,
          barrier: '0'
        };
      }

      this.ui.updateTargets(market, this.displayTarget);
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

    getRandomTradeType() {
      const types = ['DIFF', 'UNDER', 'OVER'];
      return types[Math.floor(Math.random() * types.length)];
    }

    getNextDigit() {
      // Track digit appearances and select least appearing digit
      // Initialize all digits to 0 if not present
      for (let i = 0; i < 10; i++) {
        if (!this.digitAppearances[i]) {
          this.digitAppearances[i] = 0;
        }
      }

      // Find digits with minimum appearances
      const minAppearance = Math.min(...Object.values(this.digitAppearances));
      const leastAppearingDigits = Object.keys(this.digitAppearances)
        .filter(d => this.digitAppearances[d] === minAppearance)
        .map(Number);

      // Randomly select from least appearing digits
      const selectedDigit = leastAppearingDigits[Math.floor(Math.random() * leastAppearingDigits.length)];
      
      // Update appearance count
      this.digitAppearances[selectedDigit] = (this.digitAppearances[selectedDigit] || 0) + 1;

      return selectedDigit;
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
          digit: this.displayTarget,
          stake: this.currentStake
        });

        this.tradeInProgress = false;
        this.activeContractId = null;

        // Check if we have a pending stop and this is a win
        if (this.pendingStopReason && win) {
          this.stop(this.pendingStopReason, 'info');
          return;
        }

        // Check stop conditions
        if (this.shouldStop(win)) {
          return;
        }

        // Continue trading
        setTimeout(() => this.queueNextTrade(), 900);
      }
    }

    updateStats(tradeResult) {
      this.totalTrades += 1;
      this.tradeHistory.push({
        ...tradeResult,
        timestamp: new Date()
      });

      // Keep only last 5 trades for checking 2 losses in 5
      if (this.tradeHistory.length > 5) {
        this.tradeHistory.shift();
      }

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

    shouldStop(lastTradeWasWin) {
      // Check take profit and stop loss first (these don't require last trade to be win)
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showTakeProfit({
            profit: stats.totalProfit,
            trades: stats.totalTrades,
            time: stats.runningTime
          });
        }
        this.stop('Take profit reached. Bot stopped.', 'success');
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
        this.stop('Stop loss hit. Bot stopped.', 'error');
        return true;
      }

      // Check other stop conditions (require last trade to be win)
      let stopReason = null;

      // Check 2 consecutive losses
      if (this.consecutiveLosses >= 2) {
        stopReason = 'Two consecutive losses detected. Bot stopped.';
      }

      // Check 2 losses in last 5 trades
      if (this.tradeHistory.length >= 5) {
        const losses = this.tradeHistory.filter(t => !t.win).length;
        if (losses >= 2) {
          stopReason = 'Two losses in last 5 trades. Bot stopped.';
        }
      }

      // Check 1 hour running time
      const runningTimeSeconds = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      if (runningTimeSeconds >= 3600) {
        stopReason = 'Bot has been running for more than 1 hour. Bot stopped.';
      }

      if (stopReason) {
        if (lastTradeWasWin) {
          // Last trade was a win, stop immediately
          this.stop(stopReason, 'info');
          return true;
        } else {
          // Last trade was a loss, wait for next win
          this.pendingStopReason = stopReason;
          return false;
        }
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
        digit: this.displayTarget || '-',
        lastProfit: lastTrade ? lastTrade.profit : 0,
        runningTime: this.getRunningTime()
      };
    }

    startRunningTimer() {
      this.clearRunningTimer();
      this.runningTimer = setInterval(() => {
        if (this.isRunning) {
          this.ui.updateRunningTime(this.getRunningTime());
          // Check 1 hour condition periodically
          if (this.pendingStopReason) {
            // Already pending, will stop on next win
            return;
          }
          const runningTimeSeconds = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
          if (runningTimeSeconds >= 3600 && !this.tradeInProgress) {
            // Check if we should stop (but wait for win)
            this.shouldStop(false);
          }
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

  window.MagicRandomBot = MagicRandomBot;
})();

