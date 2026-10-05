// Coaching content: strategy lessons, glossary, tips, and context-aware trade feedback.
import { daysToExpiry, greeks, OPTION_MULTIPLIER } from './engine.js';

export const STRATEGIES = [
  {
    id: 'buy-hold',
    name: 'Buy & Hold (Long Stock)',
    level: 'Beginner',
    outlook: 'Bullish, long term',
    risk: 'Stock can fall to $0 (lose what you invested)',
    reward: 'Unlimited upside',
    what: 'Buy shares of a company you believe will grow and hold them for months or years. This is the foundation of investing.',
    when: 'You like the business and are willing to ride out normal ups and downs. Works best with broad, high-quality companies or index ETFs like SPY, VOO or QQQ.',
    how: [
      'Search for a ticker (e.g. SPY or AAPL) in the left panel and click it.',
      'In the Order Ticket choose Stock → Buy, order type Market.',
      'Enter the number of shares. Check “Est. cost” stays well under your buying power.',
      'Click Review → Place order. Your shares appear under Portfolio.',
    ],
    where: 'Size each position so no single stock is more than ~10–20% of your account. Consider buying in pieces over time (dollar-cost averaging) instead of all at once.',
    tips: ['Index ETFs give instant diversification.', 'Time in the market usually beats timing the market.'],
  },
  {
    id: 'stop-loss',
    name: 'Swing Trade with a Stop-Loss',
    level: 'Beginner',
    outlook: 'Bullish, days to weeks',
    risk: 'Limited by your stop (gaps can slip past it)',
    reward: 'Your target, typically 2–3× the risk',
    what: 'Enter a stock you expect to rise over days or weeks, and immediately set a stop-loss order that sells automatically if the trade goes against you.',
    when: 'The stock is in an uptrend (price above its 50-day average) and has pulled back toward support, or just broke out above resistance.',
    how: [
      'Buy the shares with a Market or Limit order.',
      'Then in the Order Ticket choose Sell, order type Stop, and enter your stop price.',
      'Optionally place a Sell Limit order at your profit target.',
      'Watch the Orders tab — when price hits a level, the order fills automatically.',
    ],
    where: 'Place the stop just below a recent swing low or support level — commonly 5–8% under your entry. Your target should be at least 2× as far away as your stop (2:1 reward-to-risk).',
    tips: ['Risk only 1–2% of your account per trade: shares = (account × 1%) ÷ (entry − stop).', 'Never move a stop further away to “give it room.”'],
  },
  {
    id: 'limit-entry',
    name: 'Limit Order Entry',
    level: 'Beginner',
    outlook: 'Any',
    risk: 'Order may never fill',
    reward: 'Better entry price, no surprise fills',
    what: 'A limit order only fills at your price or better. Buy limits sit below the current price; sell limits sit above it.',
    when: 'Prices are volatile, the bid/ask spread is wide (very common in options), or you only want in at a specific support level.',
    how: [
      'In the Order Ticket choose order type Limit.',
      'Enter your limit price (below the market to buy, above it to sell).',
      'Place the order — it shows as “working” in the Orders tab until it fills or you cancel it.',
    ],
    where: 'For stocks: near a support level or the 20/50-day moving average. For options: start at the mid-price between bid and ask and adjust by a few cents.',
    tips: ['Always use limit orders for options — spreads can be wide.'],
  },
  {
    id: 'long-call',
    name: 'Long Call',
    level: 'Intermediate',
    outlook: 'Bullish, with a deadline',
    risk: 'Premium paid (can lose 100%)',
    reward: 'Unlimited',
    what: 'Buy the right to purchase 100 shares at the strike price before expiration. Controls 100 shares for a fraction of the cost, but loses value every day (theta decay).',
    when: 'You expect a meaningful move UP within a specific time window — e.g. ahead of a catalyst. Better when implied volatility (IV) is low.',
    how: [
      'Select a stock and open the Options Chain tab.',
      'Pick an expiration 30–90 days out to give the trade time.',
      'Click the ASK price of a call to load it into the Order Ticket (side: Buy).',
      'Review the breakeven, max loss and payoff chart, then place the order.',
    ],
    where: 'Beginners: choose a strike at-the-money or slightly in-the-money (delta 0.50–0.70). Cheap far out-of-the-money calls (delta < 0.20) usually expire worthless.',
    tips: ['Breakeven = strike + premium paid.', 'Consider taking profits at +50–100% rather than holding to expiration.', 'Avoid buying right before earnings — IV crush can sink the price even if you are right.'],
  },
  {
    id: 'long-put',
    name: 'Long Put',
    level: 'Intermediate',
    outlook: 'Bearish, with a deadline',
    risk: 'Premium paid',
    reward: 'Large (stock can fall to $0)',
    what: 'Buy the right to sell 100 shares at the strike. Profits when the stock falls. A defined-risk way to bet against a stock.',
    when: 'You expect a drop — e.g. a broken support level, a weak sector, or a market pullback.',
    how: [
      'Open the Options Chain for the stock.',
      'Choose an expiration 30–60+ days out.',
      'Click the ASK of a put to load a Buy order.',
      'Check the breakeven (strike − premium) and place the order.',
    ],
    where: 'Strikes at-the-money to slightly in-the-money (delta −0.50 to −0.70) respond best to a move down.',
    tips: ['Puts tend to get expensive after a selloff (IV rises).'],
  },
  {
    id: 'protective-put',
    name: 'Protective Put (Portfolio Insurance)',
    level: 'Intermediate',
    outlook: 'Bullish but worried',
    risk: 'Limited: (stock price − strike) + premium',
    reward: 'Unlimited, minus the premium',
    what: 'Own the shares and buy a put on them. If the stock crashes, the put gains and caps your loss — like insurance.',
    when: 'You want to keep a winning stock through an uncertain event (earnings, macro news) without selling it.',
    how: [
      'Own at least 100 shares of the stock.',
      'Open the Options Chain and pick an expiration covering the event.',
      'Click the ASK of a put (1 contract per 100 shares) and place a Buy.',
    ],
    where: 'A strike 5–10% below the current price is a common balance between cost and protection.',
    tips: ['Insurance costs money — use it selectively, not constantly.'],
  },
  {
    id: 'covered-call',
    name: 'Covered Call',
    level: 'Intermediate',
    outlook: 'Neutral to mildly bullish',
    risk: 'Stock downside (cushioned by the premium)',
    reward: 'Premium + gain up to the strike',
    what: 'Own 100 shares and SELL a call against them to collect premium (income). If the stock rises above the strike, your upside is capped.',
    when: 'You own a stock you expect to drift sideways or rise slowly, and you’re happy to sell it at the strike.',
    how: [
      'Own at least 100 shares (1 contract = 100 shares).',
      'Open the Options Chain, choose an expiration 20–45 days out.',
      'Click the BID of an out-of-the-money call to load a Sell order.',
      'Place the order — premium is credited to your cash immediately, and those shares become “committed”.',
      'Before expiration, buy the call back to close it, or let it expire.',
    ],
    where: 'Strikes above the current price around delta 0.20–0.30 (roughly a 70–80% chance of expiring worthless).',
    tips: ['Many traders buy back the call once it has lost 50% of its value.', 'In this game, an ITM short call at expiration is cash-settled at intrinsic value.'],
  },
  {
    id: 'csp',
    name: 'Cash-Secured Put',
    level: 'Intermediate',
    outlook: 'Neutral to bullish',
    risk: 'Like owning stock from the strike (minus the premium)',
    reward: 'Premium collected',
    what: 'SELL a put while holding enough cash to buy 100 shares at the strike. You are paid to wait to buy a stock at a discount.',
    when: 'You want to own a stock but only at a lower price.',
    how: [
      'Make sure you have strike × 100 in buying power per contract.',
      'Open the Options Chain and choose an expiration 20–45 days out.',
      'Click the BID of an out-of-the-money put to load a Sell order.',
      'Place it — the premium is credited and the collateral is reserved (see “Reserved” in the header).',
    ],
    where: 'A strike at a support level you’d genuinely be happy to buy at, typically delta −0.20 to −0.30.',
    tips: ['Only sell puts on stocks you actually want to own.'],
  },
];

