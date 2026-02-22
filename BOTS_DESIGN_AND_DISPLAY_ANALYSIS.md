# Bots: Design, Functions, Displays & Color System – Full Analysis

This document describes how all bots work, how they execute trades, how the UI is designed (functions, layout, displays), and the complete color/design system. It complements `BOTS_ANALYSIS_AND_HOW_THEY_WORK.md` (strategy per bot) with **architecture, data flow, and visual design**.

---

## 1. High-Level Architecture

### 1.1 Page & Data Flow

- **Entry:** User opens `trading-bots.html` (Deriv bots dashboard). Bots list is built from `BOT_DEFINITIONS`; each card has a `key`, `name`, `cardId`, `buttonId`, optional `defaultMartingale` / `supportsMartingale`, and `createInstance()`.
- **Auth:** Token is resolved via `resolveAuthToken()` (OAuth or API key from `localStorage`). All bots use the same WebSocket URL: `wss://ws.binaryws.com/websockets/v3?app_id=67709`.
- **Bot instance:** One instance per bot key is created lazily via `getBotInstance(key)`. When the user opens a bot panel, `handleBotOpen(key)` sets `currentBotKey` / `currentBotInstance`, shows the detail panel, and loads that bot’s default martingale into the config UI.
- **Config:** Shared inputs (Stake, Take Profit, Stop Loss, Martingale) live in the single **Configuration** column. `botUI.getConfigValues()` and `botUI.validateConfig()` are used when the user clicks **Start Bot**. Smart Volatility hides the Martingale input (`supportsMartingale: false` → `setMartingaleVisibility(false)`).
- **Running:** Start Bot → `currentBotInstance.start(config)`. Each bot connects WS, sends `authorize`, subscribes to `balance` and `proposal_open_contract`, then runs its own loop (proposal → buy → wait for contract close → update stats → next trade or stop).

### 1.2 Bot Base Pattern (All 11 Bots)

Every bot:

1. **Constructor(ui, options)**  
   - `ui`: the `botUI` object from `initBotUI()`.  
   - `options`: `{ wsUrl, defaults, markets? (for digit/multi-market bots), resolveAuthToken, WebSocketImpl? }`.

2. **resetState()**  
   - Clears WS, running flags, config copy, stake, profit/trade counts, consecutive losses, trade history, balance/currency, timers, reconnect state, and any bot-specific state (e.g. Smart Recovery: `recoveryMode`, `marketAnalysis`; Smart Volatility: `priceHistory`, `lastVolatility`).

3. **start(config)**  
   - Checks already running; resolves token; merges config; resets in-memory state; calls `ui.resetHistory()`, `ui.updateStats(getStatsSnapshot())`, `ui.setRunningState(true)`; sets `startTime` and starts running timer; calls `connectWebSocket()`.

4. **connectWebSocket()**  
   - Creates WebSocket; on open sends `authorize`; sets `onmessage` → `handleMessage`; on error/close (if not stop requested) calls `attemptReconnect()` with exponential backoff (cap 30s, max 10 attempts).

5. **handleMessage(raw)**  
   - Parses JSON; handles `data.error` (InvalidToken/AuthorizationRequired → re-auth/reconnect; RateLimit → retry after delay; others → show error).  
   - Dispatches by `msg_type`:  
     - `authorize` → store balance/currency, `ui.updateBalance()`, subscribe to balance & contracts, then start first trade (e.g. `queueNextTrade()`).  
     - `balance` → update balance display.  
     - `proposal` → send `buy` with `proposal.id` and `ask_price`.  
     - `buy` → store `activeContractId`.  
     - `proposal_open_contract` → `handleContractUpdate(contract)`.

6. **Trade execution (concept)**  
   - Bot chooses market/symbol, contract type, barrier/duration as per strategy.  
   - Sends `proposal` (proposal: 1, amount, basis: 'stake', contract_type, currency, duration, duration_unit, symbol, barrier if needed).  
   - On `proposal` response, sends `buy` with returned id and ask_price.  
   - On `proposal_open_contract` with `is_sold`, bot computes profit, win/loss, updates stake (martingale if applicable), calls `ui.addHistoryEntry()`, `ui.updateStats(getStatsSnapshot())`, checks TP/SL in `shouldStop()`, then queues next trade (or stops).

7. **stop(message, type)**  
   - Sets `stopRequested`, stores message; closes WS (or calls `finishStop()` if WS already closed).  
   - `finishStop()` clears timers, sets `isRunning = false`, `ui.setRunningState(false)`, shows stop message.

8. **getStatsSnapshot()**  
   - Returns object used by the UI: `balance`, `currency`, `totalProfit`, `totalTrades`, `winRate`, `currentStake`, `consecutiveLosses`, `market`, `digit` (or display string for target), `lastProfit?`, `runningTime`.  
   - `winRate` = (wins / totalTrades) * 100; `runningTime` from `getRunningTime()` (HH:MM:SS since start).

