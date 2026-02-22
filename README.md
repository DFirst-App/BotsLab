# Magic Automation Lab - WebBots Dashboard

Complete automated trading bots platform for Deriv and MT5 trading.

## Repository Structure

```
WebBots/
├── index.html                  # Main dashboard/homepage
├── trading-bots.html           # Deriv trading bots page (noindex)
├── mt5trading-bots.html        # MT5 trading bots page (noindex)
├── oauth-callback.html         # OAuth callback handler
├── robots.txt                  # Search engine crawler instructions
├── sitemap.xml                 # Sitemap (homepage only)
├── popup-notifications.js     # Signal popup notification system
├── README.md                   # This file
│
├── bots/                       # Deriv Trading Bots (10 bots)
│   ├── allMarketsDiffer.js
│   ├── allMarketsOver.js
│   ├── allMarketsUnder.js
│   ├── smartDifferBot.js
│   ├── magicRandomBot.js
│   ├── smartVolatility.js
│   ├── smartEven.js
│   ├── noTouch.js
│   ├── alienRiseFall.js
│   └── riseFall.js
│
├── mt5bots/                    # MT5 Trading Bots (3 bots)
│   ├── eliteSignalBot.js
│   ├── boomCrashSignalBot.js
│   └── mt5ApiConnection.js
│
└── favicon.svg                 # Site icon (blue S on white)
```

## Main HTML Files

### 1. `index.html` (2,921 lines)
- **Purpose**: Main dashboard/homepage
- **Features**:
  - OAuth connection and account management
  - Deriv account creation, deposit, withdraw links
  - Trading bots navigation
  - Comprehensive SEO optimization
  - Google Analytics integration
  - Responsive design for all screen sizes
- **SEO**: Fully indexed with meta tags, structured data, Open Graph, Twitter Cards

### 2. `trading-bots.html` (2,375 lines)
- **Purpose**: Deriv trading bots interface
- **Features**:
  - 10 Deriv trading bots with full configuration
  - Real-time bot performance tracking
  - Trade history and statistics
  - Bot configuration (stake, take profit, stop loss, martingale)
  - Live account balance display
- **SEO**: `noindex, nofollow` (hidden from search engines - requires account connection)

### 3. `mt5trading-bots.html` (2,200+ lines)
- **Purpose**: MT5 trading bots and signal analysis
- **Features**:
  - Elite Signal Bot (auto-analyzes markets)
  - Boom & Crash Signal Bot
  - Smart Money Bot (coming soon)
  - ICT Bot (coming soon)
  - Live market data display
  - Signal analysis with win rate tracking
- **SEO**: `noindex, nofollow` (hidden from search engines - requires account connection)

### 4. `oauth-callback.html`
- **Purpose**: OAuth callback handler for Deriv authentication

## Bot Implementations

### Deriv Bots (`/bots/` folder - 10 bots)
All bots use `app_id=67709` for tracking via WebSocket connection.

1. **allMarketsDiffer.js** - All Markets Differ Bot
   - Cycles through Volatility 10–100 markets
   - Rotating digits per trade with recovery logic

2. **allMarketsOver.js** - Random Markets Over 0 Bot
   - Fires Digit Over 0 contracts across Volatility 10–100
   - Rotating markets after every trade

3. **allMarketsUnder.js** - Random Markets Under 9 Bot
   - Targets Digit Under 9 entries on every tick
   - Rotates through Volatility 10–100 markets

4. **smartDifferBot.js** - Smart Differ Pro Bot
   - Advanced digit differ strategy
   - Intelligent digit selection and smart recovery

5. **magicRandomBot.js** - Magic Random Strategy Bot
   - Randomly selects between Differ, Under 9, and Over 0
   - Multi-market with intelligent stop conditions

6. **smartVolatility.js** - Smart Volatility Bot
   - Tracks R75 tick speed and ATR in real-time
   - Flips between CALL and PUT contracts

7. **smartEven.js** - Smart Even Bot
   - Scans R50 digit streaks
   - Attacks DIGITEVEN/DIGITODD entries

8. **noTouch.js** - No Touch Sentinel Bot
   - Monitors R100 momentum, RSI, and volatility
   - Fires NOTOUCH contracts with directional barriers

9. **alienRiseFall.js** - Alien Rise/Fall Bot
   - Tracks R10 waves using fast RSI + EMA filters
   - Fires CALL/PUT contracts with adaptive recovery

10. **riseFall.js** - Rise/Fall Pro Bot
    - Blends RSI, MACD, and multi-frame momentum
    - Times R10 CALL/PUT entries with volume-weighted confirmation

