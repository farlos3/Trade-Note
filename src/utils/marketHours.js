/**
 * How long a position was actually exposed to a market that was open.
 *
 * A trade held over the weekend measures ~48h longer on the clock than it was
 * tradable, which drags the "average trade length" up for no reason the trader
 * could have acted on. This subtracts the scheduled closures from a holding period.
 *
 * Schedule (gold / FX CFDs follow the New York day, so it is evaluated in that zone
 * and follows its daylight-saving shifts rather than a fixed UTC hour):
 *   - Mon-Thu 17:00-18:00  daily break
 *   - Fri 17:00 -> Sun 18:00  weekend
 * Brokers differ by a few minutes; this is deliberately the common shape, not any
 * one broker's exact feed. Holidays are not modelled.
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'; dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'; dayjs.extend(timezone)

const MARKET_TZ = 'America/New_York'

// Closed windows that START on this New York calendar day, as [from, to) dayjs pairs.
function closuresStartingOn(day) {
    const dow = day.day()                       // 0 Sun .. 6 Sat
    const at = (d, hour) => d.hour(hour).minute(0).second(0).millisecond(0)
    if (dow >= 1 && dow <= 4) return [[at(day, 17), at(day, 18)]]
    if (dow === 5) return [[at(day, 17), at(day.add(2, 'day'), 18)]]
    return []
}

/**
 * Seconds between two unix timestamps (seconds) with scheduled closures removed.
 * Never negative; a holding period that sits wholly inside a closure is 0.
 */
export function openSeconds(entryUnix, exitUnix) {
    if (!(exitUnix > entryUnix)) return 0
    let closed = 0
    // Start a day early: the weekend window begins Friday, so a trade entered on
    // Saturday still overlaps the one that started the day before.
    const last = dayjs.unix(exitUnix).tz(MARKET_TZ).startOf('day')
    for (let day = dayjs.unix(entryUnix).tz(MARKET_TZ).startOf('day').subtract(2, 'day'); !day.isAfter(last); day = day.add(1, 'day')) {
        for (const [from, to] of closuresStartingOn(day)) {
            const overlap = Math.min(exitUnix, to.unix()) - Math.max(entryUnix, from.unix())
            if (overlap > 0) closed += overlap
        }
    }
    return Math.max(0, exitUnix - entryUnix - closed)
}
