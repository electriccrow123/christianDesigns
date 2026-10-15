# Crow's Nest

A four-agent Claude trading desk for an **agentic Robinhood account**. It reads the market, finds chart
patterns, plans the week, the day and the hour, sizes and places stock and option trades within the
risk mode you pick, explains every decision in plain English, and teaches you to trade along the way.

> Crow's Nest is software that follows your settings. It is not financial advice. Trading stocks and
> options can lose money quickly, and options can expire worthless. Start in Paper mode.

## The team

| Agent | Job |
| --- | --- |
| **Head Honcho** | Chief strategist. Talks with you, writes the weekly and daily plans, makes the final buy/sell calls, tunes the mode's settings within their bounds. |
| **Operator** | Runs the desk. Turns each decision into an exact order (contract, size, limit price, stop, target) and manages open positions. |
| **Scout** (researcher) | Charts: trend, support/resistance, chart and candlestick patterns, market regime. |
| **Analyst** (researcher) | Options pricing (implied volatility, expected move, liquidity), earnings and events, fundamentals, analyst ratings. |
| **Risk gate** (code, not AI) | Checks every order against the mode and your hard limits. It can shrink or block an order; nothing reaches Robinhood without passing it. |

Each cycle: code gathers data and computes the technicals → Scout and Analyst report in parallel →
the Head Honcho decides → code drafts exact tickets → the Operator reviews them → the risk gate
checks them → orders go out (or wait for you) → everything is journaled.

## Five risk modes

| Mode | What it trades | Per-trade size | Options |
| --- | --- | --- | --- |
| 1 Fortress | Large companies and broad ETFs | ≤ 10% | none |
| 2 Steady | Quality stocks and ETFs | ≤ 15% | covered calls, cash-secured puts |
| 3 Balanced | Stocks incl. mid caps | ≤ 20% | calls, puts, debit/credit spreads, 3+ weeks out |
| 4 Aggressive | Momentum names, small caps above $2 | ≤ 30% | 1+ week out, earnings plays |
| 5 Moonshot | Everything, extended hours | ≤ 40% | same-day (0DTE) and long-shot contracts |

Each mode also sets stops and targets, delta and expiration ranges, liquidity floors, a daily loss
circuit breaker, a trade limit and a cash cushion. The Head Honcho may tune some of these for current
conditions, but only inside the bounds shown in Settings. Your own hard limits (max dollars per order,
daily loss, trades per day, a do-not-trade list, a pattern-day-trader guard, auto-lowering the mode
after a drawdown) only ever tighten them.

## What's in the app

- **Desk**: account value, today's P/L, buying power, the current buy/sell plan (open the arrow on any
  row for the researchers' evidence, the Head Honcho's reasoning, the Operator's ticket and every risk
  check), positions with exit plans, working orders, trade history with the reasoning behind agent
  trades, market regime, equity curve and the next check-in.
- **AI Desk**: chat with the Head Honcho (it can look up live data and queue trades for you to send),
  the agent room (the team's conversation for every cycle), and the intentions and journal.
- **Planner**: the week (events, earnings, Fed days, option expirations, the Head Honcho's plan per
  day), the weekly thesis, focus list with entry/stop/target, if-then scenarios, and today hour by hour.
- **Research**: market regime, a scanner ranking your watchlist by technical score, candlestick charts
  with moving averages, support/resistance and a one-week projection, detected patterns explained, and
  a researchers' deep dive on any ticker.
- **Academy**: 18 lessons with quizzes (orders, sizing, candles, trends, levels, patterns, momentum,
  market regimes, events, calls and puts, the Greeks, strategies, choosing contracts, exits,
  psychology, and how the desk itself works), a pattern drill on real charts, an AI tutor, and a
  glossary.
- **Settings**: Paper or Live, confirm-each or automatic sending, the five modes, hard limits,
  watchlist, autopilot, standing instructions and the Head Honcho's memory.

## Three ways to run it

### 1. On claude.ai (live trading through your Robinhood connector)

Open it at https://claude.ai/artifact/1doiiStYd6ovTDFvh29Tpq (private to you).

The published page uses Claude through your claude.ai account and your **Robinhood connector**, so it
needs no API keys. Live trading uses the one account you opened to AI agents in Robinhood. It starts
in Paper mode; switching to Live asks you to confirm, and orders wait for your **Send** until you turn
on automatic sending. If your Robinhood setting requires approval of agent trades, each order also
waits for you in the Robinhood app.

Rebuild the page after changing the code:

```bash
node scripts/build-hosted.mjs   # -> dist/crowsnest.html
```

### 2. Background autopilot (live, while the page is closed)

A scheduled Claude session follows [AUTOPILOT.md](AUTOPILOT.md) on the desk's schedule (8:45 am
pre-market, hourly checks, power hour, close review, Sunday weekly plan). It runs the same cycle with
the same risk gate (`bin/autopilot.mjs`), sends orders through your Robinhood connector, and writes
plans and journals back to the page. Ask Claude Code to "arm the Crow's Nest autopilot" to set it up,
or "disarm" it to stop. Each check-in runs four agents, which uses your Claude usage.

### 3. Self-hosted (paper trading, Claude API)

```bash
cd crowsnest
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start      # http://localhost:4000
```

Paper trading at Yahoo Finance prices (may be delayed), Claude through the Anthropic API
(`claude-opus-5-5`, override with `CLAUDE_MODEL`). Turn on **Run the desk on schedule from this
server** in Settings and it runs every check-in automatically and checks exits every minute while the
market is open. The server listens on 127.0.0.1 only; put it behind your own authentication before
exposing it. Server-side refusal fallback is on by default; set `CLAUDE_FALLBACKS=off` to disable it.

## Code map

```
core/          Shared engine (browser and Node, no dependencies)
  desk.js        the cycle, execution, exits, chat, journal
  agents.js      the four agents' prompts and JSON contracts
  risk.js        the risk gate and exit rules
  modes.js       the five risk modes
  patterns.js    chart/candlestick patterns, levels, scoring, projection
  indicators.js  SMA/EMA/RSI/MACD/Bollinger/ATR/ADX/stochastic/VWAP/OBV
  regime.js      market regime
  options.js     Black-Scholes, Greeks, implied vol, contract ranking, spread risk
  planner.js     check-in schedule, week events, hour-by-hour timeline
  market-clock.js  NYSE hours, holidays, early closes, expirations
  paper.js       paper broker
  academy.js     lessons, quizzes, glossary
adapters/      hosted.js (claude.ai: sample + Robinhood connector + db), local.js (self-hosted),
               robinhood-map.js (connector payloads ↔ desk shapes)
web/           index.html, styles.css, app.js (UI), charts.js
server.js      self-hosted server; server/ (Claude API, Yahoo data, file store)
bin/autopilot.mjs  background autopilot helper; AUTOPILOT.md is its playbook
test/          npm test
```