---

## 2. Trade Execution by Bot Type

### 2.1 Digit / Volatility Markets (R_10 … R_100)

- **Contracts:** DIGITDIFF, DIGITOVER, DIGITUNDER, DIGITEVEN, DIGITODD.  
- **Flow:** Pick market (and digit/barrier); send one `proposal` with `contract_type`, `barrier`, `duration: 1`, `duration_unit: 't'`; on `proposal` reply send `buy`; on contract sold, update stats and optionally martingale, then next trade.

### 2.2 Rise/Fall (CALL/PUT)

- **Contracts:** CALL or PUT, typically 5 ticks (`duration: 5`, `duration_unit: 't'`).  
- **Flow:** Subscribe to ticks (e.g. R_10); maintain price/tick history; compute signal (RSI, trend, MACD, etc.); send proposal with `contract_type: 'CALL'|'PUT'`; buy; on close, update and next.

### 2.3 No Touch

- **Contract:** NOTOUCH with barrier (+0.63 or -0.63), 5 ticks.  
- **Flow:** Tick history → trend/range analysis → send proposal with barrier and duration 5; buy; on close, update and next.

### 2.4 Smart Volatility (ATR / CALL-PUT)

- **Contract:** CALL or PUT, 1 or 2 ticks; no martingale.  
- **Flow:** Ticks for R_75 → ATR/volatility → direction and stake/duration scaling → proposal → buy; on close, update and next.

---

## 3. UI Functions (botUI) – Design of the Display Layer

`initBotUI()` returns the **botUI** object used by every bot. It holds refs to DOM elements and exposes a fixed API so bots never touch the DOM directly.

### 3.1 Config & Validation

- **getConfigValues()**  
  - Reads: Stake, Take Profit, Stop Loss, Martingale (if martingale enabled).  
  - Returns: `{ initialStake, takeProfit, stopLoss, martingaleMultiplier }`.  
  - Martingale default comes from current bot’s `defaultMartingale` (set when opening bot) or `BOT_DEFAULTS.martingaleMultiplier`.

- **validateConfig(config)**  
  - Ensures: stake ≥ min (0.35), takeProfit > 0, stopLoss > 0, martingale ≥ 1 when enabled.  
  - Returns `{ valid, message? }`.

### 3.2 Running State & Status

- **setRunningState(isRunning)**  
  - Start button disabled when running; Stop button disabled when not running.  
  - Toggles class `btn-liquid-glow` between Start (when idle) and Stop (when running).  
  - Status badge: `data-state="idle"|"running"`, text "Idle" | "Running".

- **showStatus(message, type)**  
  - Sets status text.  
  - `type`: `'info'` (default), `'error'`, `'success'`, `'warning'`.  
  - Error: badge `data-state="error"`, text "Error"; if message contains "insufficient", opens deposit popup.  
  - Success: badge "Running".  
  - Warning: badge "Attention".  
  - Otherwise (and if Start not disabled): badge "Idle".

### 3.3 Stats Display

- **updateBalance(value, currency)**  
  - Sets `lastKnownBalance`, `lastKnownCurrency` (used elsewhere for low-balance popup, deposit popup).  
  - Updates `#balanceValue` text: `"USD 123.45"`.

- **updateStats(stats)**  
  - Expects object from `getStatsSnapshot()`.  
  - **Total Profit:** `#totalProfitValue` → "+$X.XX" or "-$X.XX"; toggles classes `positive` / `negative`.  
  - **Total Trades:** `#totalTradesValue`.  
  - **Win Rate:** `#winRateValue` → "X.XX%".  
  - **Current Stake:** `#currentStakeValue` → "$X.XX".  
  - **Consecutive Losses:** `#consecutiveLossesValue`.  
  - **Market / Digit:** `#targetValue` → `stats.market + " / " + stats.digit` (digit can be number or string like "CALL", "Even", "Differ 5", "Over 0", etc.).  
  - **Running Time:** `#runningTimeValue` → `stats.runningTime`.

- **updateTargets(market, digit)**  
  - Shortcut to set only `#targetValue` to `market + " / " + digit`.

- **updateRunningTime(value)**  
  - Sets `#runningTimeValue` (called every second by running timer).

### 3.4 History

- **resetHistory()**  
  - Clears `#historyList` innerHTML.

- **addHistoryEntry(entry)**  
  - Expects: `{ market, digit, stake, profit, win, timestamp }`.  
  - Creates a `.history-item` with class `.win` or `.loss`.  
  - Structure:  
    - `.history-meta`: "**Market · Digit N**", time, "Stake: $X.XX".  
    - `.history-profit`: "+$X.XX" or "-$X.XX" with class `.win` or `.loss`.  
  - Prepends to list; keeps only last 20 entries (`historyLimit`).

