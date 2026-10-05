# 📈 TradeTrainer: Stock & Options Paper-Trading Game

> Also in this repo: **[Starhome](starship/README.md)**, a WebXR game that turns your room into the bridge of a starship (`npm run starship`).

Practice trading **stocks and option contracts** with fake money at **real, current market prices**.
A built-in coach gives tips and trading strategies, explains how and where to place each trade, and
tracks your profit/loss, balance and progress. You can reset the account at any time.

## Quick start

Requires [Node.js](https://nodejs.org) 18 or newer. No `npm install` is needed because there are zero dependencies.

```bash
npm start
# then open http://localhost:3000
```

Use `PORT=8080 npm start` to choose a different port.

## Play it on the web

The hosted version runs on claude.ai: https://claude.ai/artifact/1echBMoEEpDDUa28y2uKVY

It gets live stock and option prices through each player's own **Robinhood connector** (read-only market-data
tools; the game never places real orders) and saves every player's game privately to their account, so progress
follows them between devices. Rebuild the page after changing the code with:

```bash
node scripts/build-web.mjs   # -> dist/tradetrainer.html
```

## Features

| Area | What you get |
| --- | --- |
| **Real market data** | Live stock quotes, intraday and historical charts (1D–5Y), and full option chains (every expiration and strike, with bid/ask/last, volume, open interest and implied volatility). Prices refresh every 15 seconds. |
| **Stock trading** | Buy and sell with **Market**, **Limit** and **Stop-loss** orders. Includes average-cost tracking and quick quantity buttons (1/10/100/Max). |
| **Options trading** | Click any **Ask** to buy or **Bid** to sell. Supports buy/sell to open and close, **covered calls** (100 shares per contract) and **cash-secured puts** (collateral reserved). Buys fill at the ask, sells at the bid, with a $0.65/contract commission. Expired options settle automatically. |
| **Risk tools** | For each option order you see the breakeven, max profit, max loss, a payoff-at-expiration chart, and Greeks (Δ, Θ, IV, probability ITM). |
| **Coach** | Gives feedback on every order as you build it: position size, trend vs. 50/200-day averages, days to expiry, far-OTM "lottery tickets", wide spreads, low liquidity, upcoming earnings, and where to put a stop. |
| **Learn tab** | 8 strategy lessons (buy & hold, swing trading with a stop-loss, limit entries, long call, long put, protective put, covered call, cash-secured put). Each covers what it is, when to use it, how to place it step by step, where to put the strike, stop or limit, and its risk/reward. Each has a **Practice it** button. Also includes a glossary. |
| **Account** | Balance, cash, buying power, today's P/L, total/realized/unrealized P/L, an account-value chart, a positions table with one-click **Close**, working orders, and full trade history. |
| **Game** | 12 achievements and trading stats (win rate, average win/loss, best/worst trade). **Reset** starts over with $5K–$1M and a choice of commission. |

Your game is saved in your browser (localStorage), so closing the tab doesn't lose progress.

## How it works

```
server.js            Zero-dependency Node server: serves /public and proxies market data
                     (/api/quote, /api/chart, /api/options, /api/search) with short caching.
public/js/engine.js  Pure trading engine: orders, fills, collateral, P/L, expiration, Greeks.
public/js/coach.js   Strategy lessons, glossary, tips and context-aware trade feedback.
public/js/charts.js  Canvas charts (price, equity curve, option payoff).
public/js/data.js    Market data for the self-hosted version (talks to server.js).
public/js/app.js     UI controller.
web/data-robinhood.js  Market data + per-player saves for the hosted web version.
scripts/build-web.mjs  Bundles everything into one page for the web version.
test/                Engine unit tests: `npm test`
```

Market data comes from Yahoo Finance's public endpoints and may be delayed by up to 15 minutes. This is an
educational simulator, not financial advice, and it never places real trades.
