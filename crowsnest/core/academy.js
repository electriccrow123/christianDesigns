// The Academy: a self-paced course that teaches a beginner to trade stocks and options and to read
// what the AI desk is doing. Lessons are plain data so the UI and the AI tutor can both use them.

export const MODULES = [
  { id: 'basics', name: 'Foundations', blurb: 'How buying and selling actually works.' },
  { id: 'charts', name: 'Reading charts', blurb: 'Trends, levels, candles and patterns.' },
  { id: 'market', name: 'The market’s mood', blurb: 'Bull, bear, choppy: and what to do in each.' },
  { id: 'options', name: 'Options', blurb: 'Calls, puts, the Greeks and the core strategies.' },
  { id: 'risk', name: 'Risk & mindset', blurb: 'The part that decides who survives.' },
  { id: 'desk', name: 'Your AI desk', blurb: 'How Crow’s Nest makes and checks its decisions.' },
];

export const LESSONS = [
  // ------------------------------------------------------------ Foundations
  {
    id: 'orders',
    module: 'basics',
    title: 'Bid, ask and order types',
    minutes: 6,
    body: [
      'Every stock has two prices at any moment. The bid is the highest price a buyer is offering right now. The ask is the lowest price a seller will accept. The gap between them is the spread. When you buy "at market" you pay the ask; when you sell at market you get the bid. On busy stocks like Apple the spread is a penny; on thinly traded stocks and many options it can be large.',
      'A market order says "fill me now at whatever the price is." It almost always fills, but you do not control the price. A limit order says "fill me only at this price or better." You control the price, but it might not fill.',
      'A stop order sits quietly until the price touches your stop level, then becomes a market order. Traders use a sell stop under their entry as a safety net (a stop-loss). A stop-limit becomes a limit order instead, which protects the price but may not fill in a fast drop. An OCO (one-cancels-other) pairs a profit-taking limit with a stop-loss: whichever fills first cancels the other.',
      'Robinhood also lets you buy fractional shares by dollar amount (for example $5 of a $300 stock). Those go in as market orders during regular hours (9:30 am to 4:00 pm New York time). Day orders (GFD) expire at the close; good-till-canceled (GTC) orders stay working.',
    ],
    keyPoints: ['Buy at the ask, sell at the bid; the spread is a hidden cost.', 'Limit orders control price; market orders control speed.', 'A stop-loss is a pre-planned exit, set when you enter.'],
    example: 'A stock shows bid $49.98 / ask $50.02. A market buy of 10 shares costs about $500.20. A limit buy at $49.90 only fills if a seller comes down to $49.90.',
    quiz: [
      { q: 'You place a market order to BUY. Which price do you pay?', choices: ['The bid', 'The ask', 'The last trade', 'The day’s low'], answer: 1, explain: 'Buyers take the sellers’ offer: the ask.' },
      { q: 'Which order guarantees your price but not a fill?', choices: ['Market', 'Stop', 'Limit', 'Dollar-based'], answer: 2, explain: 'A limit only fills at your price or better.' },
      { q: 'What does an OCO do?', choices: ['Buys and sells at once', 'Pairs a target and a stop; one filling cancels the other', 'Cancels all orders', 'Converts to market at the close'], answer: 1, explain: 'One-cancels-other brackets a position with a profit target and a stop-loss.' },
    ],
  },
  {
    id: 'sizing',
    module: 'basics',
    title: 'Position size and reward-to-risk',
    minutes: 6,
    body: [
      'How much you buy matters more than what you buy. Professional traders decide the dollars they are willing to lose on a trade first, then work out the size.',
      'The formula: shares = (account × risk %) ÷ (entry price − stop price). With a $10,000 account risking 1% ($100), buying at $50 with a stop at $47 ($3 of risk per share), you buy about 33 shares. If the stop hits, you lose about $100, not your whole stake.',
      'Reward-to-risk compares how far your target is to how far your stop is. Entry $50, stop $47, target $56 means you risk $3 to make $6: 2-to-1. At 2-to-1 you can be wrong more than half the time and still come out ahead.',
      'Crow’s Nest sizes every trade as a percent of the account, and the risk gate caps it by the active mode. In a small account, positions may become fractional dollar orders.',
    ],
    keyPoints: ['Decide the loss you accept before the gain you hope for.', 'Aim for at least 2:1 reward-to-risk.', 'Smaller size = more chances to be right.'],
    example: '$2,000 account, 2% risk = $40. Entry $20, stop $19 → $1 risk per share → 40 shares ($800 position).',
    quiz: [
      { q: 'Account $5,000, risk 1%, entry $25, stop $24. How many shares?', choices: ['25', '50', '100', '200'], answer: 1, explain: '$50 risk ÷ $1 per share = 50 shares.' },
      { q: 'Entry $10, stop $9, target $13. Reward-to-risk?', choices: ['1:1', '2:1', '3:1', '1:3'], answer: 2, explain: 'Risk $1 to make $3.' },
    ],
  },
  // ------------------------------------------------------------ Charts
  {
    id: 'candles',
    module: 'charts',
    title: 'Candlesticks',
    minutes: 7,
    body: [
      'Each candle shows one period (a day, an hour, five minutes). The thick body runs from the open to the close: green if it closed higher than it opened, red if lower. The thin wicks show the high and low.',
      'Long wicks show rejection. A long lower wick means sellers pushed price down but buyers pushed it back up (a "hammer" after a decline is a classic bounce sign). A long upper wick after a rally ("shooting star") means buyers got rejected.',
      'Engulfing patterns: a green body that completely covers the previous red body signals buyers took over (bullish engulfing). The reverse is bearish engulfing. A doji (open ≈ close) is indecision.',
      'Three-candle signals: a morning star (big red, small pause, big green) can mark a bottom; an evening star marks a top. Three white soldiers / three black crows are strong momentum runs.',
      'Candles are clues, not guarantees. They matter most at important levels (support, resistance) and with higher volume.',
    ],
    keyPoints: ['Body = open to close; wicks = high and low.', 'Long wicks = rejection.', 'Context (where the candle forms) matters more than the candle.'],
    quiz: [
      { q: 'A hammer appears after a long decline at support. What is the usual read?', choices: ['Bearish continuation', 'Possible bounce: buyers rejected lower prices', 'No meaning', 'Stock will gap down'], answer: 1, explain: 'The long lower wick shows buyers stepped in.' },
      { q: 'A doji shows…', choices: ['Strong buying', 'Strong selling', 'Indecision', 'A dividend'], answer: 2, explain: 'Open and close are nearly equal.' },
    ],
  },
  {
    id: 'trend',
    module: 'charts',
    title: 'Trend and moving averages',
    minutes: 6,
    body: [
      'An uptrend is a series of higher highs and higher lows. A downtrend is lower highs and lower lows. Trading with the trend is easier than fighting it.',
      'Moving averages smooth the noise. The 50-day average shows the medium-term trend; the 200-day shows the long-term trend. Price above both is healthy; below both is weak.',
      'When the 50-day crosses above the 200-day it is called a golden cross (long-term trend upgrade). The opposite is a death cross. These are slow signals: good for context, late for timing.',
      'ADX measures trend strength (not direction): above 25 is a strong trend, under 18 is a weak or choppy market. In strong trends, buy pullbacks; in choppy markets, trade the range or stay small.',
    ],
    keyPoints: ['Higher highs + higher lows = uptrend.', 'Price vs. 50/200-day averages gives quick context.', 'ADX > 25 = strong trend.'],
    quiz: [
      { q: 'Which describes an uptrend?', choices: ['Lower highs, lower lows', 'Higher highs, higher lows', 'Flat highs, falling lows', 'Random'], answer: 1, explain: 'Each swing is higher than the last.' },
      { q: 'A golden cross is…', choices: ['RSI above 70', '50-day average crossing above the 200-day', 'Price hitting a 52-week high', 'An earnings beat'], answer: 1, explain: 'A long-term trend upgrade signal.' },
    ],
  },
  {
    id: 'levels',
    module: 'charts',
    title: 'Support, resistance and breakouts',
    minutes: 6,
    body: [
      'Support is a price area where buyers have stepped in before, stopping declines. Resistance is where sellers have stopped rallies. The more times a level holds, the more traders watch it.',
      'When price closes above resistance on strong volume, that is a breakout; old resistance often becomes new support. A close below support is a breakdown.',
      'Many breakouts fail. Confirmation helps: a close (not just an intraday poke) beyond the level, volume well above average, and the broader market cooperating.',
      'Levels make great places for stops: just under support for a long, just over resistance for a put or short-biased trade.',
    ],
    keyPoints: ['Levels are zones, not exact pennies.', 'Breakouts need volume and a close.', 'Put stops on the other side of a level.'],
    quiz: [
      { q: 'Where would you place a stop on a long trade bought near support at $40?', choices: ['$45', 'Just under $40, e.g. $39.20', '$40.50', 'No stop needed'], answer: 1, explain: 'If support breaks, the reason for the trade is gone.' },
    ],
  },
  {
    id: 'patterns',
    module: 'charts',
    title: 'Chart patterns the Scout looks for',
    minutes: 8,
    body: [
      'Bull flag: a sharp rise (the pole) followed by a short, tight drift sideways or slightly down on lighter volume (the flag). A push out of the top of the flag often starts another leg up. Bear flag is the mirror image.',
      'Double top: price fails twice at about the same high, with a dip between. A close below that dip (the neckline) confirms it, and the usual target is the pattern’s height projected down. Double bottom is the bullish mirror.',
      'Head and shoulders: three peaks with the middle highest. Breaking the neckline is bearish. The inverse version (three troughs) is bullish.',
      'Triangles: an ascending triangle (flat ceiling, rising lows) tends to break up; descending (flat floor, falling highs) tends to break down; symmetrical triangles usually break in the direction of the prior trend.',
      'Bollinger squeeze: when the bands get unusually narrow, volatility is low and a big move often follows. The breakout direction is the signal.',
      'Divergence: price makes a new low but RSI does not (bullish), or price makes a new high but RSI does not (bearish). It warns that momentum is fading.',
    ],
    keyPoints: ['Patterns are probabilities, not promises.', 'Wait for the trigger (a break of the key level).', 'Measured-move targets give a starting profit target.'],
    quiz: [
      { q: 'What confirms a double top?', choices: ['A third high', 'A close below the neckline (the dip between the peaks)', 'RSI above 70', 'High volume on the second peak'], answer: 1, explain: 'Until the neckline breaks it is only a possible double top.' },
      { q: 'An ascending triangle has…', choices: ['A flat ceiling and rising lows', 'A flat floor and falling highs', 'Two equal lows', 'Three peaks'], answer: 0, explain: 'Buyers keep stepping in higher under a fixed ceiling.' },
    ],
  },
  {
    id: 'momentum',
    module: 'charts',
    title: 'RSI, MACD and volume',
    minutes: 6,
    body: [
      'RSI (0–100) measures how strong recent gains are versus losses. Above 70 is "overbought," below 30 "oversold." Strong stocks can stay overbought for weeks, so treat it as a caution light, not a sell signal.',
      'MACD compares a fast and a slow moving average. When the MACD line crosses above its signal line, short-term momentum is turning up; crossing below is turning down.',
      'Volume is the fuel. Moves on 1.5–2× normal volume carry more weight than moves on light volume.',
      'ATR (average true range) is the typical daily move in dollars. Stops tighter than about one ATR get hit by normal noise.',
    ],
    keyPoints: ['RSI extremes = caution, not commands.', 'MACD crossovers time momentum shifts.', 'Respect ATR when setting stops.'],
    quiz: [
      { q: 'A stock’s ATR is $2. A stop $0.50 below entry is…', choices: ['Well placed', 'Likely to be hit by normal noise', 'Too wide', 'Required by law'], answer: 1, explain: 'Normal daily movement is about $2.' },
    ],
  },
  // ------------------------------------------------------------ Market mood
  {
    id: 'regime',
    module: 'market',
    title: 'Bull, bear, choppy: reading the regime',
    minutes: 6,
    body: [
      'Most stocks move with the overall market, so the first question each day is "what kind of market is this?" Crow’s Nest computes a regime from the S&P 500 (SPY), Nasdaq-100 (QQQ), small caps (IWM), breadth (how many stocks are above their 50-day average) and volatility.',
      'Bull: trend up, broad participation. Favor buying pullbacks and calls; let winners run. Bear: trend down. Avoid buying dips; puts or cash. Neutral/range: buy support, sell resistance, consider income trades like covered calls. Choppy and volatile: the hardest market; trade less and smaller.',
      'Volatility changes how big your stops and positions should be. When the VIX (the market’s fear gauge) jumps, normal swings get bigger, so size down.',
    ],
    keyPoints: ['Ask what kind of market it is before picking stocks.', 'Breadth shows whether a rally is broad or narrow.', 'Higher volatility = smaller size.'],
    quiz: [
      { q: 'In a choppy, volatile market the best adjustment is usually…', choices: ['Trade more', 'Use bigger positions', 'Trade less, smaller, with defined risk', 'Remove stops'], answer: 2, explain: 'Protect capital until conditions improve.' },
    ],
  },
  {
    id: 'events',
    module: 'market',
    title: 'Earnings, the Fed and expiration days',
    minutes: 5,
    body: [
      'Earnings reports can move a stock 5–20% overnight. Before earnings, options get expensive because everyone knows a move is coming. Right after, implied volatility collapses ("IV crush"), so option buyers can lose money even when they guess the direction right.',
      'Fed rate decisions (2:00 pm New York time on announcement days) can swing the whole market in minutes. Many traders reduce size into the announcement.',
      'Monthly options expire on the third Friday; quarterly ones in March, June, September and December ("triple witching") can bring heavy volume and odd moves near the close.',
      'The Planner tab marks these events on your week so the agents and you can plan around them.',
    ],
    keyPoints: ['Earnings = big gaps and IV crush.', 'Fed days = afternoon volatility.', 'Check the calendar before entering.'],
    quiz: [
      { q: 'You buy a call before earnings, the stock rises 2%, and your call still loses money. Why?', choices: ['Bad luck', 'IV crush: option prices deflated after the report', 'Robinhood fees', 'The call expired'], answer: 1, explain: 'The pre-earnings premium evaporated.' },
    ],
  },
  // ------------------------------------------------------------ Options
  {
    id: 'calls-puts',
    module: 'options',
    title: 'Calls and puts in plain English',
    minutes: 8,
    body: [
      'A call option is the right (not the obligation) to buy 100 shares at a set price (the strike) until a set date (the expiration). You buy calls when you think the stock will rise. A put is the right to sell 100 shares at the strike; you buy puts when you think it will fall.',
      'Option prices are quoted per share, but each contract covers 100 shares. A call quoted at $2.50 costs $250. If you buy it, the most you can lose is that $250.',
      'In the money (ITM): a call with a strike below the stock price, or a put with a strike above it. Out of the money (OTM): the opposite. At the money (ATM): strike ≈ stock price.',
      'Breakeven at expiration for a call = strike + premium. For a put = strike − premium. The stock has to move past breakeven, in time, for the trade to profit at expiration.',
      'You can sell an option you own before expiration. Most traders close options early rather than holding to the end.',
    ],
    keyPoints: ['1 contract = 100 shares; multiply the quote by 100.', 'Buyer’s max loss = premium paid.', 'Breakeven = strike ± premium.'],
    example: 'Stock at $100. Buy the $105 call for $2.00 ($200). Breakeven at expiration = $107. At $112 the call is worth $7 ($700): +$500. At $104 or below it expires worthless: −$200.',
    quiz: [
      { q: 'A put is quoted at $1.40. What does one contract cost?', choices: ['$1.40', '$14', '$140', '$1,400'], answer: 2, explain: '$1.40 × 100 shares.' },
      { q: 'Breakeven for a $50 call bought for $3?', choices: ['$47', '$50', '$53', '$56'], answer: 2, explain: 'Strike + premium.' },
      { q: 'You think a stock will fall. Which do you buy?', choices: ['Call', 'Put', 'Covered call', 'Nothing works'], answer: 1, explain: 'Puts gain value as the stock falls.' },
    ],
  },
  {
    id: 'greeks',
    module: 'options',
    title: 'The Greeks, IV and expected move',
    minutes: 8,
    body: [
      'Delta: how much the option moves for a $1 move in the stock. A 0.50 delta call gains about $0.50 ($50 per contract) when the stock rises $1. Delta is also a rough probability the option finishes in the money.',
      'Theta: time decay. Options lose value every day, faster as expiration approaches. A −0.05 theta means about $5 per contract per day lost if nothing else changes.',
      'Vega: sensitivity to implied volatility. When fear rises, option prices rise even if the stock does not move.',
      'Implied volatility (IV) is the market’s forecast of how much the stock will move, built into option prices. From IV you get the expected move: price × IV × √(days ÷ 365). A $100 stock with 40% IV has an expected move of about ±$6.60 over the next 10 days.',
      'Gamma: how fast delta changes. It is largest for near-the-money options close to expiration, which is why same-day (0DTE) options swing so violently.',
    ],
    keyPoints: ['Delta = speed and rough odds.', 'Theta = daily rent you pay as a buyer.', 'High IV = expensive options; plan for IV crush.'],
    quiz: [
      { q: 'A call has delta 0.30. The stock rises $2. The option rises about…', choices: ['$0.30', '$0.60', '$2.00', '$30'], answer: 1, explain: '0.30 × $2 = $0.60 per share ($60 per contract).' },
      { q: 'Which Greek is the daily time decay?', choices: ['Delta', 'Gamma', 'Theta', 'Vega'], answer: 2, explain: 'Theta.' },
    ],
  },
  {
    id: 'strategies',
    module: 'options',
    title: 'The core strategies',
    minutes: 10,
    body: [
      'Long call / long put: simple directional bets with a known max loss (the premium). Need a big enough move, soon enough.',
      'Debit spread: buy one option and sell a further out-of-the-money option on the same expiration. Cheaper than a single option and less hurt by IV crush, in exchange for capped profit. Max loss = the net debit; max gain = width − debit.',
      'Covered call: own 100 shares and sell a call above the price. You collect income; the trade-off is your shares get sold if the stock rises past the strike.',
      'Cash-secured put: sell a put at a price where you would happily buy the stock, with cash set aside to buy it. You collect premium; if the stock falls below the strike you buy 100 shares at the strike.',
      'Credit spread: sell an option and buy a further one for protection. You collect premium betting the stock stays on one side of the short strike. Max loss = width − credit.',
      'Crow’s Nest’s modes unlock these progressively: Fortress uses none, Steady adds covered calls and cash-secured puts, Balanced and up add directional calls, puts and spreads.',
    ],
    keyPoints: ['Spreads trade upside for a lower cost and defined risk.', 'Selling premium wins often but small; buying premium wins rarely but big.', 'Only sell options you are prepared to be assigned on.'],
    quiz: [
      { q: 'Max loss on a call debit spread bought for $1.20?', choices: ['Unlimited', '$1.20 per share ($120 per spread)', 'The width', 'Zero'], answer: 1, explain: 'A debit spread can lose only what you paid.' },
      { q: 'A covered call requires owning…', choices: ['10 shares', '100 shares per contract', 'A put', 'Nothing'], answer: 1, explain: 'Each call contract covers 100 shares.' },
    ],
  },
  {
    id: 'contracts',
    module: 'options',
    title: 'Choosing a contract (and why 0DTE is dangerous)',
    minutes: 6,
    body: [
      'Three choices define a contract: strike, expiration, and call or put. Beginners do better with delta 0.40–0.70 (at or slightly in the money) and 3–8 weeks to expiration: enough time to be right.',
      'Liquidity matters: look for a bid-ask spread under about 10% of the mid price and open interest in the hundreds or more. Wide spreads mean you lose money the moment you buy.',
      'Cheap far out-of-the-money contracts (delta under 0.15) are lottery tickets: they usually expire worthless. Same-day expiration (0DTE) options can double or go to zero within an hour. Crow’s Nest only allows those in Moonshot mode.',
    ],
    keyPoints: ['More time = more forgiveness.', 'Delta 0.40–0.70 for directional trades.', 'Check the spread before you click.'],
    quiz: [
      { q: 'Which is usually the better beginner contract?', choices: ['Delta 0.08, expires tomorrow', 'Delta 0.55, 35 days out', 'Delta 0.95, expires today', 'Any'], answer: 1, explain: 'Reasonable odds and time to work.' },
    ],
  },
  // ------------------------------------------------------------ Risk & mindset
  {
    id: 'exits',
    module: 'risk',
    title: 'Exits: cutting losers, keeping winners',
    minutes: 6,
    body: [
      'Decide your exit before you enter: where you are wrong (stop) and where you take profit (target). Then follow it. The worst losses come from "I’ll wait for it to come back."',
      'Never widen a stop to avoid taking a loss. You may tighten it (move it in your favor) as the trade works; that is a trailing stop.',
      'Taking partial profits at a first target and letting the rest run with a raised stop balances greed and fear.',
      'Every Crow’s Nest position carries an exit plan, and the code checks it on every refresh, even if the agents are busy.',
    ],
    keyPoints: ['Plan the exit first.', 'Never move a stop further away.', 'Small losses are the cost of doing business.'],
    quiz: [
      { q: 'Your stock trade hits its stop. The best response is…', choices: ['Move the stop lower', 'Buy more to average down', 'Exit as planned and review', 'Turn off alerts'], answer: 2, explain: 'The plan said you were wrong at this price.' },
    ],
  },
  {
    id: 'psychology',
    module: 'risk',
    title: 'Trading psychology and the PDT rule',
    minutes: 6,
    body: [
      'FOMO (fear of missing out) makes people chase stocks that already ran. Revenge trading after a loss doubles the damage. A written plan and a daily loss limit are the cure; Crow’s Nest enforces both.',
      'Keep a journal: what you did, why, and what you learned. The AI desk writes one for every cycle; read it like a coach’s notes.',
      'Pattern Day Trader rule: in a margin account under $25,000, making four or more day trades (buy and sell the same security the same day) in five business days can get the account restricted. The risk gate counts day trades and warns you. Robinhood’s own order review also flags it.',
    ],
    keyPoints: ['A daily loss limit protects you from yourself.', 'Journal everything.', 'Watch the day-trade count under $25k.'],
    quiz: [
      { q: 'In a $5,000 margin account, how many day trades in 5 business days triggers the PDT flag?', choices: ['1', '2', '4', '10'], answer: 2, explain: 'Four or more day trades in five business days.' },
    ],
  },
  // ------------------------------------------------------------ Your desk
  {
    id: 'agents',
    module: 'desk',
    title: 'Meet the four agents',
    minutes: 5,
    body: [
      'Scout reads the charts: trend, levels, patterns and the market regime. Analyst reads the options market (implied volatility, expected moves, liquidity), earnings dates, fundamentals and analyst ratings. Both report to the Head Honcho.',
      'The Head Honcho weighs both reports against your account, open positions, the week’s plan and the active mode, then decides: open, close, trim, hold or watch. It also writes the weekly and daily plans and talks with you in the AI Desk tab.',
      'The Operator turns each decision into an exact order: which contract, how many, what limit price, and the stop and target. It also reviews open positions and can tighten stops.',
      'Finally the risk gate, plain code with no AI, checks every order against the mode’s limits and your hard limits. It can shrink an order or block it, and nothing reaches Robinhood without passing it.',
    ],
    keyPoints: ['Two researchers → Head Honcho decides → Operator builds → risk gate checks.', 'The gate is code, so its limits always hold.', 'Every decision is logged with its reasons in the Agent room.'],
    quiz: [
      { q: 'Who can block an order no matter what the AI says?', choices: ['Scout', 'Analyst', 'The risk gate', 'Nobody'], answer: 2, explain: 'The gate is deterministic code.' },
    ],
  },
  {
    id: 'modes',
    module: 'desk',
    title: 'The five risk modes',
    minutes: 5,
    body: [
      'Fortress (1): big companies and ETFs only, no options, small positions, lots of cash. Steady (2): adds covered calls and cash-secured puts. Balanced (3): adds calls, puts and spreads with 3+ weeks of time. Aggressive (4): momentum names, shorter-dated options, earnings plays. Moonshot (5): same-day options and long shots; expect frequent total losses on individual trades.',
      'The AI can fine-tune some settings inside each mode’s bounds (for example tighter stops when volatility rises). It can never exceed them. You can tighten limits further in Settings.',
      'Higher modes are not "better": they trade a higher chance of big gains for a higher chance of big losses. Many traders practice in Paper mode on the mode they want before going live.',
    ],
    keyPoints: ['Mode = how much risk the desk may take.', 'AI tweaks within bounds; you set the bounds.', 'Test a mode in Paper first.'],
    quiz: [
      { q: 'Which is the lowest mode that allows long calls and puts?', choices: ['Fortress', 'Steady', 'Balanced', 'Moonshot'], answer: 2, explain: 'Balanced (3) adds directional options.' },
    ],
  },
  {
    id: 'reading-intents',
    module: 'desk',
    title: 'Reading the buy/sell plan',
    minutes: 4,
    body: [
      'Every idea becomes an intention on the Desk tab. Click the arrow to see why: the researchers’ evidence, the Head Honcho’s reasoning, the Operator’s ticket, and each risk-gate check.',
      'Status tells you where it is: Watching or Planned (not ready), Ready (waiting for you to press Send), Sent, Waiting for your approval in Robinhood, Filled, or Blocked with the reason.',
      'In live mode with "confirm each order," nothing goes out until you press Send. With automatic sending, orders that pass the gate go straight to Robinhood (and to the Robinhood app for approval if you turned approvals on there).',
    ],
    keyPoints: ['Arrow = full reasoning.', 'Status = where the order is.', 'You choose confirm-each or automatic.'],
    quiz: [
      { q: 'An intention says "Blocked by risk gate." What happened?', choices: ['Robinhood rejected it', 'The code stopped it for breaking a limit; the reason is listed', 'It filled', 'It is waiting for you'], answer: 1, explain: 'Open it to see which check failed.' },
    ],
  },
];

