# IG Charts

A TradingView-style charting workstation for **XAUUSD (Spot Gold)**, **BTCUSD (Bitcoin)** and any other IG market. It uses the IG REST and Streaming (Lightstreamer) APIs and TradingView's open-source Lightweight Charts. The feature set follows TradingView's Ultimate plan wherever IG's data allows.

Your IG credentials stay on the server. The browser only talks to this app.

```
browser ──HTTP/WS──▶ server.js ──REST (login, search, history)──▶ IG
                        │  └──── Lightstreamer (live prices) ◀──── IG
                        └── alerts engine + webhooks (.data/)
```

## Features

**Charts and layouts**
- **Multi-chart layouts:** up to 16 charts per tab, in 14 grid presets.
- **Sync:** symbol, interval, crosshair and scrolling can each be synced across charts.
- **Saved layouts:** up to 10, shown as tabs. You can rename, copy, export or import them, and open a layout in a new window for a second monitor.
- **Symbol linking:** charts in different windows can follow each other's symbol.
- **21 chart types:** bars, candles, hollow candles, volume candles, line, line with markers, step line, area, HLC area, baseline, columns, high-low and Heikin Ashi.
  - **Price-based:** Renko, Line Break, Kagi, Point & Figure, Range.
  - **Profile:** volume footprint, TPO, session volume profile.
- **Intervals:** seconds (1S–45S), minutes, hours, days, weeks, months (1M–12M), tick bars (e.g. `100T`) and range bars (e.g. `10R`). Custom intervals such as `7`, `90`, `2H` or `3D` work too; type one on the chart and press Enter.
- **Spread / formula charts:** type a formula such as `CS.D.CFDGOLD.CFM.IP/CS.D.BITCOIN.CFD.IP` in symbol search.
- **Symbol comparison:** compared symbols switch the price scale to percent automatically.
- **Bar replay:** indicators and AI Chance recompute as each bar is replayed.
- **Price data and scales:** a Bid / Ask / Mid switch, and an inverted price scale.
- **Session breaks and economic events:** dashed lines at each new trading day, and calendar events shown on the chart.
- **Pane management:** move indicators between panes or onto the price chart (own or left scale), merge panes, reorder them, maximise a pane (double-click).
- **Undo:** one undo/redo history covers drawings, indicators and chart settings.
- **Cursors and zoom:** cross, dot, arrow and demonstration cursors, plus a drag-to-zoom tool.

**Analysis**
- **174 indicators** (`/`) in categories, with favourites and saved indicator templates. Up to 50 per chart. Includes order blocks, fair value gaps, market structure (BOS/CHoCH), supply/demand zones, session boxes, divergences and Ehlers filters.
  - **Indicators on indicators:** an indicator can use another indicator's output as its source.
  - **Multi-timeframe:** any indicator can be calculated on another interval ("Calculate on").
  - **Volume and profiles:** volume profile (fixed range, visible range, session), TPO, anchored VWAP.
  - **Patterns:** candlestick pattern recognition, auto chart patterns, auto Fib.
  - **Other:** Ichimoku, pivots, and the remaining built-ins.
- **113 drawing tools**, grouped like TradingView. Each drawing can have a style template, a group, and its own visibility per interval. Multi-select with Shift-click; ⌘A, ⌘C and ⌘V select all, copy and paste.
  - **Trend:** lines, channels, pitchforks.
  - **Gann and Fibonacci.**
  - **Patterns:** XABCD, head and shoulders, Elliott waves, cycles.
  - **Forecasting and measurement:** long/short position, forecast, ghost feed, anchored VWAP, fixed range and anchored volume profile, measurers.
  - **Shapes and annotations.**
  - **Editing:** magnet (weak or strong), keep drawing, lock, hide, object tree and undo/redo.
