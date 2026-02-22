// Base simulation utilities for trading bots
// Provides trade simulation without WebSocket dependency

class SimBase {
  constructor() {
    // Payout percentages (net return after 3% markup)
    this.PAYOUTS = {
      DIGITDIFF: 0.06,           // 6% net return
      DIGITOVER_0: 0.9215,       // 92.15% net return (~90% win prob)
      DIGITUNDER_9: 0.9215,      // 92.15% net return (~90% win prob)
      DIGITOVER_4: 0.9215,       // 92.15% net return (~60% win prob)
      DIGITUNDER_5: 0.9215,      // 92.15% net return (~60% win prob)
      DIGITEVEN: 0.9312,         // 93.12% net return (~50% win prob)
      DIGITODD: 0.9312,          // 93.12% net return (~50% win prob)
      CALL: 0.7275,              // 72.75% net return (~50% win prob)
      PUT: 0.7275,               // 72.75% net return (~50% win prob)
      NOTOUCH: 1.455             // 145.5% net return (~20-40% win prob)
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

  // Simulate a trade outcome based on contract type
  simulateTrade(contractType) {
    const winProb = this.WIN_PROBS[contractType] || 0.5;
    return Math.random() < winProb;
  }

  // Simulate contract duration (in milliseconds)
  // 1 tick ≈ 1-2 seconds, 5 ticks ≈ 5-10 seconds
  getContractDuration(ticks) {
    const baseDelay = ticks === 1 ? 1000 : ticks === 2 ? 2000 : ticks * 1000;
    const variance = baseDelay * 0.3; // ±30% variance
    return baseDelay + (Math.random() * variance * 2 - variance);
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
