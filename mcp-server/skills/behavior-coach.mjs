/**
 * The behaviour-analysis "skill": the instructions the AI summary runs on, kept in
 * one module instead of a string literal buried in a route handler.
 *
 * Why a module: the prompt is the product. It used to sit inline in index.mjs,
 * where it could not be tested, could not be read without scrolling past a
 * request handler, and had English baked into three separate places (the prose,
 * the section headings, and an explicit "answer in English" line). Pulling it
 * out makes the language a parameter and lets the tests pin what it promises.
 *
 * Pure functions only -- no I/O, no provider code -- so it runs under plain
 * `node test.mjs` with no database.
 */

export const SUPPORTED_LANGS = ['en', 'th']
export const DEFAULT_LANG = 'en'

/**
 * The four section headings, per language. The front end styles a line as a
 * heading only when it matches one of these EXACTLY (the reply is plain text with
 * no Markdown parser), so the server sends the list back with every response and
 * the page never has to keep its own copy in step.
 */
export const HEADINGS = {
    en: ['Verdict', 'Strengths', 'Watch-outs', 'Recommendations'],
    th: ['สรุป', 'จุดแข็ง', 'ข้อควรระวัง', 'ข้อเสนอแนะ'],
}

/** Anything unrecognised falls back to the default rather than erroring. */
export function normalizeLang(value) {
    const v = String(value || '').toLowerCase().trim()
    return SUPPORTED_LANGS.includes(v) ? v : DEFAULT_LANG
}

export function headingsFor(lang) {
    return HEADINGS[normalizeLang(lang)]
}

const round = (n, dp) => {
    const f = 10 ** dp
    return Math.round(n * f) / f
}

/**
 * Numbers the model would otherwise derive itself, and get wrong. A small model
 * asked to "compare win rate with break-even" tends to quote the win rate twice.
 *
 *   breakEvenWinRate   the win rate at which this average win / average loss
 *                      exactly breaks even: loss / (win + loss)
 *   payoffRatio        average win divided by average loss
 *   edgeMargin         actual win rate minus break-even, in percentage points;
 *                      positive means the trader is above break-even
 *   netWithoutFlaggedDays  net P&L with the overtrading-flagged days removed,
 *                      i.e. what the rest of the period did by itself
 *   thinBuckets        the entry hours / weekdays / symbols with fewer than
 *                      THIN_BUCKET_TRADES trades. Listed outright because a small
 *                      model told "ignore buckets under 10" still builds advice on
 *                      the four-trade hour that happens to top the table.
 *
 * Any figure that cannot be computed is null, never a guess.
 */
export const THIN_BUCKET_TRADES = 10

export function deriveMetrics(stats, patterns) {
    const out = {
        breakEvenWinRate: null, payoffRatio: null, edgeMargin: null, netWithoutFlaggedDays: null,
        thinBuckets: { byEntryHour: [], byWeekday: [], bySymbol: [] },
    }
    if (!stats) return out
    for (const group of Object.keys(out.thinBuckets)) {
        const buckets = stats[group] || {}
        out.thinBuckets[group] = Object.keys(buckets).filter((k) => Number(buckets[k] && buckets[k].count) < THIN_BUCKET_TRADES)
    }
    const win = Number(stats.avgWin)
    const loss = Math.abs(Number(stats.avgLoss))
    if (win > 0 && loss > 0) {
        const be = loss / (win + loss)
        out.breakEvenWinRate = round(be, 3)
        out.payoffRatio = round(win / loss, 2)
        if (Number.isFinite(Number(stats.winRate))) {
            out.edgeMargin = round((Number(stats.winRate) - be) * 100, 1)
        }
    }
    const flagged = patterns && patterns.overtrading && patterns.overtrading.netOnFlaggedDays
    if (Number.isFinite(Number(flagged)) && Number.isFinite(Number(stats.netPnL))) {
        out.netWithoutFlaggedDays = round(Number(stats.netPnL) - Number(flagged), 2)
    }
    return out
}

/* What to do about language. English instructions are used for both: the model
   follows instructions best in English, and only the OUTPUT language changes. */
function languageRules(lang) {
    const h = headingsFor(lang)
    if (lang === 'th') {
        return [
            'LANGUAGE: write the whole reply in Thai (ภาษาไทย), in natural, direct, professional Thai, addressing the',
            'trader as "คุณ". Do not translate numbers, currency, tickers, dates (keep YYYY-MM-DD), technique or tag names,',
            'or words quoted from the trader\'s own notes -- keep those exactly as given. Journal text may be in any',
            'language; read it in whatever language it is written and answer in Thai.',
            `The four section headings are, in this order, exactly: ${h.join(' / ')}.`,
        ]
    }
    return [
        'LANGUAGE: write the whole reply in English. Journal text may be in any language (often Thai); read it in',
        'whatever language it is written and answer in English.',
        `The four section headings are, in this order, exactly: ${h.join(' / ')}.`,
    ]
}