export const GLOSSARY = [
  ['Market order', 'Fills immediately at the best available price. Fast, but you don’t control the price.'],
  ['Limit order', 'Fills only at your price or better. Controls price; may not fill.'],
  ['Stop (stop-loss)', 'Becomes a market sell when the price falls to your stop price. Limits losses.'],
  ['Bid / Ask', 'Bid = highest price buyers will pay. Ask = lowest price sellers accept. You buy at the ask and sell at the bid.'],
  ['Spread', 'Ask − Bid. A wide spread is a hidden cost — use limit orders.'],
  ['Call option', 'The right to BUY 100 shares at the strike price before expiration.'],
  ['Put option', 'The right to SELL 100 shares at the strike price before expiration.'],
  ['Strike', 'The price at which the option lets you buy (call) or sell (put) the shares.'],
  ['Premium', 'The option’s price, quoted per share. Total cost = premium × 100 × contracts.'],
  ['ITM / ATM / OTM', 'In-, at-, or out-of-the-money. A call is ITM when the stock is above the strike; a put when it is below.'],
  ['Intrinsic value', 'What the option would be worth if exercised now. Everything else is time value.'],
  ['Delta', 'How much the option moves per $1 move in the stock. Also a rough probability of finishing ITM.'],
  ['Theta', 'How much value the option loses per day from time decay. Hurts buyers, helps sellers.'],
  ['IV (implied volatility)', 'The market’s expectation of future movement. High IV = expensive options.'],
  ['Open interest', 'Number of open contracts. Higher OI usually means a tighter, more liquid market.'],
  ['Buying power', 'Cash available to open new trades (cash minus collateral reserved for short puts).'],
  ['Realized P/L', 'Profit or loss locked in by closing trades.'],
  ['Unrealized P/L', 'Paper profit or loss on positions you still hold.'],
];

