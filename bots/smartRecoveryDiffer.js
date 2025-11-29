(() => {
  class SmartRecoveryDifferBot {
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
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
      
      // Recovery mode state
      this.recoveryMode = false;
      this.recoveryMarket = null;
      this.recoveryTradeType = null; // 'OVER' or 'UNDER'
      this.marketAnalysis = {}; // Store digit history per market for analysis
      this.tickSubscriptions = {}; // Track tick subscriptions per market
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
      this.lastDigit = null;
      this.activeContractId = null;
      this.tradeInProgress = false;
      this.recoveryMode = false;
      this.recoveryMarket = null;
      this.recoveryTradeType = null;
      this.marketAnalysis = {};
      this.tickSubscriptions = {};

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
          this.ws.close();
        } catch (e) {
          console.error('Error closing WebSocket during reconnect:', e);
        }
      }

      this.reconnectTimeout = setTimeout(() => {
        if (!this.stopRequested) {
          this.connectWebSocket();
        }
      }, delay);
    }

    finishStop() {
      this.isRunning = false;
      this.tradeInProgress = false;
      this.activeContractId = null;
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
      }
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.ui.setRunningState(false);
      if (this.stopMessage) {
        this.ui.showStatus(this.stopMessage.message, this.stopMessage.type);
      }
    }

    startRunningTimer() {
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
      }
      this.runningTimer = setInterval(() => {
        if (this.isRunning && this.startTime) {
          const elapsed = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
          const hours = Math.floor(elapsed / 3600);
          const minutes = Math.floor((elapsed % 3600) / 60);
          const seconds = elapsed % 60;
          const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
          this.ui.updateRunningTime(timeString);
        }
      }, 1000);
    }

    handleMessage(raw) {
      if (!this.isRunning && !this.isReconnecting) return;

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
              this.ui.showStatus('Connected. Starting smart recovery differ strategy...', 'success');
            }

            this.subscribeToBalance();
            this.subscribeToContracts();
            
            // Subscribe to ticks for all markets for analysis
            this.subscribeToAllMarketTicks();
            
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
          case 'tick':
            // Store digit from tick for market analysis
            if (data.tick && data.tick.symbol && data.tick.quote) {
              const market = data.tick.symbol;
              const tickValue = data.tick.quote.toString();
              const digit = parseInt(tickValue.slice(-1));
              
              if (!this.marketAnalysis[market]) {
                this.marketAnalysis[market] = {
                  digits: [],
                  over4Count: 0,
                  under5Count: 0,
                  totalTicks: 0
                };
              }
              
              const analysis = this.marketAnalysis[market];
              analysis.digits.push(digit);
              analysis.totalTicks++;
              
              // Keep only last 50 digits for analysis
              if (analysis.digits.length > 50) {
                analysis.digits.shift();
              }
              
              // Count over 4 and under 5 occurrences
              if (digit > 4) analysis.over4Count++;
              if (digit < 5) analysis.under5Count++;
            }
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

    subscribeToAllMarketTicks() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      
      // Subscribe to ticks for all markets to analyze them
      this.markets.forEach(market => {
        if (!this.tickSubscriptions[market]) {
          this.ws.send(JSON.stringify({
            ticks: market,
            subscribe: 1
          }));
          this.tickSubscriptions[market] = true;
        }
      });
    }

    analyzeMarketsForRecovery() {
      // Analyze all markets to find the best one for digit over 4 or under 5
      let bestMarket = null;
      let bestTradeType = null;
      let bestScore = 0;

      this.markets.forEach(market => {
        const analysis = this.marketAnalysis[market];
        if (!analysis || analysis.totalTicks < 10) {
          return; // Need at least 10 ticks for analysis
        }

        // Calculate probability scores
        const over4Probability = analysis.over4Count / analysis.totalTicks;
        const under5Probability = analysis.under5Count / analysis.totalTicks;

        // Score based on probability (higher is better)
        // Prefer markets with strong bias (>60% probability)
        if (over4Probability > 0.6 && over4Probability > bestScore) {
          bestScore = over4Probability;
          bestMarket = market;
          bestTradeType = 'OVER';
        }
        
        if (under5Probability > 0.6 && under5Probability > bestScore) {
          bestScore = under5Probability;
          bestMarket = market;
          bestTradeType = 'UNDER';
        }
      });

      // If no strong bias found, use recent digit patterns
      if (!bestMarket) {
        this.markets.forEach(market => {
          const analysis = this.marketAnalysis[market];
          if (!analysis || analysis.digits.length < 10) return;

          // Check last 10 digits
          const recentDigits = analysis.digits.slice(-10);
          const over4Recent = recentDigits.filter(d => d > 4).length;
          const under5Recent = recentDigits.filter(d => d < 5).length;

          const over4Score = over4Recent / 10;
          const under5Score = under5Recent / 10;

          if (over4Score > 0.6 && over4Score > bestScore) {
            bestScore = over4Score;
            bestMarket = market;
            bestTradeType = 'OVER';
          }

          if (under5Score > 0.6 && under5Score > bestScore) {
            bestScore = under5Score;
            bestMarket = market;
            bestTradeType = 'UNDER';
          }
        });
      }

      // Fallback: if still no good market, pick one with most data
      if (!bestMarket) {
        let maxTicks = 0;
        this.markets.forEach(market => {
          const analysis = this.marketAnalysis[market];
          if (analysis && analysis.totalTicks > maxTicks) {
            maxTicks = analysis.totalTicks;
            bestMarket = market;
            // Default to OVER if we have to pick
            bestTradeType = 'OVER';
          }
        });
      }

      // Final fallback: random market
      if (!bestMarket) {
        bestMarket = this.markets[Math.floor(Math.random() * this.markets.length)];
        bestTradeType = 'OVER';
      }

      return { market: bestMarket, tradeType: bestTradeType };
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

      let market, digit, contractType, barrier, displayTarget;

      if (this.recoveryMode) {
        // Recovery mode: use analyzed market for digit over 4 or under 5
        if (!this.recoveryMarket || !this.recoveryTradeType) {
          const recovery = this.analyzeMarketsForRecovery();
          this.recoveryMarket = recovery.market;
          this.recoveryTradeType = recovery.tradeType;
        }

        market = this.recoveryMarket;
        
        if (this.recoveryTradeType === 'OVER') {
          contractType = 'DIGITOVER';
          barrier = '4';
          digit = 4;
          displayTarget = 'Over 4';
        } else {
          contractType = 'DIGITUNDER';
          barrier = '5';
          digit = 5;
          displayTarget = 'Under 5';
        }
      } else {
        // Normal mode: digit differ on random number, one market
        market = this.getNextMarket();
        digit = this.getNextDigit();
        contractType = 'DIGITDIFF';
        barrier = digit.toString();
        displayTarget = `Differ ${digit}`;
      }

      this.tradeInProgress = true;
      this.currentMarket = market;
      this.currentDigit = digit;
      this.ui.updateTargets(market, displayTarget);

      const proposal = {
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: contractType,
        currency: this.accountCurrency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: market,
        barrier: barrier
      };

      this.ws.send(JSON.stringify(proposal));
    }

    getNextMarket() {
      // In normal mode, use one market consistently until loss
      if (!this.lastMarket) {
        this.lastMarket = this.markets[Math.floor(Math.random() * this.markets.length)];
      }
      return this.lastMarket;
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
        const isWin = contract.profit > 0;
        const profit = parseFloat(contract.profit) || 0;
        const stake = parseFloat(contract.sell_price || contract.buy_price || this.currentStake) || this.currentStake;

        this.totalProfit = parseFloat((this.totalProfit + profit).toFixed(2));
        this.totalTrades += 1;
        this.tradeInProgress = false;
        this.activeContractId = null;

        if (isWin) {
          this.wins += 1;
          this.consecutiveLosses = 0;
          this.currentStake = this.config.initialStake;
          
          // Exit recovery mode on win
          if (this.recoveryMode) {
            this.recoveryMode = false;
            this.recoveryMarket = null;
            this.recoveryTradeType = null;
            this.ui.showStatus('Recovery successful! Returning to normal mode...', 'success');
          }
        } else {
          this.consecutiveLosses += 1;
          
          // Apply martingale
          this.currentStake = parseFloat((this.currentStake * (this.config.martingaleMultiplier || 3.1)).toFixed(2));
          
          // Enter recovery mode on loss
          if (!this.recoveryMode) {
            this.recoveryMode = true;
            this.ui.showStatus('Loss detected. Analyzing markets for recovery...', 'warning');
            
            // Analyze markets to find best recovery option
            const recovery = this.analyzeMarketsForRecovery();
            this.recoveryMarket = recovery.market;
            this.recoveryTradeType = recovery.tradeType;
          }
        }

        this.ui.addHistoryEntry({
          win: isWin,
          profit: profit,
          stake: stake,
          market: this.currentMarket,
          digit: this.currentDigit,
          timestamp: new Date()
        });

        this.ui.updateStats(this.getStatsSnapshot());

        // Check stop conditions
        if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
          this.stop(`Take profit reached: $${this.totalProfit.toFixed(2)}`, 'success');
          return;
        }

        if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
          this.stop(`Stop loss reached: $${Math.abs(this.totalProfit).toFixed(2)}`, 'error');
          return;
        }

        // Continue trading
        if (this.isRunning && !this.stopRequested) {
          setTimeout(() => {
            if (this.isRunning && !this.tradeInProgress) {
              this.queueNextTrade();
            }
          }, 900);
        }
      }
    }

    getStatsSnapshot() {
      const winRate = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(2) : '0.00';
      return {
        balance: this.balance,
        currency: this.accountCurrency,
        totalProfit: this.totalProfit,
        totalTrades: this.totalTrades,
        winRate: winRate,
        currentStake: this.currentStake,
        consecutiveLosses: this.consecutiveLosses,
        market: this.currentMarket || '-',
        digit: typeof this.currentDigit === 'number' ? this.currentDigit : '-',
        runningTime: this.getRunningTime()
      };
    }

    getRunningTime() {
      if (!this.startTime) return '00:00:00';
      const elapsed = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      const hours = Math.floor(elapsed / 3600);
      const minutes = Math.floor((elapsed % 3600) / 60);
      const seconds = elapsed % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
  }

  window.SmartRecoveryDifferBot = SmartRecoveryDifferBot;
})();

