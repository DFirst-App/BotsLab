# All Bots: Settings, Ratings, Configuration & How Each Works

This document lists every Deriv bot’s **UI settings**, **ratings**, **configuration** (including defaults and martingale), and a **step-by-step explanation** of how each bot works.

---

## 1. Shared Configuration (All Bots)

These inputs are **global** on the Trading Bots page and apply to every bot when you open its panel:

| Setting | Default | Min | Description |
|--------|---------|-----|-------------|
| **Initial Stake (USD)** | 1 | 0.35 | Stake per trade (reset to this after a win where martingale is used). |
| **Take Profit (USD)** | 100 | 5 | Bot stops when total profit ≥ this. |
| **Stop Loss (USD)** | 1000 | 50 | Bot stops when total loss ≥ this. |
| **Martingale Multiplier** | Varies by bot | 1 | After a loss, next stake = current stake × this (only if bot supports martingale). |

**Validation:** Stake ≥ 0.35, Take Profit > 0, Stop Loss > 0, Martingale ≥ 1 when enabled.

---

## 2. Bot List: Ratings, Strategy, Recovery & Config

From **trading-bots.html** (bot cards + `BOT_DEFINITIONS`):

| # | Bot Name | Rating | Strategy (UI) | Recovery (UI) | Default Martingale | Martingale in UI? |
|---|----------|--------|----------------|---------------|--------------------|--------------------|
| 1 | All Markets Differ | 4.9/5 | Random Markets & Digits | Smart Recovery | 16 | Yes |
| 2 | Random Markets Over 0 | 4.7/5 | Random Markets · Over 0 | Smart Recovery | 16 | Yes |
| 3 | Smart Recovery Differ | 5.0/5 | Smart Recovery · Market Analysis | Intelligent Market Analysis | 3.1 | Yes |
| 4 | Random Markets Under 9 | 4.8/5 | Random Markets · Under 9 | Smart Recovery | 16 | Yes |
| 5 | Smart Differ Pro | 4.9/5 | Multi-Market Digit Differ | Smart Recovery | 16 | Yes |
| 6 | Magic Random Strategy | 4.9/5 | Random Differ/Under/Over · Multi-Market | Smart Recovery with Win-Gated Stops | 16 | Yes |
| 7 | Smart Volatility | 4.95/5 | ATR-driven CALL/PUT scalps | Volatility-weighted stake shaping | — | **No** |
| 8 | Smart Even | 4.92/5 | Anti-streak even/odd patterning | Pattern-aware martingale | 3.1 | Yes |
| 9 | No Touch Sentinel | 4.88/5 | Trend-sensing No Touch | 3.1× smart scaling | 16 | Yes |
| 10 | Alien Rise/Fall | 4.94/5 | Rapid trend re-entry | 3.1× adaptive martingale | 3.1 | Yes |
| 11 | Rise/Fall Pro | 4.9/5 | Momentum-confirmed Rise/Fall | 3.1× adaptive martingale | 3.1 | Yes |

**Note:** “Smart Recovery” in the UI means: after a loss, stake is multiplied by the martingale value and the bot continues (and for Smart Recovery Differ, it may switch to a special recovery mode). Ratings are fixed in the HTML (not computed from performance).

---

## 3. How Each Bot Works (Strategy & Logic)

### 1. All Markets Differ

- **Markets:** R_10, R_25, R_50, R_75, R_100 (from `options.markets`).
- **Contract:** `DIGITDIFF` (last digit of the tick must **differ** from the chosen digit).
- **Logic:**
  - Picks a **market**: prefer not repeating last market; random among the rest (or any if all equal).
  - Picks a **digit** 0–9: random, but if it would repeat last digit it uses `(digit + 3) % 10`.
  - Sends a proposal: 1 tick, stake, barrier = chosen digit.
  - On proposal response, buys immediately.
- **Recovery:** Standard martingale: on loss, stake × multiplier; on win, stake reset to initial.
- **TP/SL:** Stops when total profit ≥ Take Profit or total loss ≥ Stop Loss; popups if `PopupNotifications` exists.

---

### 2. Random Markets Over 0

- **Markets:** Same Volatility 10–100 list.
- **Contract:** `DIGITOVER` with barrier `0` (last digit > 0).
- **Logic:**
  - Next market: same “avoid repeating last” rule as All Markets Differ.
  - Every trade is “Over 0” on that market, 1 tick.
  - Gets proposal → buys.
- **Recovery:** Same martingale as above.
- **TP/SL:** Same as other digit bots.

---

### 3. Random Markets Under 9