- **AI Chance v1.3:** the port of your Pine Script, which can be switched on per chart.
  - Signals are drawn like TradingView's Pine labels: coloured boxes with a pointer and a dashed line to the bar.
  - The price scale expands to keep labels visible.
  - Optional bands:
    - **TMA bands** (A5 ± 1.5 ATR).
    - **UML band** (Upper / Middle / Lower), fitted to TAD Market Navigator's published band values. It is an approximation: SMA(close, 85) ± 2.48 × SMA(true range, 120), with every input editable.

**Alerts**
- **Server alerts:** run even when no browser is open. Up to 1,000.
  - **Conditions:** crossing, crossing up/down, greater/less than, entering/exiting/inside/outside channel, moving up/down by value or %.
  - **Types:** single price, multi-condition (AND) and watchlist alerts.
  - **Webhooks:** each alert can post a templated message to a webhook URL. A log records each delivery.
- **Indicator and drawing alerts:** these also run on the server, for any indicator, interval, line, channel or box. Formula charts fall back to running in the browser.
- **AI Chance alerts:** written in plain words, e.g. "⏸ DO NOTHING | momentum fading — wait for new setup".
- **Phone push notifications:** install the app (Chrome or Safari → Add to Dock / Home Screen), then tap 📵 in the Alerts panel.

**Trading tools (simulated only)**
- **Strategy tester:**
  - 12 built-in strategies, including AI Chance signals.
  - Properties: commission, slippage, pyramiding, stop-loss/take-profit, date range.
  - Results: performance summary split All / Long / Short, equity and drawdown chart, list of trades, CSV and XLSX export.
  - Bar magnifier (fills stops and targets using 1-minute bars).
  - Optimiser with a heatmap and walk-forward test.
  - Risk rules: margin, maximum daily loss, maximum drawdown, consecutive losing days.
  - Strategy alerts.
- **Script editor:** strategies and indicators in JavaScript, Pine-style, with inputs and templates. "Add to chart" turns an indicator script into a chart indicator.
- **Paper trading (MT5-style):**
  - Account leverage from 1:1 to 1:1000, volume in lots.
  - Each symbol has a contract size (gold 100 oz, crypto 1 coin, FX 100,000 by default), minimum and maximum lot, lot step, and an optional leverage override.
  - Margin = lots × contract size × price ÷ leverage.
  - Order types: market, limit, stop, stop-limit, brackets, trailing stops.
  - Chart trading: drag the position and order lines.
  - Price ladder.
  - **No real orders are ever sent to IG.**

**MT5 account (read-only)**
- **Bridge EA:** `mt5/IGChartsBridge.mq5` runs in your own MT5 terminal (Windows or Mac, any broker, e.g. Pepperstone MT5). It sends your account, positions, pending orders and deal history to this server.
- **What you see:**
  - positions with SL/TP and orders as lines on the matching chart
  - entries and exits as markers
  - an **MT5 Account** tab with balance, equity, margin, positions, orders, history and CSV export
- **Symbol mapping:** MT5 symbols are matched to IG markets automatically (XAUUSD → gold), and you can edit the mapping.
- **Security:** the EA can't trade, and your MT5 password never leaves the terminal. It authenticates with a bridge token shown in the MT5 tab.
- **Setup:** see the MT5 tab → Setup.
  - You must allow the server URL in MT5 → Tools → Options → Expert Advisors → Allow WebRequest.
  - If MT5 refuses `127.0.0.1`, use the computer's network address or an https deployment.