export const TIPS = [
  'Plan the trade, trade the plan: decide your entry, stop and target BEFORE you click buy.',
  'Risk 1–2% of your account per trade. With $100,000 that’s $1,000–$2,000 you can lose if the stop hits.',
  'Use limit orders for options. Start at the mid-price between bid and ask.',
  'Options lose value every day (theta). Give your thesis time: 30–90 days for beginners.',
  'Cheap out-of-the-money options look tempting, but most expire worthless.',
  'Diversify: no single position should be able to wreck your account.',
  'A stock above its 50-day and 200-day moving averages is in an uptrend — trade with the trend.',
  'Losses are part of trading. Cut losers quickly and let winners run.',
  'Implied volatility usually collapses right after earnings (“IV crush”). Be careful buying options right before earnings.',
  'Keep a trading journal. Review your History tab: what worked, and what didn’t?',
  'Reward-to-risk of at least 2:1 means you can be wrong more than half the time and still profit.',
  'Don’t revenge trade after a loss. Take a break and stick to your rules.',
  'Covered calls and cash-secured puts generate income, but cap your upside or obligate you to buy.',
  'High volume and open interest = easier to get in and out at fair prices.',
  'Index ETFs (SPY, QQQ, VOO) are a great place to practice — they move smoother than single stocks.',
  'The market is open 9:30am–4:00pm Eastern, Monday to Friday. Outside those hours, prices are the last close.',
];