- **Markets:** Same Volatility 10–100 list.
- **Contract:** `DIGITUNDER` with barrier `9` (last digit < 9).
- **Logic:** Same as Over 0 but with Under 9; market rotation identical.
- **Recovery / TP/SL:** Same as above.

---

### 4. Smart Differ Pro

- **Markets:** Same R_10 … R_100.
- **Contract:** `DIGITDIFF` with a chosen digit.
- **Logic:**
  - Subscribes to **ticks** for the chosen market and uses last digit from ticks (for display/consistency).
  - Next market: same “don’t repeat last” random choice.
  - Next digit: random 0–9, if same as last digit then `(digit + 3) % 10`.
  - 500 ms after subscribing to ticks, sends DIGITDIFF proposal (1 tick, barrier = digit) and buys on proposal.
- **Recovery:** Standard martingale.
- **TP/SL:** Same.

---

### 5. Smart Recovery Differ

- **Markets:** Same R_10 … R_100.
- **Contracts:** In **normal mode**: `DIGITDIFF` (random digit, one market). In **recovery mode**: `DIGITOVER` barrier 4 or `DIGITUNDER` barrier 5 on an “analyzed” market.
- **Logic:**
  - Subscribes to **ticks for all markets** and keeps per-market stats: last 50 digits, counts of digits > 4 and < 5.
  - **Normal:** Random market, random digit, DIGITDIFF. On **loss** → switch to **recovery mode**.
  - **Recovery:** `analyzeMarketsForRecovery()`:
    - Prefer a market with >60% of digits > 4 → trade **Over 4** there; or >60% < 5 → **Under 5**.
    - If none, use last 10 digits per market and same 60% rule.
    - Fallback: market with most ticks, then random; default Over 4.
  - Keeps trading recovery (Over 4 or Under 5) until a **win**, then back to normal (DIGITDIFF).
- **Recovery (code):** 3.1× martingale; recovery mode chooses “best” market/direction from digit analysis.
- **TP/SL:** Same.

---

### 6. Magic Random Strategy

- **Markets:** Same R_10 … R_100.
- **Contracts:** Random among **DIGITDIFF** (random digit), **DIGITUNDER** barrier 9, **DIGITOVER** barrier 0.
- **Logic:**
  - Next market: same “avoid repeat” rule.
  - `getRandomTradeType()`: random among `'DIFF'`, `'UNDER'`, `'OVER'`.
  - For DIFF, digit from `getNextDigit()`: among digits with **minimum appearance count** (to balance usage), then random from those; count incremented after selection.
  - Sends one proposal per trade and buys.
- **Recovery:** Martingale (default 16 in UI; value from config). **Extra stop conditions** (win-gated):
  - **2 consecutive losses** → stop after current trade (if that trade is a win, stop immediately; if loss, set `pendingStopReason` and stop after next win).
  - **2 losses in last 5 trades** → same “stop on next win” behavior.
  - **Running time ≥ 1 hour** → same “stop on next win” behavior.
- **TP/SL:** Checked first; then the above conditions.

---

### 7. Smart Volatility

- **Market:** **R_75** only (`this.symbol = 'R_75'`).
- **Contract:** **CALL** or **PUT** (1 or 2 ticks depending on volatility).
- **Logic:**
  - Subscribes to R75 ticks; keeps a **price history** (last `volatilityWindow` = 10 ticks).
  - **Entry:** `analyzeVolatility()`:
    - ATR(5) on last 5 ticks.
    - If tick change > ATR×1.2 → direction from price move: **CALL** if last > previous, else **PUT**.
    - Else if ATR > threshold (0.0015): compare last price to 3-tick average → **CALL** if above, else **PUT**.
    - Otherwise no trade.
  - **Stake/duration:** No martingale. Stake and duration depend on ATR:
    - High volatility (ATR > threshold×1.5): stake 80% of initial, duration 1 tick.
    - Low volatility (ATR < threshold×0.5): stake 120% of initial, duration 2 ticks.
    - Else: initial stake, 1 tick.
  - Minimum 2 s between trades.
- **Recovery:** None (no stake increase on loss); UI has martingale **hidden** (`supportsMartingale: false`).
- **TP/SL:** Same.

---

### 8. Smart Even

- **Market:** **R_50** only.
- **Contract:** **DIGITEVEN** or **DIGITODD** (last digit even or odd).
- **Logic:**
  - Tracks **digit history** and **even/odd distribution** and **streaks** (consecutive even or odd).
  - **Entry** `analyzePattern()`:
    - If “waiting for pattern” (after some condition): need even or odd probability > 0.55, or streak ≥ 2, to bet the **opposite** (fade the streak).
    - Otherwise: if even streak ≥ 3 → bet **odd**; if odd streak ≥ 3 → bet **even**; or if one side > 55% → bet the other.
  - Sends one proposal (1 tick) and buys.