### 3.5 Martingale Visibility

- **setMartingaleVisibility(show)**  
  - Shows or hides the Martingale input group (`#martingaleGroup`) so Smart Volatility has no martingale field.

---

## 4. Display Colors & Visual Design

### 4.1 CSS Variables (Design Tokens)

Defined in `:root` in `trading-bots.html`:

| Variable    | Value               | Usage                    |
|------------|---------------------|--------------------------|
| `--bg`     | `#0f1117`           | Page background           |
| `--panel`  | `#171b24`           | Cards, panels, inputs bg  |
| `--panel-strong` | `#1f2531`   | Stronger panel areas      |
| `--panel-soft`    | `rgba(23,27,36,0.9)` | Overlays               |
| `--accent` | `#00d2ff`           | Primary accent (cyan)     |
| `--accent-2` | `#ff7a18`        | Secondary (orange)        |
| `--text`   | `#f5f7ff`           | Primary text              |
| `--muted`  | `#98a2bd`           | Secondary/meta text       |
| `--border` | `rgba(255,255,255,0.08)` | Borders            |
| `--success`| `#24d970`            | Wins, positive, running   |
| `--danger` | `#ff5f6d`            | Losses, errors            |
| `--warning`| `#fcd34d`            | Warnings, attention       |

Body uses a radial gradient: `radial-gradient(circle at top right, rgba(0,210,255,0.25), transparent 40%), var(--bg)`. A grid overlay (`.grid-bg`) adds subtle cyan lines (32px) for depth.

### 4.2 Status Badge (data-state)

- **idle:** Background `rgba(255,255,255,0.05)`, border `rgba(255,255,255,0.08)`, color `var(--muted)`.  
- **running:** Background `rgba(36,217,112,0.1)`, border `rgba(36,217,112,0.3)`, color `var(--success)`.  
- **error:** Background `rgba(255,68,79,0.12)`, border `rgba(255,68,79,0.3)`, color `var(--danger)`.

### 4.3 Stat Values (Live Performance)

Each stat has a dedicated color for quick scanning:

| Element ID           | Color / Rule                          |
|----------------------|----------------------------------------|
| `#balanceValue`      | `#00d2ff` (cyan)                       |
| `#totalProfitValue`  | `.positive` → `#24d970`, `.negative` → `#ff5f6d` |
| `#totalTradesValue`   | `#ff7a18` (orange)                     |
| `#winRateValue`      | `#a855f7` (purple)                     |
| `#currentStakeValue` | `#00d2ff` (cyan)                       |
| `#consecutiveLossesValue` | `#ff5f6d` (danger)              |
| `#targetValue`      | `#fcd34d` (warning/amber)             |
| `#runningTimeValue`  | `#00d2ff` (cyan)                       |

Stat labels use `rgba(152,162,189,0.7)` (muted). Stat cards have a bottom border `rgba(255,255,255,0.05)`.

### 4.4 History List

- **Container:** `.history-list` – flex column, gap 10px, overflow-y auto, custom scrollbar (track `rgba(255,255,255,0.05)`, thumb `rgba(0,210,255,0.3)`).  
- **Item:** `.history-item` – flex row, space-between, padding 10px 12px, border-radius 10px, background `rgba(255,255,255,0.02)`, border `rgba(255,255,255,0.05)`.  
- **Win:** `.history-item.win` – border `rgba(36,217,112,0.3)`.  
- **Loss:** `.history-item.loss` – border `rgba(255,68,79,0.3)`.  
- **Meta:** `.history-meta` – muted color, column layout (market·digit, time, stake).  
- **Profit text:** `.history-profit.win` → `var(--success)`; `.history-profit.loss` → `var(--danger)`.

### 4.5 Bot Cards (List View)

- **Card:** `.bot-card` – background `var(--panel)`, border `var(--border)`, border-radius 18px, padding 24px, box-shadow, overflow hidden.  
- **Hover/Active:** `::after` pseudo-element with gradient border `linear-gradient(120deg, rgba(0,210,255,0.35), rgba(255,122,24,0.2))`, opacity 0 → 1 on hover or when `.active`.  
- **Chip:** `.bot-chip` – pill style, cyan tint (`rgba(0,210,255,0.12)` bg, `#00d2ff` text), uppercase, small.  
- **Badges (first 4 cards only):**  
  - Popular: amber `#fbbf24`, bg `rgba(245,158,11,0.15)`.  
  - Beginner: green `#4ade80`, bg `rgba(34,197,94,0.15)`.  
  - Fast: blue `#60a5fa`, bg `rgba(59,130,246,0.15)`.  
  - Stable: purple `#c084fc`, bg `rgba(168,85,247,0.15)`.  