export const GLOSSARY = [
  ['Ask', 'Lowest price a seller will accept right now.'],
  ['Bid', 'Highest price a buyer will pay right now.'],
  ['Spread (bid-ask)', 'Gap between bid and ask; a hidden trading cost.'],
  ['Market order', 'Fill immediately at the best available price.'],
  ['Limit order', 'Fill only at your price or better.'],
  ['Stop-loss', 'Order that exits a position when price hits a level, to cap a loss.'],
  ['OCO', 'One-cancels-other: a target and a stop paired so one filling cancels the other.'],
  ['GTC / GFD', 'Good-till-canceled vs. good-for-day order duration.'],
  ['Fractional share', 'Part of a share, bought by dollar amount.'],
  ['Support', 'Price area where buying has stopped declines before.'],
  ['Resistance', 'Price area where selling has stopped rallies before.'],
  ['Breakout', 'Close above resistance, ideally on strong volume.'],
  ['Moving average', 'Average closing price over N days (e.g. 50-day, 200-day).'],
  ['Golden / death cross', '50-day average crossing above / below the 200-day.'],
  ['RSI', 'Momentum gauge 0–100; >70 overbought, <30 oversold.'],
  ['MACD', 'Momentum indicator from two moving averages and a signal line.'],
  ['ATR', 'Average true range: the typical daily move in dollars.'],
  ['ADX', 'Trend-strength gauge; above 25 = strong trend.'],
  ['Bollinger Bands', 'Volatility bands around a 20-day average; a squeeze = unusually quiet.'],
  ['VWAP', 'Volume-weighted average price for the day; intraday “fair value.”'],
  ['Breadth', 'How many stocks are participating in a move.'],
  ['VIX', 'Index of expected S&P 500 volatility; the “fear gauge.”'],
  ['Call', 'Right to buy 100 shares at the strike before expiration.'],
  ['Put', 'Right to sell 100 shares at the strike before expiration.'],
  ['Strike', 'The price at which an option lets you buy or sell.'],
  ['Expiration / DTE', 'Last day of an option; DTE = days to expiration.'],
  ['Premium', 'The price of an option (per share; ×100 per contract).'],
  ['ITM / ATM / OTM', 'In, at, or out of the money relative to the stock price.'],
  ['Delta', 'Option’s move per $1 in the stock; rough odds of finishing ITM.'],
  ['Theta', 'Daily time decay of an option’s value.'],
  ['Vega', 'Sensitivity to implied volatility.'],
  ['Gamma', 'How fast delta changes; extreme near expiration.'],
  ['Implied volatility (IV)', 'Market’s forecast of movement, built into option prices.'],
  ['IV crush', 'Sharp drop in option prices after an event like earnings.'],
  ['Expected move', 'Price × IV × √(days/365): the 1-standard-deviation range.'],
  ['Open interest', 'Number of open contracts; a liquidity gauge.'],
  ['Debit spread', 'Buy one option, sell a further OTM one; defined risk.'],
  ['Credit spread', 'Sell one option, buy a further OTM one; collect premium.'],
  ['Covered call', 'Sell a call against 100 shares you own.'],
  ['Cash-secured put', 'Sell a put with cash set aside to buy the shares.'],
  ['0DTE', 'Options expiring the same day; extremely fast and risky.'],
  ['Assignment', 'Being required to fulfill an option you sold.'],
  ['PDT rule', 'Under $25k in margin: 4+ day trades in 5 business days can restrict the account.'],
  ['Drawdown', 'Drop from an account’s peak value.'],
  ['Reward-to-risk', 'Potential gain ÷ potential loss on a trade.'],
  ['Risk gate', 'Crow’s Nest’s code that checks every order against limits before sending.'],
];

export function lessonById(id) {
  return LESSONS.find((l) => l.id === id);
}

export function progressSummary(progress = {}) {
  const done = LESSONS.filter((l) => progress[l.id]?.passed).length;
  const quizScore = LESSONS.reduce((a, l) => a + (progress[l.id]?.score || 0), 0);
  const quizTotal = LESSONS.reduce((a, l) => a + l.quiz.length, 0);
  return { done, total: LESSONS.length, pct: Math.round((100 * done) / LESSONS.length), quizScore, quizTotal };
}
