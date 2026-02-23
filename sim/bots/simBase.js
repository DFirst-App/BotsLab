// Base simulation utilities for trading bots
// Provides trade simulation without WebSocket dependency

class SimBase {
  constructor() {
    // Payout percentages (gross return with no markup)
    this.PAYOUTS = {
      DIGITDIFF: 0.0619,         // ~6.19% gross return
      DIGITOVER_0: 0.95,         // 95% gross return (~90% win prob)
      DIGITUNDER_9: 0.95,        // 95% gross return (~90% win prob)
      DIGITOVER_4: 0.95,         // 95% gross return (~60% win prob)
      DIGITUNDER_5: 0.95,        // 95% gross return (~60% win prob)
      DIGITEVEN: 0.96,           // 96% gross return (~50% win prob)
      DIGITODD: 0.96,            // 96% gross return (~50% win prob)
      CALL: 0.75,                // 75% gross return (~50% win prob)
      PUT: 0.75,                 // 75% gross return (~50% win prob)
      NOTOUCH: 1.5               // 150% gross return (~20-40% win prob)
    };

    // Win probabilities
    this.WIN_PROBS = {
      DIGITDIFF: 0.90,           // ~90% win probability
      DIGITOVER_0: 0.90,         // digits 1-9 win, only 0 loses
      DIGITUNDER_9: 0.90,        // digits 0-8 win, only 9 loses
      DIGITOVER_4: 0.60,         // digits 5-9 win, digits 0-4 lose
      DIGITUNDER_5: 0.60,        // digits 0-4 win, digits 5-9 lose
      DIGITEVEN: 0.50,           // 5 even vs 5 odd
      DIGITODD: 0.50,            // 5 even vs 5 odd
      CALL: 0.50,                // ~50% probability
      PUT: 0.50,                 // ~50% probability
      NOTOUCH: 0.30              // ~20-40% probability (using 30% average)
    };
  }

  // Calculate net profit for a trade
  calculateProfit(stake, contractType, win) {
    if (!win) {
      return -stake; // Loss: lose entire stake
    }
    
    const payoutRate = this.PAYOUTS[contractType] || 0;
    return parseFloat((stake * payoutRate).toFixed(2));
  }

  // Simulate a trade outcome based on contract type (random, no constraints)
  simulateTrade(contractType) {
    const winProb = this.WIN_PROBS[contractType] || 0.5;
    return Math.random() < winProb;
  }

  // Simulate trade with constraints: max 2 consecutive losses for digit bots, max 3 losses in 10 recent trades
  simulateTradeWithConstraints(contractType, isDigitBot, consecutiveLosses, tradeHistory) {
    const last10 = tradeHistory.slice(-10);
    const lossesIn10 = last10.filter(w => !w).length;

    // Digit bots: max 2 consecutive losses
    if (isDigitBot && consecutiveLosses >= 2) {
      return true; // Force win
    }
    // All bots: max 3 losses in last 10 trades
    if (lossesIn10 >= 3) {
      return true; // Force win to avoid 4th loss in window
    }
    // Otherwise random simulation
    return this.simulateTrade(contractType);
  }

  // Realistic contract duration (ms) - matches real trade frequency per bot type
  // 1 tick digit: ~2.5-4.5 sec, 2 ticks: ~4-7 sec, 5 ticks: ~8-14 sec
  getContractDuration(ticks) {
    if (ticks === 1) {
      return 2500 + Math.random() * 2000; // 2.5-4.5 sec
    }
    if (ticks === 2) {
      return 4000 + Math.random() * 3000; // 4-7 sec
    }
    return 8000 + Math.random() * 6000; // 8-14 sec for 5 ticks
  }

  // Delay before next trade (ms) - proposal/processing time
  getNextTradeDelay(ticks) {
    if (ticks === 1) return 800 + Math.random() * 500;   // 0.8-1.3 sec for digit
    if (ticks === 2) return 1000 + Math.random() * 700;  // 1-1.7 sec
    return 1500 + Math.random() * 1000;                 // 1.5-2.5 sec for 5-tick
  }

  // Generate random digit (0-9)
  randomDigit() {
    return Math.floor(Math.random() * 10);
  }

  // Select random market from volatility markets
  randomMarket(markets, exclude = null) {
    const options = markets.filter(m => m !== exclude);
    if (options.length === 0) return markets[Math.floor(Math.random() * markets.length)];
    return options[Math.floor(Math.random() * options.length)];
  }

  // Format time as HH:MM:SS
  formatRunningTime(startTime) {
    if (!startTime) return '00:00:00';
    const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
}

// Export for use in simulated bots
if (typeof window !== 'undefined') {
  window.SimBase = SimBase;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = SimBase;
}