- **Title:** `h3` – `var(--text)`, 20px, bold.  
- **Description:** `p` – `var(--muted)`, 14px.  
- **Meta list:** `.bot-meta li` – small pills, `rgba(255,255,255,0.04)` bg, muted text.  
- **Open Bot button:** `.open-bot-btn` – gradient accent, hover lift and shine (separate from Start/Stop).

### 4.6 Start / Stop Bot Buttons (Detail Panel)

- **Primary (Start):** Gradient cyan, border cyan; when active (idle) has class `btn-liquid-glow`: flowing liquid (cyan) + pulse glow (cyan border/box-shadow).  
- **Secondary (Stop):** Neutral panel style when idle; when active (running) has `btn-liquid-glow`: same animation but amber/orange liquid and border/glow.  
- Liquid keyframes: `btn-liquid-flow` (background-position), `btn-glow-pulse-start` / `btn-glow-pulse-stop` (box-shadow + border-color). One color and direction at a time per button.

### 4.7 Inputs & Config Panel

- Inputs: background `var(--panel)`, borders and labels use muted/panel tones; focus styles use accent.  
- Config section has heading "Configuration"; config grid holds Stake, Take Profit, Stop Loss, Martingale (when visible).  
- "Connect your Deriv account from the dashboard before running bots." is in `.status-text` (muted) under the buttons.

### 4.8 Layout Structure

- **Page:** `.page` – max-width 1400px, padding 24px, flex column.  
- **Bot panel:** Two-column grid (config + stats | history). Stats column shows "Live Performance" with the stat cards; history column shows "Recent Trades" and the scrollable history list.  
- **Header:** Back button, title; when a bot is open, header can show "show-active" and back is visible.  
- **Footer:** Fixed bottom, dark bar with link (e.g. Deriv disclaimer).

---

## 5. Summary Table: Bots → Contract Types & Display Targets

| Bot                   | Symbol(s)   | Contract type(s)                          | Target display (Market / Digit)   |
|----------------------|------------|--------------------------------------------|-----------------------------------|
| Smart Recovery Differ| R_10…R_100 | DIGITDIFF / DIGITOVER(4) / DIGITUNDER(5)  | market / digit or "Over 4" etc.    |
| All Markets Differ   | R_10…R_100 | DIGITDIFF                                 | market / digit                     |
| Random Markets Over 0 | R_10…R_100 | DIGITOVER(0)                            | market / "Over 0"                 |
| Random Markets Under 9 | R_10…R_100 | DIGITUNDER(9)                          | market / "Under 9"                |
| Smart Differ Pro    | R_10…R_100 | DIGITDIFF                                 | market / "Differ N"                |
| Magic Random        | R_10…R_100 | DIGITDIFF / DIGITOVER(0) / DIGITUNDER(9)  | market / digit or Over/Under      |
| Smart Volatility    | R_75       | CALL / PUT                                | R_75 / "CALL" or "PUT"            |
| Smart Even          | R_50       | DIGITEVEN / DIGITODD                      | R_50 / "Even" or "Odd"            |
| No Touch Sentinel   | R_100      | NOTOUCH (±0.63)                           | R_100 / "CALL +0.63" etc.         |
| Alien Rise/Fall     | R_10       | CALL / PUT (5t)                           | R_10 / "CALL" or "PUT"             |
| Rise/Fall Pro       | R_10       | CALL / PUT (5t)                           | R_10 / "CALL" or "PUT"             |

History entries always use `entry.market` and `entry.digit` (string or number) for the "Market · Digit" line; for CALL/PUT/No Touch, `digit` is the display string (e.g. "CALL", "Odd", "Differ 5").

---

## 6. What Not to Change When Editing

- **Bot contract logic:** Each bot’s proposal/buy/contract handling is self-contained in its JS file; changes there don’t require UI changes unless you add new stats or history fields.  
- **botUI API:** All bots depend on the same `botUI` methods; changing method names or signatures would require updates in all 11 bots.  
- **getStatsSnapshot() shape:** The UI expects the fields listed above; adding fields is safe, removing or renaming requires updating `updateStats()` and any DOM bindings.  
- **History entry shape:** `addHistoryEntry(entry)` expects `market`, `digit`, `stake`, `profit`, `win`, `timestamp`; bots that use different internal names map them when calling `addHistoryEntry()`.

---

You now have a single reference for: how every bot executes trades, how the shared UI functions and displays work, and how all display colors and layout are designed. Use this together with `BOTS_ANALYSIS_AND_HOW_THEY_WORK.md` for strategy and recovery details per bot.
