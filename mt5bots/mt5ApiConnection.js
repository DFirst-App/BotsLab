(() => {
  'use strict';

  class MT5ApiConnection {
    constructor(options) {
      this.wsUrl = options.wsUrl;
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;
      this.onMarketDataUpdate = options.onMarketDataUpdate || (() => {});
      this.onConnectionStatus = options.onConnectionStatus || (() => {});
      this.onAccountInfo = options.onAccountInfo || (() => {});
      
      this.ws = null;
      this.isConnected = false;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.marketData = new Map(); // symbol -> {bid, ask, spread, change, changePercent}
      this.subscribedSymbols = new Set();
      this.accountInfo = null;
      this.mt5AccountInfo = null;
      this.pendingRequests = new Map();
      this.heartbeatInterval = null;
      this.lastHeartbeat = null;
    }

    connect() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const token = this.resolveAuthToken();
      if (!token) {
        this.onConnectionStatus('error', 'No authentication token available');
        return;
      }

      this.ws = new this.WebSocketImpl(this.wsUrl);
      this.setupWebSocketHandlers(token);
    }

    setupWebSocketHandlers(token) {
      this.ws.onopen = () => {
        console.log('[MT5 API] WebSocket connected');
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
        
        // Authorize
        this.ws.send(JSON.stringify({ authorize: token }));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('[MT5 API] Error parsing message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[MT5 API] WebSocket error:', error);
        if (!this.isReconnecting) {
          this.attemptReconnect('WebSocket error occurred');
        }
      };

      this.ws.onclose = () => {
        console.log('[MT5 API] WebSocket closed');
        this.isConnected = false;
        this.clearHeartbeat();
        
        if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost');
        }
      };
    }

    handleMessage(data) {
      if (data.error) {
        const errorCode = data.error?.code;
        const message = data.error.message || 'Deriv API error';
        
        if (errorCode === 'InvalidToken' || errorCode === 'AuthorizationRequired') {
          this.onConnectionStatus('error', 'Authorization expired. Please reconnect.');
          return;
        }
        
        console.error('[MT5 API] Error:', data.error);
        this.onConnectionStatus('warning', message);
        return;
      }

      switch (data.msg_type) {
        case 'authorize':
          this.handleAuthorize(data.authorize);
          break;
        case 'active_symbols':
          this.handleActiveSymbols(data.active_symbols);
          break;
        case 'tick':
          this.handleTick(data.tick);
          break;
        case 'mt5_login_list':
          this.handleMT5Accounts(data.mt5_login_list);
          break;
        case 'pong':
          this.lastHeartbeat = Date.now();
          break;
        default:
          // Handle pending requests
          if (data.req_id && this.pendingRequests.has(data.req_id)) {
            const resolver = this.pendingRequests.get(data.req_id);
            this.pendingRequests.delete(data.req_id);
            resolver(data);
          }
          break;
      }
    }

    handleAuthorize(authData) {
      if (!authData) {
        console.error('[MT5 API] Authorize response missing data');
        return;
      }

      this.accountInfo = {
        account_id: authData.loginid,
        balance: Number(authData.balance) || 0,
        currency: authData.currency || 'USD',
        fullName: authData.fullname || '-',
        is_virtual: authData.is_virtual === 1 || authData.is_virtual === true
      };

      this.isConnected = true;
      this.onConnectionStatus('connected', 'Connected to Deriv API');
      this.startHeartbeat();

      // Get MT5 accounts first
      this.getMT5Accounts().then(() => {
        // Then get active symbols
        this.getActiveSymbols().then(symbols => {
          if (symbols && symbols.length > 0) {
            this.handleActiveSymbols(symbols);
          }
        });
      });
    }

    async getMT5Accounts() {
      return new Promise((resolve) => {
        const reqId = Date.now();
        let resolved = false;
        
        const resolver = (data) => {
          if (resolved) return;
          resolved = true;
          resolve(data);
        };
        
        this.pendingRequests.set(reqId, resolver);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            mt5_login_list: 1,
            req_id: reqId
          }));
        }

        // Timeout after 5 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.pendingRequests.delete(reqId);
            resolve({ mt5_login_list: [] });
          }
        }, 5000);
      });
    }

    handleMT5Accounts(accounts) {
      if (!accounts || !Array.isArray(accounts)) {
        this.mt5AccountInfo = null;
        this.onAccountInfo(null);
        return;
      }

      // Find real (non-demo) MT5 accounts
      const realAccounts = accounts.filter(acc => {
        // Check if account is real (not demo/virtual)
        const isReal = !acc.is_virtual && acc.account_type !== 'demo';
        return isReal;
      });

      if (realAccounts.length === 0) {
        this.mt5AccountInfo = null;
        this.onAccountInfo(null);
        return;
      }

      // Use the first real account
      const account = realAccounts[0];
      this.mt5AccountInfo = {
        login: account.login,
        server: account.server,
        account_type: this.getMT5AccountType(account.server, account.account_type),
        balance: Number(account.balance) || 0,
        currency: account.currency || 'USD',
        leverage: account.leverage || 0
      };

      this.onAccountInfo({
        ...this.accountInfo,
        mt5: this.mt5AccountInfo
      });
    }

    getMT5AccountType(server, accountType) {
      if (!server) return 'MT5 Standard';
      const serverLower = server.toLowerCase();
      const accountTypeLower = (accountType || '').toLowerCase();
      
      if (serverLower.includes('gold') || accountTypeLower.includes('gold')) return 'MT5 Gold';
      if (serverLower.includes('financial') || accountTypeLower.includes('financial') || serverLower.includes('real')) return 'MT5 Financial';
      if (serverLower.includes('swap') || accountTypeLower.includes('swap')) return 'MT5 Swap-Free';
      if (serverLower.includes('zero') || accountTypeLower.includes('zero')) return 'MT5 Zero Spread';
      return 'MT5 Standard';
    }

    async getActiveSymbols() {
      return new Promise((resolve) => {
        const reqId = Date.now();
        let resolved = false;
        
        const resolver = (data) => {
          if (resolved) return;
          resolved = true;
          if (data.active_symbols) {
            resolve(data.active_symbols);
          } else {
            resolve([]);
          }
        };
        
        this.pendingRequests.set(reqId, resolver);

        // Try without landing_company first (gets all symbols)
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            active_symbols: 1,
            req_id: reqId
          }));
        }

        // Timeout after 5 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.pendingRequests.delete(reqId);
            resolve([]);
          }
        }, 5000);
      });
    }

    handleActiveSymbols(symbols) {
      if (!symbols || !Array.isArray(symbols)) {
        console.warn('[MT5 API] No active symbols received');
        return;
      }

      // Common MT5 symbols to track (forex majors, commodities, indices)
      const commonMT5Symbols = [
        'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
        'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF', 'AUDCAD',
        'XAUUSD', 'XAGUSD', 'XPDUSD', 'XPTUSD',
        'US_OTC', 'US_500', 'US_100', 'US_30',
        'UK_100', 'GER_30', 'FRA_40', 'JPN_225',
        'BTCUSD', 'ETHUSD', 'LTCUSD', 'BCHUSD'
      ];

      // Filter symbols that are available and match MT5 symbols
      const availableSymbols = symbols
        .filter(symbol => {
          const sym = symbol.symbol || '';
          // Check if it's in our common list or matches MT5 patterns
          return commonMT5Symbols.includes(sym) || 
                 sym.includes('_') || // Synthetic indices
                 sym.length <= 6; // Forex pairs are typically 6 chars
        })
        .map(symbol => symbol.symbol)
        .filter(symbol => symbol);

      // Remove duplicates
      const uniqueSymbols = [...new Set(availableSymbols)];

      // Subscribe to ticks for all MT5 symbols
      uniqueSymbols.forEach(symbol => {
        this.subscribeToSymbol(symbol);
      });

      console.log(`[MT5 API] Subscribed to ${uniqueSymbols.length} MT5 symbols`);
    }

    subscribeToSymbol(symbol) {
      if (this.subscribedSymbols.has(symbol)) {
        return; // Already subscribed
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          ticks: symbol,
          subscribe: 1
        }));
        this.subscribedSymbols.add(symbol);
      }
    }

    handleTick(tick) {
      if (!tick || !tick.symbol) return;

      const symbol = tick.symbol;
      const bid = parseFloat(tick.bid) || 0;
      const ask = parseFloat(tick.ask) || 0;
      const quote = parseFloat(tick.quote) || bid || ask;
      const spread = ask - bid;
      const spreadPercent = bid > 0 ? (spread / bid) * 100 : 0;

      // Calculate change from previous price
      const previous = this.marketData.get(symbol);
      let change = 0;
      let changePercent = 0;
      
      if (previous) {
        const prevPrice = previous.bid || previous.ask || previous.price || 0;
        change = quote - prevPrice;
        changePercent = prevPrice > 0 ? (change / prevPrice) * 100 : 0;
      }

      const marketData = {
        symbol: symbol,
        bid: bid,
        ask: ask,
        price: quote,
        spread: spread,
        spreadPercent: spreadPercent,
        change: change,
        changePercent: changePercent,
        timestamp: Date.now()
      };

      this.marketData.set(symbol, marketData);
      this.onMarketDataUpdate(marketData);
    }

    startHeartbeat() {
      this.clearHeartbeat();
      this.lastHeartbeat = Date.now();
      
      this.heartbeatInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ ping: 1 }));
          
          // Check if heartbeat is too old (connection might be dead)
          if (this.lastHeartbeat && Date.now() - this.lastHeartbeat > 30000) {
            console.warn('[MT5 API] Heartbeat timeout, reconnecting...');
            this.attemptReconnect('Heartbeat timeout');
          }
        }
      }, 10000); // Send ping every 10 seconds
    }

    clearHeartbeat() {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }

    attemptReconnect(reason) {
      if (this.isReconnecting || this.reconnectAttempts >= 10) {
        if (this.reconnectAttempts >= 10) {
          this.onConnectionStatus('error', 'Max reconnection attempts reached');
        }
        return;
      }

      this.isReconnecting = true;
      this.reconnectAttempts += 1;
      this.clearHeartbeat();

      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      this.onConnectionStatus('reconnecting', `Reconnecting... (Attempt ${this.reconnectAttempts}/10)`);

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
          console.error('[MT5 API] Error closing WebSocket:', e);
        }
        this.ws = null;
      }

      this.reconnectTimeout = setTimeout(() => {
        if (!this.isReconnecting) return;
        this.connect();
      }, delay);
    }

    disconnect() {
      this.isReconnecting = false;
      this.clearHeartbeat();
      
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
          console.error('[MT5 API] Error closing WebSocket:', e);
        }
        this.ws = null;
      }

      this.isConnected = false;
      this.subscribedSymbols.clear();
      this.marketData.clear();
      this.onConnectionStatus('disconnected', 'Disconnected');
    }

    getMarketData(symbol) {
      return this.marketData.get(symbol) || null;
    }

    getAllMarketData() {
      return Array.from(this.marketData.values());
    }
  }

  // Export for use in other files
  if (typeof window !== 'undefined') {
    window.MT5ApiConnection = MT5ApiConnection;
  }
})();

