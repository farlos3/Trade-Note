/**
 * Pure trading-behavior analysis. No I/O — takes plain data, returns plain data.
 * Kept side-effect free so it can be unit-tested without a database.
 *
 * A TradeNote "day document" holds a `trades` array of round-trip trades.
 * Nested trade fields (from the app code): id, symbol, strategy ('long'/'short'),
 * side, entryTime/exitTime (unix seconds), entryPrice/exitPrice,
 * buyQuantity/sellQuantity, grossProceeds/netProceeds, commission, mfe, mae.
 */

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : 0
}

/** Flatten day documents into a sorted, normalized list of individual trades. */
export function flattenTrades(dayDocs) {
  const out = []
  for (const day of dayDocs || []) {
    const arr = Array.isArray(day.trades) ? day.trades : []
    for (const t of arr) {
      // Skip still-open positions: no exit, no realised P&L. Counting them would
      // add a phantom "traded day" with $0 net (matches the dashboard, which
      // ignores them too).
      if (t.openPosition) continue
      const net = t.netProceeds != null ? num(t.netProceeds) : num(t.grossProceeds)
      out.push({
        id: t.id ?? null,
        symbol: t.symbol ?? 'UNKNOWN',
        direction: t.strategy ?? t.side ?? 'unknown', // 'long' | 'short'
        entryTime: num(t.entryTime),
        exitTime: num(t.exitTime),
        entryPrice: num(t.entryPrice),
        exitPrice: num(t.exitPrice),
        size: num(t.buyQuantity) || num(t.sellQuantity) || num(t.quantity),
        gross: num(t.grossProceeds),
        commission: num(t.commission),
        net,
        pnl: net,
        dateUnix: num(day.dateUnix),
      })
    }
  }
  out.sort((a, b) => a.entryTime - b.entryTime)
  return out
}

const round = (n, d = 2) => {
  const f = 10 ** d
  return Math.round((n + Number.EPSILON) * f) / f
}

/** Calendar date (YYYY-MM-DD) in a given IANA timezone, from unix seconds. */
function dayInTz(unix, tz) {
  try {
    return new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: tz })
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 10)
  }
}

/** Weekday + hour in a given IANA timezone, from a unix-seconds timestamp. */
function localParts(unix, tz) {
  if (!unix) return { weekday: 'Unknown', hour: null }
  const d = new Date(unix * 1000)
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false,
    }).formatToParts(d)
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Unknown'
    let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? 'NaN', 10)
    if (hour === 24) hour = 0
    return { weekday, hour: Number.isFinite(hour) ? hour : null }
  } catch {
    return { weekday: 'Unknown', hour: d.getUTCHours() }
  }
}

/** Headline performance stats plus breakdowns by symbol / weekday / entry hour. */
export function computeStats(trades, tz = 'UTC') {
  const n = trades.length
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const decided = wins.length + losses.length
  const winRate = decided ? wins.length / decided : 0
  const avgWin = wins.length ? grossProfit / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0

  const groupBy = (keyFn) => {
    const m = {}
    for (const t of trades) {
      const k = keyFn(t)
      const g = (m[k] ??= { count: 0, net: 0, wins: 0, losses: 0 })
      g.count++; g.net += t.pnl
      if (t.pnl > 0) g.wins++; else if (t.pnl < 0) g.losses++
    }
    return Object.fromEntries(
      Object.entries(m)
        .sort((a, b) => a[1].net - b[1].net)
        .map(([k, g]) => [k, {
          count: g.count, net: round(g.net),
          winRate: g.wins + g.losses ? round(g.wins / (g.wins + g.losses), 3) : null,
        }]),
    )
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakEven: n - decided,
    winRate: round(winRate, 3),
    netPnL: round(trades.reduce((s, t) => s + t.pnl, 0)),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : null,
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    expectancy: round(winRate * avgWin - (1 - winRate) * avgLoss),
    largestWin: round(Math.max(0, ...trades.map((t) => t.pnl))),
    largestLoss: round(Math.min(0, ...trades.map((t) => t.pnl))),
    bySymbol: groupBy((t) => t.symbol),
    byWeekday: groupBy((t) => localParts(t.entryTime, tz).weekday),
    byEntryHour: groupBy((t) => {
      const h = localParts(t.entryTime, tz).hour
      return h == null ? 'Unknown' : String(h).padStart(2, '0') + ':00'
    }),
  }
}

/**
 * Per-day P&L aggregates, oldest first. Lets a plan target ("1% per day") be
 * compared against what actually happened on the days you traded.
 */