- **Recovery:** Martingale (default 3.1).
- **TP/SL:** Same.

---

### 9. No Touch Sentinel

- **Market:** **R_100** only.
- **Contract:** **NOTOUCH** with barrier **+0.63** or **-0.63** (direction from trend), duration **5 ticks**.
- **Logic:**
  - Keeps last 15 ticks. **Entry** `analyzeMarket()`:
    - Short/medium/long MA (5, 10, 15), RSI(5), volatility, trend (up/down count), momentum.
    - “Range strength” score from: MA convergence, RSI extreme (≤30 or ≥70), trend size, momentum, volatility. **Trade only if rangeStrength ≥ 4.**
    - Barrier: trend > 0 → `+0.63`, else `-0.63` (price must not touch the barrier in 5 ticks).
  - Sends NOTOUCH proposal (5 ticks) and buys.
- **Recovery:** Martingale (default 16 in UI).
- **TP/SL:** Same.

---

### 10. Alien Rise/Fall

- **Market:** **R_10** only.
- **Contract:** **CALL** or **PUT**, 5 ticks.
- **Logic:**
  - **RSI(7)** and **trend strength** (direction + consistency over the window).
  - If `waitingForTrend` (set after a **loss**): require trend consistency > 0.7 for 2 ticks then return that direction.
  - Otherwise: if trend consistency > 0.6 → use that direction; or RSI < 30 → rise (CALL), RSI > 70 → fall (PUT).
  - Sends proposal and buys.
- **Recovery:** On loss, stake × martingale (default 3.1) and set `waitingForTrend = true` (stricter re-entry).
- **TP/SL:** Same.

---

### 11. Rise/Fall Pro

- **Market:** **R_10** only.
- **Contract:** **CALL** or **PUT**, 5 ticks.
- **Logic:**
  - **Multi-factor:** short/medium/long momentum (3, 7, 14 bars), **RSI(14)**, **MACD(12,26,9)**, volatility, and **pattern** (double top → fall, double bottom → rise).
  - Combines: pattern, momentum alignment (all three positive or negative), RSI extreme (support rise/fall), MACD histogram and line (support rise/fall). Builds a **strength** score; requires |strength| ≥ 2 (or ≥ 3 if volatility > 0.001).
  - Sends CALL or PUT and buys.
- **Recovery:** Martingale (default 3.1).
- **TP/SL:** Same.

---

## 4. Summary Table: Contract Types & Markets

| Bot | Symbol(s) | Contract type(s) | Duration | Martingale |
|-----|-----------|-------------------|----------|------------|
| All Markets Differ | R_10…R_100 | DIGITDIFF | 1 tick | ×16 |
| Random Markets Over 0 | R_10…R_100 | DIGITOVER (0) | 1 tick | ×16 |
| Random Markets Under 9 | R_10…R_100 | DIGITUNDER (9) | 1 tick | ×16 |
| Smart Differ Pro | R_10…R_100 | DIGITDIFF | 1 tick | ×16 |
| Smart Recovery Differ | R_10…R_100 | DIGITDIFF / DIGITOVER(4) / DIGITUNDER(5) | 1 tick | ×3.1 |
| Magic Random Strategy | R_10…R_100 | DIGITDIFF / DIGITUNDER(9) / DIGITOVER(0) | 1 tick | ×16 + win-gated stops |
| Smart Volatility | R_75 | CALL / PUT | 1 or 2 ticks | No |
| Smart Even | R_50 | DIGITEVEN / DIGITODD | 1 tick | ×3.1 |
| No Touch Sentinel | R_100 | NOTOUCH (±0.63) | 5 ticks | ×16 |
| Alien Rise/Fall | R_10 | CALL / PUT | 5 ticks | ×3.1 |
| Rise/Fall Pro | R_10 | CALL / PUT | 5 ticks | ×3.1 |

---

## 5. Common Behavior (All Bots)

- **Auth:** Token from `resolveAuthToken()` (OAuth or API key from localStorage).
- **WebSocket:** `wss://ws.binaryws.com/websockets/v3?app_id=67709`.
- **Reconnect:** Up to 10 attempts with exponential backoff (cap 30 s); on InvalidToken/AuthorizationRequired re-auth and reconnect.
- **Take profit / Stop loss:** All bots respect the shared Take Profit and Stop Loss; on hit they call `PopupNotifications.showTakeProfit` / `showStopLoss` when available and then stop.
- **Balance:** Subscribe to balance and contract updates; UI shows live balance and trade history.

You can use this file as the single reference for **what each bot does**, **what the UI ratings and settings mean**, and **how each bot’s strategy and recovery work** in code.