export function randomTip(exclude) {
  const pool = TIPS.filter((t) => t !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

const money = (n) => `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Context-aware coaching for a pending order. Returns [{ level: 'good'|'info'|'warn', text }].
 * ctx: { asset, side, orderType, qty, price, quote, summary, position, contract, optionQuote, marketOpen }
 */
export function reviewOrder(ctx) {
  const out = [];
  const { asset, side, qty, price, quote, summary, position, orderType } = ctx;
  const equity = summary?.equity || 1;
  if (!ctx.marketOpen) {
    out.push({ level: 'info', text: 'The market is closed right now. Market orders fill instantly at the last available price — in real life they’d wait for the next open.' });
  }

  if (asset === 'stock') {
    const cost = qty * price;
    const pct = (cost / equity) * 100;
    if (side === 'buy') {
      if (pct > 25) out.push({ level: 'warn', text: `This is ${pct.toFixed(0)}% of your account in one stock. Pros usually keep a single position under 10–20%.` });
      else if (pct > 0) out.push({ level: 'good', text: `Position size: ${pct.toFixed(1)}% of your account — reasonable diversification.` });
      if (quote?.fiftyDayAverage && quote?.twoHundredDayAverage) {
        if (price > quote.fiftyDayAverage && price > quote.twoHundredDayAverage)
          out.push({ level: 'good', text: 'Price is above its 50- and 200-day averages — you’re buying with the trend.' });
        else if (price < quote.fiftyDayAverage && price < quote.twoHundredDayAverage)
          out.push({ level: 'warn', text: 'Price is below its 50- and 200-day averages (downtrend). Buying here is “catching a falling knife” — use a tight stop.' });
      }
      if (orderType !== 'stop') {
        const stop = price * 0.93;
        out.push({ level: 'info', text: `After buying, consider a stop-loss around ${money(stop)} (7% below). Risk on this trade would be ≈ ${money((price - stop) * qty)}.` });
      }
      if (quote?.earningsTimestamp) {
        const days = (quote.earningsTimestamp * 1000 - Date.now()) / 86400000;
        if (days > 0 && days < 14) out.push({ level: 'warn', text: `Earnings in ~${Math.ceil(days)} days. Expect a big move either way.` });
      }
    } else if (position) {
      const pl = (price - position.avgCost) * qty;
      if (orderType === 'stop') out.push({ level: 'good', text: `Stop-loss: protects you if ${position.symbol} drops to ${money(price)}. Locks in ${pl >= 0 ? 'a gain' : 'a loss'} of ≈ ${money(pl)} if it fills there.` });
      else if (pl >= 0) out.push({ level: 'good', text: `Selling locks in ≈ ${money(pl)} profit. Taking profits is never a bad trade.` });
      else out.push({ level: 'info', text: `Selling realizes a ≈ ${money(pl)} loss. Cutting a losing trade early protects your capital — just make sure it’s your plan, not panic.` });
    }
  }

  if (asset === 'option' && ctx.contract) {
    const c = ctx.contract;
    const q = ctx.optionQuote || {};
    const dte = daysToExpiry(c.expiration);
    const S = quote?.price;
    const g = S ? greeks({ S, K: c.strike, T: Math.max(dte, 0.5) / 365, iv: q.iv, right: c.right }) : null;
    const opening = !(position && ((side === 'sell' && position.qty > 0) || (side === 'buy' && position.qty < 0)));
    const cost = price * OPTION_MULTIPLIER * qty;

    if (opening && side === 'buy') {
      if (dte < 7) out.push({ level: 'warn', text: `Only ${dte.toFixed(1)} days to expiration. Time decay is fastest now — this is closer to a lottery ticket than an investment.` });
      else if (dte < 21) out.push({ level: 'info', text: `${Math.round(dte)} days to expiration. Decay speeds up in the final 3 weeks; leave yourself time to be right.` });
      else out.push({ level: 'good', text: `${Math.round(dte)} days to expiration gives your idea time to work.` });
      if (g && Math.abs(g.delta) < 0.2) out.push({ level: 'warn', text: `Delta ${g.delta.toFixed(2)}: this is far out-of-the-money. Roughly a ${(g.probITM * 100).toFixed(0)}% chance of finishing in the money.` });
      else if (g) out.push({ level: 'info', text: `Delta ${g.delta.toFixed(2)}: the option moves ≈ $${Math.abs(g.delta).toFixed(2)} per $1 move in ${c.symbol}. Theta ≈ −$${Math.abs(g.theta * 100).toFixed(2)}/day per contract.` });
      const pct = (cost / equity) * 100;
      if (pct > 5) out.push({ level: 'warn', text: `You’re risking ${pct.toFixed(1)}% of your account on this option (you can lose 100% of it). Many traders cap single option bets at 2–5%.` });
    }
    if (opening && side === 'sell') {
      if (g) out.push({ level: 'info', text: `Delta ${g.delta.toFixed(2)}: about a ${(g.probITM * 100).toFixed(0)}% chance this finishes in the money (and you get assigned).` });
      out.push({ level: 'good', text: `You collect ${money(cost)} premium up front. Common plan: buy it back once you’ve captured ~50% of that.` });
    }
    if (q.bid > 0 && q.ask > 0) {
      const mid = (q.bid + q.ask) / 2;
      const spread = (q.ask - q.bid) / mid;
      if (spread > 0.1) out.push({ level: 'warn', text: `Wide spread (${(spread * 100).toFixed(0)}% of the price). Use a Limit order near the mid of $${mid.toFixed(2)} instead of a market order.` });
    } else if (q.last) {
      out.push({ level: 'info', text: 'No live bid/ask right now, so the fill uses the last traded price.' });
    }
    if (q.openInterest !== undefined && q.openInterest < 100) out.push({ level: 'warn', text: `Low open interest (${q.openInterest}). Illiquid contracts can be hard to exit at a fair price.` });
  }
  return out;
}

/** Feedback right after a fill. */
export function afterTrade(trade) {
  if (trade.kind === 'expiration') return trade.note;
  if (trade.asset === 'stock' && trade.side === 'buy') return `Bought ${trade.qty} ${trade.symbol}. Next step: set a stop-loss (Sell → Stop) so a bad day can’t turn into a disaster.`;
  if (trade.asset === 'option' && trade.action === 'buy_to_open') return 'Option bought. Decide now: at what profit will you take it, and at what loss will you cut it?';
  if (trade.asset === 'option' && trade.action === 'sell_to_open') return 'Premium collected! Track it in Portfolio — buying it back at 50% profit is a common plan.';
  if (trade.realized > 0) return `Nice — you realized ${money(trade.realized)} profit. Review what made this trade work.`;
  if (trade.realized < 0) return `Loss realized: ${money(trade.realized)}. Small, controlled losses are how traders survive. Note what you’d change.`;
  return 'Order filled.';
}