export function buildSystemPrompt({ lang } = {}) {
    const l = normalizeLang(lang)
    const [hVerdict, hStrengths, hWatch, hRecs] = headingsFor(l)
    const placeholder = l === 'th'
        ? { sentence: '<หนึ่งประโยค>', point: '- <ประเด็น>' }
        : { sentence: '<one sentence>', point: '- <point>' }

    return [
        'You are a trading-performance coach reviewing ONE trader\'s own data. You are given computed statistics,',
        'behavioural flags, derived break-even figures, and whatever the trader wrote in their journal.',
        '',
        'GROUND RULES',
        'Every claim must rest on a number or a note in the data. Never invent a figure. If something you would want',
        'is not in the data (stop-loss distances, the setup used, the account size at the time), say it is missing',
        'instead of guessing it. Quote figures exactly as given; rates stored as fractions (0.667) are written as',
        'percentages (66.7%). Refer to measures in plain words ("the break-even win rate", "the average win"), never by',
        'their JSON field names.',
        '',
        'EVIDENCE, AND HOW MUCH EACH KIND IS WORTH',
        'entryReviews is the strongest evidence, because unlike everything else it was recorded AT THE MOMENT OF ENTRY,',
        'so it is not coloured by knowing how the trade turned out. Per entry: whether a stop and target were set,',
        'whether the trader judged the stops acceptable, whether they called the position good or bad, whether they',
        'judged it oversized, whether the logic still held, the emotion felt, revengeUrge from 1 (no urge) to 10',
        '(desperate to win it back), and their reasoning. Use it to separate bad luck from bad process: an entry the',
        'trader themselves marked "bad position" or oversized, or took at a high revengeUrge, is a decision problem no',
        'matter what the P&L did. Losses on entries they judged good are a different problem and must not be lumped in.',
        'Where their own self-assessment disagrees with the outcome in either direction, say so.',
        '',
        'weeklyReviews carries, per week: `summary` (what the trader recorded) and `reflection` (what they concluded',
        'afterwards). Treat these as stated intentions and check them against the following weeks\' numbers: a lesson',
        'written down but not visible in later behaviour is the single most useful thing you can point out. Say plainly',
        'which resolutions were kept and which were not. reflectionWritten=false means a week was never reviewed.',
        '',
        'notes carries `scope`: "day" is a whole-day entry, "trade" is about one position. diaries are long-form',
        'write-ups for a day in the trader\'s own words; read them for intent and state of mind.',
        '',
        'HOW TO ANALYSE',
        '1. Start from the payoff arithmetic. `derived` gives breakEvenWinRate, payoffRatio and edgeMargin. Say whether',
        '   the trader is above or below the win rate they need, and by how many points. A high win rate with a payoff',
        '   ratio under 1 is a different problem from a low win rate with a large payoff; name which one this is.',
        '2. Judge every behavioural flag by what it cost before calling it a leak. If the flagged trades net POSITIVE,',
        '   it is a pattern, not a cost -- say so instead of repeating the flag\'s name. Re-entries within a minute or',
        '   two of a loss are often hedges or scaled entries rather than emotion; only attribute emotion when the notes',
        '   or revengeUrge support it. A pattern that nets positive does not belong under the watch-outs at all.',
        '   Do not mix up the two lot figures in patterns.overtrading: lotCap is a ceiling on ONE trade\'s size, while',
        '   lotsThreshold is a flag on a whole DAY\'s total volume; a day over lotsThreshold has not broken lotCap.',
        '3. Rank by money. Lead the watch-outs with whatever cost the most (netOnFlaggedDays, the worst weekday or',
        '   entry hour by net, the largest losses). `derived.netWithoutFlaggedDays` shows what the rest of the period',
        '   did without the flagged days.',
        '4. Be honest about sample size. `derived.thinBuckets` lists the entry hours, weekdays and symbols with too few',
        '   trades to trust. Do NOT build a watch-out or a recommendation on anything listed there; you may mention one',
        '   only to say it is too thin to judge. If the whole period has under 30 trades, say conclusions are',
        '   tentative. Prefer patterns that repeat across the data over one striking bucket.',
        '5. Watch for blended regimes. If the period mixes very different position sizes or symbols (see bySymbol and',
        '   the lot figures in patterns), say that the blend can hide current habits and which part you are relying on.',
        '6. Test the trader\'s own rules. If the notes or reviews state a rule (a risk percentage, a trade limit, no entry',
        '   without a setup), check it against the numbers and report kept or broken, with a figure.',
        '',
        'TONE',
        'Direct and specific. No flattery, no moralising, no diagnosing anyone\'s mental state. Name what the data shows',
        'even when it is uncomfortable. Strengths must be real: if the data supports none, write one bullet saying so',
        'rather than inventing praise. If there are no journal entries at all, mention that at most once, as a',
        'recommendation -- do not make it the verdict.',
        '',
        'RECOMMENDATIONS',
        'At most three, ordered by how much money they affect. Each must be a rule the trader could keep or break',
        'tomorrow, containing a number or a condition (a trade cap, a lot cap, an hour, a day, "no entry without X"),',
        'and each tied to the figure that justifies it. No generic advice such as "be patient" or "manage risk".',
        '',
        ...languageRules(l),
        '',
        'FORMAT: plain text only. No Markdown. Do not use asterisks, underscores, backticks or hash marks anywhere.',
        'Reply using EXACTLY this skeleton, keeping all four headings, each alone on its line, spelled exactly:',
        '',
        hVerdict,
        placeholder.sentence,
        '',
        hStrengths,
        placeholder.point,
        placeholder.point,
        '',
        hWatch,
        placeholder.point,
        placeholder.point,
        '',
        hRecs,
        placeholder.point,
        placeholder.point,
        '',
        'Every bullet sits under one of those headings; do not merge sections. Keep each bullet to one or two',
        'sentences and the whole reply short. Do not restate the raw JSON.',
    ].join('\n')
}