### MT5 Bots (`/mt5bots/` folder - 3 bots)

1. **eliteSignalBot.js** - Elite Signal Bot
   - Auto-analyzes markets (no manual start required)
   - Multi-indicator analysis
   - 3 take profit levels
   - Real-time signal generation

2. **boomCrashSignalBot.js** - Boom & Crash Signal Bot
   - Specialized signal generator for Boom and Crash indices
   - Auto-analysis with high-probability signals
   - Stop loss and take profit levels

3. **mt5ApiConnection.js** - MT5 API Connection Handler
   - Handles MT5 API connections
   - Market data retrieval

## Partner Tracking & App ID

### ✅ Verified Partner Tracking

**Partner Code**: `_30qaRjl291dMjdsyM5hasGNd7ZgqdRLk`  
**App ID**: `67709`

#### All Deriv Links Tracked:
- ✅ **OAuth Authorization URL**: Includes partner code `t=_30qaRjl291dMjdsyM5hasGNd7ZgqdRLk`
- ✅ **Create Deriv Account Button**: `https://track.deriv.com/_30qaRjl291dMjdsyM5hasGNd7ZgqdRLk/1/`
- ✅ **Create API Key Link**: Includes partner code
- ✅ **Deposit Button (P2P)**: Includes partner code
- ✅ **Withdraw Button (P2P)**: Includes partner code
- ✅ **Create MT5 Account Buttons**: Includes partner code
- ✅ **Trading Bots URL**: Includes partner code

#### All Bot Trades Tracked:
- ✅ **WebSocket Connection**: `wss://ws.binaryws.com/websockets/v3?app_id=67709`
- ✅ **All 10 Deriv bots** use `app_id=67709` via shared WebSocket connection
- ✅ All trades executed through bots are tracked via App ID

## SEO Optimization

### Meta Tags
- Comprehensive title, description, keywords
- Open Graph tags for social sharing
- Twitter Card tags
- International SEO (hreflang tags)
- Google site verification meta tag

### Structured Data (JSON-LD)
- Organization schema
- WebApplication schema
- SoftwareApplication schema
- CollectionPage schema
- FAQPage schema
- BreadcrumbList schema

### Analytics & Tracking
- Google Analytics (G-4WCDE6D602)
- Google tag (gtag.js) implementation

### Search Engine Configuration
- `robots.txt` - Guides search engine crawlers
- `sitemap.xml` - Only includes homepage (trading-bots pages excluded)
- Trading-bots pages set to `noindex, nofollow` (require account connection)

## Key Features

### User Experience
- ✅ Responsive design (mobile, tablet, desktop)
- ✅ OAuth and API key authentication
- ✅ Real-time bot performance tracking
- ✅ Signal popups with copy functionality
- ✅ Low balance deposit prompts
- ✅ Account balance display
- ✅ Trade history and statistics

### Security
- ✅ Trading-bots pages hidden from search engines
- ✅ Only homepage indexed for public discovery
- ✅ Pages require account connection to access

### Bot Features
- ✅ Automatic reconnection on connection loss
- ✅ Smart recovery logic
- ✅ Martingale multiplier configuration
- ✅ Take profit and stop loss controls
- ✅ Real-time market analysis
- ✅ Signal generation with win rate tracking

## Deployment

This repository automatically deploys to Netlify when changes are pushed to the `main` branch.

### Domain
- **Production URL**: `https://magicbotslab.com/`

### First Time Setup

1. **Netlify Deployment:**
   - Connected to GitHub repository
   - Auto-deploys on push to `main` branch
   - Custom domain configured

2. **OAuth Configuration:**
   - Register callback URL in Deriv App Settings
   - Go to https://developers.deriv.com/app-registration/
   - Find your app (App ID: 67709)
   - Add redirect URI: `https://magicbotslab.com/`

## Future Updates

All WebBots updates should be committed and pushed to this repository:
```bash
cd WebBots
git add .
git commit -m "Your commit message"
git push origin main
```

## Summary Statistics

- **Total HTML Files**: 4 (index, trading-bots, mt5trading-bots, oauth-callback)
- **Deriv Bots**: 10 bots
- **MT5 Bots**: 3 bots
- **Favicon Files**: 5 files
- **Partner Tracking**: ✅ 100% coverage
- **SEO**: ✅ Fully optimized
- **Responsive Design**: ✅ All screen sizes

---

**Status**: ✅ Production Ready - All features verified and operational