**Workspace**
- **Watchlists:** multiple lists with sections and 7 flag colours (each colour also works as a list). Custom columns, sorting, drag to reorder, import/export as .txt, plus a details panel.
- **Screener:** scans a watchlist on a chosen interval and shows RSI, ATR %, performance, distance from SMA50 and a technical rating (moving averages and oscillators). Filter, sort and export to CSV.
- **Data window, snapshots and export:** a data window, PNG snapshots of one chart or the whole layout (or copy to clipboard), and chart data export as CSV (OHLCV plus every indicator output).
- **Display and timezone:** dark/light theme and a timezone setting.
- **Economic calendar and news:** a sidebar tab with the ForexFactory calendar (filter by impact and currency) and news from FXStreet, Investing.com and CoinDesk.
- **Sync across devices:** layouts, watchlists, drawings, templates, settings, scripts and the paper account are stored on the server.
- **Installable app:** a manifest and service worker let you add it to your Dock or Home Screen.
- **Keyboard shortcuts:** press `?` for the list.
- **IG Trading (real orders):** an **IG Trading** tab with an order ticket (market / limit / stop, stop and limit by distance or level, guaranteed and trailing stops), positions and working orders with live P&L, draggable stop/limit lines on the chart, activity and an order log (`.data/trade-log.json`). Every order, close and amend opens a confirmation dialog; on LIVE you must also tick a real-money box. Off unless `IG_TRADING=1`; LIVE also needs `IG_TRADING_LIVE=1`. Test on your IG DEMO account first.
- **Pine Script:** paste TradingView Pine v5 (and common v4) code in the script editor and run it as an indicator or strategy: inputs, series history, `ta.*`, arrays, plots / shapes / fills / labels / lines / boxes, `request.security` on the chart symbol, and `strategy.*` orders in the tester. Also tables, `barcolor`, `plotcandle` / `plotbar`, step and area plots, `request.security` on other symbols and lower timeframes (`request.security_lower_tf`), `map.*`, a `matrix.*` subset, user-defined types with methods, and libraries (save a script with `library("Name")`, then `import user/Name/1`). Also `enum` (incl. `export enum`, titles, `input.enum`), `chart.point` + `polyline.*` (straight or curved, closed / filled), `ticker.new/modify/standard/inherit/heikinashi` (Heikin-Ashi bars through `request.security`), `request.currency_rate` (the FX pair's daily close), `strategy.order`, OCA groups (`strategy.oca.cancel/reduce/none`), stop-limit entries and gradient `fill()`. Script indicators on the chart compute in a Web Worker. Still unsupported (line:column errors): `ticker.renko/linebreak/kagi/pointfigure` (non-time-based bars), `request.financial/dividends/earnings/splits/economic/quandl/seed` and `dividends.*`/`earnings.*`/`splits.*` (no data source), `request.security(currency=...)`, `strategy.risk.*` except `allow_entry_in`, matrix functions outside the common subset. Ticker session/adjustment modifiers are accepted but have no effect (IG history has one session and no adjustments).
- **Deep backtesting:** run a strategy on up to 30,000 bars or a date range (older bars from the extended history sources); the result notes bars, period and data sources.
- **Scripts in a Web Worker:** user scripts and backtests run off the main thread with a time limit and Cancel, so a slow script can't freeze the chart.
- **Paper trading in Bar Replay:** trade against replayed bars in a separate replay account (fills at bar prices with intrabar order open→low→high→close or open→high→low→close); a results window shows trades, P&L, win rate, profit factor and max drawdown when replay ends.
- **Hotlists:** top gainers / losers, most volatile, gap up / down and unusual tick volume over your watchlists plus 26 major IG markets (cached to spare the IG history allowance).
- **Notes:** per-symbol notes in the sidebar, with search and "note at this bar"; charts and watchlist rows show ✎ when a symbol has notes.
- **Indicator on indicator:** any indicator's Source can be another indicator's output (cycles are prevented).
- **Chart tabs and groups:** layouts are tabs; closing a tab keeps the layout (⌘⇧T reopens). Right-click a tab to rename, duplicate, open in a new window, add it to a coloured tab group, close others or delete it. Drag tabs to reorder. Group chips collapse on click; right-click a chip to link the symbol across the group, recolour, rename or ungroup.
- **Replay jump and lower-timeframe stepping:** pick a date and time in the replay bar and press Go (more history loads if needed); the Step menu replays the current bar one lower-timeframe bar at a time (paper trading fills against those sub-bars).
- **Scale options:** 🔒 locks the price-to-bar ratio while zooming; P scales the price chart only (indicators on the price pane don't stretch the scale).
- **TradingView-exact Supertrend, Parabolic SAR and DMI:** match Pine `ta.supertrend`, `ta.sar` and `ta.dmi` bar for bar.
- **STMN alerts:** the **Alert…** button under the STMN stats table creates a server-side alert (fires with the browser closed) for STMN+ / STMN− on that symbol and timeframe, sent by push, Telegram, e-mail or webhook with EL, SL, TP1–3 and lot size.
- **STMN backtest:** the **Backtest…** button simulates every STMN box trade by trade (entry at EL limit / signal close / confirmation; exit at TP1, TP2, TP3 or scale-out with breakeven; spread and commission) and shows win rate, average R, profit factor, max drawdown, an equity curve, the trade list (click to jump to a trade) and CSV export, with an explanation of how it differs from the stats table.
- **Deep links:** `/?symbol=EPIC&interval=15&type=candles&scale=log&ac=1` opens that chart; camera menu → **Copy link to this chart**.
- **Indexed to 100 scale:** the `100` button next to `%` and `log`.
- **Telegram and e-mail alerts:** set the `TELEGRAM_*` or `SMTP_*` variables; each alert has Telegram / e-mail toggles and a **Send test** link.
- **Longer history (up to 30,000 bars):** for gold, silver, FX and crypto, the most recent day comes from IG and older bars come from free sources: Bitstamp for BTC/ETH (the feed behind TradingView's "BTCUSD · Bitstamp") and Dukascopy for gold, silver and FX. Older bars are shifted by the median price difference where the feeds overlap, so there is no jump at the seam. Files are cached in `.cache/ext/`. Gold history is pre-filled in the background at start-up because Dukascopy is intermittently slow.

## Not possible with IG data

- **Footprint:** IG publishes no traded volume at each price. The footprint shows up/down tick counts from live ticks only, and volume everywhere is IG tick volume.
- **Tick bars:** IG has no tick history, so tick and range bars start from 1-minute history and then build from live ticks.
- **Market depth:** IG publishes none, so the price ladder shows prices without depth.
- **Other data:** news, fundamentals, options and screener fields that need exchange data are not available.

## Run locally

```bash
npm install
cp .env.example .env      # fill in IG_API_KEY, IG_USERNAME, IG_PASSWORD, IG_ENV
npm start                 # http://localhost:3000  (Node 18+ for live IG)
```

No credentials yet? Run `npm run mock` for simulated gold and BTC prices.

On startup the server searches IG for "Spot Gold" and "Bitcoin" and adds them to the watchlist. If it picks the wrong contract, set `GOLD_EPIC` / `BTC_EPIC` in `.env`, or add markets from symbol search.

## Environment

| Variable | Purpose |
|---|---|
| `IG_API_KEY`, `IG_USERNAME`, `IG_PASSWORD` | IG API credentials (server only) |
| `IG_ENV` | `DEMO` (default) or `LIVE` |
| `GOLD_EPIC`, `BTC_EPIC` | Optional default markets |
| `APP_USER` / `APP_PASSWORD` | Basic auth for the page, API and WebSocket. Set it whenever the app is reachable by others |
| `PORT` | HTTP port (default 3000) |
| `MOCK=1` | Simulated prices, no IG login |
| `CALENDAR_URL`, `NEWS_FEEDS` | Economic calendar JSON and comma-separated RSS/Atom feeds |
| `IG_TRADING` | `1` enables order placement in the IG Trading tab (default off) |
| `IG_TRADING_LIVE` | `1` is also required to trade when `IG_ENV=LIVE` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Send alerts to a Telegram chat |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ALERT_EMAIL_TO` | Send alerts by e-mail (no extra packages) |
| `HISTORY_EXT` | `0` turns off extended history (default on) |
| `HISTORY_PROVIDERS` | Order of free history sources (default `bitstamp,dukascopy`) |
| `HISTORY_IG_DAYS` | How many recent days come from IG (default 1) |
| `HISTORY_PREFETCH` | Comma-separated market names to pre-fill at start-up (default `Spot Gold,Bitcoin`) |
| `MT5_BRIDGE_TOKEN` | Optional fixed token for the MT5 bridge EA (otherwise generated into `.data/mt5.json`) |
| `VAPID_SUBJECT` | Contact for web push (e.g. `mailto:you@example.com`); needed for Apple push |

The server keeps its data in `.data/`: alerts and their log, synced workspace state (`state.json`), push subscriptions, and the push signing keys (`vapid.json`). Keep `vapid.json`: replacing it invalidates every push subscription. History is cached in `.cache/history.json`. Both folders are git-ignored.

## Code layout

| File | Role |
|---|---|
| `server.js` | IG login, history cache (15 resolutions, up to 5,000 bars), stream fan-out, alerts engine and webhooks |
| `public/core.js` | Settings, formatting, API, event bus, live quotes |
| `public/chartview.js` | One chart: series, chart types, indicators, panes, drawings, replay, compare, spread, AI Chance |
| `public/app.js` | Layouts and tabs, toolbar, dialogs, keyboard, startup |
| `public/panels.js` | Watchlists, alerts, object tree and data window, screener, host for the trading tools |
| `public/indicators.js`, `charttypes.js`, `drawings.js` | Indicator library, chart-type and interval transforms, drawing engine |
| `public/strategy.js`, `paper.js` | Strategy tester and script editor, paper trading |
| `public/aichance.js`, `pine` | AI Chance v1.3 port and its Pine source |

## Deploy to Coolify

1. In Coolify: **+ New Resource → Public/Private Repository** → `https://github.com/jeremiahng11/ig-chart` (branch `main`). For a private repo, connect it through a GitHub App or deploy key.
2. Build Pack: **Dockerfile**. Ports Exposes: `3000`. Set your domain (Coolify issues the TLS cert).
3. **Environment Variables:** paste the values from `.env.example`. **Set `APP_PASSWORD`.**
4. **Persistent Storage:** add a volume mounted at `/app/.data` (alerts, state, push keys, MT5 token) and one at `/app/.cache` (history cache).
5. Health check path: `/healthz` (it skips basic auth). Deploy.

Run only **one instance**. Local equivalent: `docker compose up --build` (reads `.env`).

## Deploy to Railway

1. Push this folder to a GitHub repo and create a Railway service from it. Railway detects Node and runs `npm start`.
2. Add the variables from `.env.example` in Railway → Variables. **Set `APP_PASSWORD`.**
3. Add a volume mounted at `/app/.data` so server alerts survive redeploys.

Run only **one instance**. Each instance logs in and opens its own IG stream.

## IG limits to know

| Limit | Value | How the app handles it |
|---|---|---|
| Non-trading REST requests | 60 / min | Live prices come from streaming only |
| Historical price points | 10,000 / week | History is cached and topped up incrementally. "Bars to load" in Settings defaults to 500. Requests that would exceed the remaining allowance are refused with a message |
| Streaming subscriptions | 40 | Charts, watchlists and alerts share them. The Alerts panel warns when an alert symbol is over the cap |
| Session tokens | expire after 12 h idle | The server logs in again automatically |
| Bars per request | 5,000 | Gold, silver, FX and crypto get older bars from Bitstamp / Dukascopy instead, so only about a day of IG allowance is used |

## Notes

- Prices are IG's CFD bid/offer. Candles use the mid price.
- IG's API data is licensed for your own use. Don't expose this app to customers without a data agreement with IG.
- Scripts in the script editor run in your browser with full page access. Only run code you trust.

## License

Private project. No license has been granted.