export function computeDailyBreakdown(trades, tz = 'UTC') {
  const byDay = {}
  for (const t of trades) {
    const g = (byDay[t.dateUnix] ??= { net: 0, trades: 0 })
    g.net += t.pnl
    g.trades++
  }
  return Object.entries(byDay)
    .map(([dateUnix, g]) => ({
      // dateUnix is start-of-day in the trade timezone, so format the calendar
      // date in that same tz — using UTC here shifts every day back one.
      date: dayInTz(Number(dateUnix), tz),
      net: round(g.net),
      trades: g.trades,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Behavioral red-flags that headline stats hide. Returns a structured report.
 * opts: { revengeWindowMinutes=15, tz='UTC' }
 */
export function findBehaviorPatterns(trades, opts = {}) {
  const revengeWindowMinutes = opts.revengeWindowMinutes ?? 15
  const tz = opts.tz ?? 'UTC'
  // Absolute per-trade lot at/above which a trade is "oversized" (a lot bigger
  // than the trader's normal). Default 0.1; override via opts.overtradeLotCap.
  const lotCap = num(opts.overtradeLotCap) || 0.1
  const report = {}

  // --- Revenge trading: entered soon after closing a losing trade ---
  const revenge = []
  for (let i = 1; i < trades.length; i++) {
    const prev = trades[i - 1]
    const cur = trades[i]
    if (prev.pnl >= 0) continue
    const gapMin = (cur.entryTime - prev.exitTime) / 60
    if (gapMin >= 0 && gapMin <= revengeWindowMinutes) {
      revenge.push({
        after: { symbol: prev.symbol, pnl: round(prev.pnl) },
        trade: { symbol: cur.symbol, pnl: round(cur.pnl), size: cur.size },
        gapMinutes: round(gapMin, 1),
      })
    }
  }
  report.revengeTrading = {
    windowMinutes: revengeWindowMinutes,
    count: revenge.length,
    netPnL: round(revenge.reduce((s, r) => s + r.trade.pnl, 0)),
    winRate: revenge.length
      ? round(revenge.filter((r) => r.trade.pnl > 0).length / revenge.length, 3)
      : null,
    examples: revenge.slice(0, 10),
  }

  // --- Overtrading days: trade COUNT or total LOTS well above the personal
  //     median. Trading more lots than usual on a day counts even if the number
  //     of trades is normal (bigger size = more risk on the book that day). ---
  const perDay = {}
  for (const t of trades) (perDay[t.dateUnix] ??= []).push(t)
  const dayVolume = (a) => a.reduce((s, t) => s + (num(t.size) || 0), 0)
  const counts = Object.values(perDay).map((a) => a.length)
  const volumes = Object.values(perDay).map(dayVolume)
  const medCount = median(counts)
  const medVol = median(volumes)
  const overThreshold = Math.max(medCount * 2, medCount + 3)  // count trigger
  const volThreshold = medVol * 2                             // lots trigger
  let oversizedTotal = 0
  const overDays = Object.entries(perDay)
    .map(([dateUnix, a]) => {
      const vol = dayVolume(a)
      const oversized = a.filter((t) => (num(t.size) || 0) >= lotCap).length
      oversizedTotal += oversized
      const byCount = a.length >= overThreshold && a.length > 1
      const byVolume = medVol > 0 && vol >= volThreshold && a.length > 1
      const byLot = oversized > 0                              // per-trade lot trigger
      return { dateUnix, a, vol, oversized, byCount, byVolume, byLot }
    })
    .filter((d) => d.byCount || d.byVolume || d.byLot)
    .map((d) => {
      const reasons = []
      if (d.byCount) reasons.push('count')
      if (d.byVolume) reasons.push('lots')
      if (d.byLot) reasons.push('oversized')
      return {
        date: new Date(Number(d.dateUnix) * 1000).toISOString().slice(0, 10),
        trades: d.a.length,
        volume: round(d.vol),
        oversizedTrades: d.oversized,
        net: round(d.a.reduce((s, t) => s + t.pnl, 0)),
        reason: reasons.join('+'),
      }
    })
    .sort((x, y) => y.trades - x.trades)
  report.overtrading = {
    medianTradesPerDay: medCount,
    medianLotsPerDay: round(medVol),
    flagThreshold: overThreshold,
    lotsThreshold: round(volThreshold),
    lotCap,                                 // per-trade "oversized" threshold
    oversizedTrades: oversizedTotal,
    flaggedDays: overDays.length,
    netOnFlaggedDays: round(overDays.reduce((s, d) => s + d.net, 0)),
    days: overDays.slice(0, 10),
  }

  // --- Position-size tilt: bigger size after a loss than after a win ---
  const afterLoss = []
  const afterWin = []
  for (let i = 1; i < trades.length; i++) {
    if (!trades[i].size) continue
    if (trades[i - 1].pnl < 0) afterLoss.push(trades[i].size)
    else if (trades[i - 1].pnl > 0) afterWin.push(trades[i].size)
  }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
  const avgAfterLoss = avg(afterLoss)
  const avgAfterWin = avg(afterWin)
  report.positionSizingTilt = {
    avgSizeAfterLoss: round(avgAfterLoss, 4),
    avgSizeAfterWin: round(avgAfterWin, 4),
    ratio: avgAfterWin ? round(avgAfterLoss / avgAfterWin, 2) : null,
    flag: avgAfterWin > 0 && avgAfterLoss > avgAfterWin * 1.25
      ? 'Sizes up after losses (possible revenge/martingale sizing)'
      : null,
  }

  // --- Holding-time asymmetry: holding losers longer than winners ---
  const holdMin = (t) => (t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) / 60 : null)
  const winHolds = trades.filter((t) => t.pnl > 0).map(holdMin).filter((x) => x != null)
  const lossHolds = trades.filter((t) => t.pnl < 0).map(holdMin).filter((x) => x != null)
  const avgWinHold = avg(winHolds)
  const avgLossHold = avg(lossHolds)
  report.holdingTimeBias = {
    avgWinnerHoldMinutes: round(avgWinHold, 1),
    avgLoserHoldMinutes: round(avgLossHold, 1),
    ratio: avgWinHold ? round(avgLossHold / avgWinHold, 2) : null,
    flag: avgWinHold > 0 && avgLossHold > avgWinHold * 1.3
      ? 'Holds losers longer than winners (cutting winners early / letting losers run)'
      : null,
  }

  return report
}
