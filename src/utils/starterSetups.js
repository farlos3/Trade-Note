/**
 * The trader's first seven setups, transcribed from their setup slides: the rules
 * are the slide text, the diagram is the right-hand half of each slide (the rules
 * text is cropped out, since the card renders the rules itself).
 *
 * Loaded on demand from the empty Setup page rather than seeded on boot, so
 * deleting them later stays deleted. Saved through the same useSaveSetup path as
 * a hand-made setup, so the diagrams go to R2 (or stay inline when R2 is off).
 *
 * Rules use the editor's own text form -- see textToRules in setups.js.
 */
import { useSaveSetup, textToRules } from './setups.js'
import trumpTrumpImg from '../assets/setups/trump-trump.png'
import trumpTrumpLqImg from '../assets/setups/trump-trump-lq.png'
import trumpTrumpUpDownLqImg from '../assets/setups/trump-trump-up-down-lq.png'
import followTrendImg from '../assets/setups/follow-trend.png'
import mssLqBuyImg from '../assets/setups/mss-lq-buy.png'
import mssPdArrayBuyImg from '../assets/setups/mss-pd-array-buy.png'
import mssLqSellImg from '../assets/setups/mss-lq-sell.png'

// The three Trump Trump slides share one checklist and differ only in the
// diagram (and the title) -- the variant being drawn.
const TRUMP_RULES = `
เห็นการย่ำของราคาใน HTF + Bias HTF
ใน LTF มีการทำลายแนวรับ-ต้านของตัวมันเอง (จิ้มไส้บัง)
ทำ Sideway ใน LTF, สลับ Pattern Buy-Sell ย่อย
เห็นการทำ Liquidity Sweeps (ถ้าให้ดีเห็นทำ HH, LL เพื่อขังคนทั้งสองฝั่ง)
การยกกลับขึ้นมาติด Key Level (มีรับ-ต้านด้วยจะดีมาก)
  - (ไม่ควรทำ High ใหม่หลังจาก Clear Liquidity + ใน Swing ต่อมาก็ไม่ควร break swing ก่อนหน้า และถ้ากราฟทำ pattern ฝั่งตรงข้ามให้ weight decision น้อยได้เลย)
TP atleast 2,000 pips`

// Entry + exit rules every MSS setup ends with.
const MSS_ENTRY = `
PD-Array or Key Level for Entry
  - Breaker Block
  - Orderblock
  - Key Level
[Optional] Create Support/PA Buy
Lower Low that SL`

const STARTER_SETUPS = [
    { name: 'Trump Trump', side: 'any', image: trumpTrumpImg, rules: TRUMP_RULES },
    { name: 'Trump Trump, LQ', side: 'any', image: trumpTrumpLqImg, rules: TRUMP_RULES },
    { name: 'Trump Trump, Up-Down LQ', side: 'any', image: trumpTrumpUpDownLqImg, rules: TRUMP_RULES },
    {
        name: 'Follow Trend',
        side: 'any',
        image: followTrendImg,
        rules: `
Bias Trend
Wait for build base
  - Demand line
Unnecessary, it's best to have.
  - Liquidity Sweep
TP/SL more than 1.5`,
    },
    {
        name: 'MSS + LQ (Buy)',
        side: 'buy',
        image: mssLqBuyImg,
        rules: `
Sell-Side Liquidity
Market Structure Shift (Break of Structure)${MSS_ENTRY}
Atleast TP 1:1.5`,
    },
    {
        name: 'MSS + PD-Array (Buy)',
        side: 'buy',
        image: mssPdArrayBuyImg,
        rules: `
Market Structure Shift (Break of Structure)${MSS_ENTRY}
Atleast TP 1:1.5`,
    },
    {
        name: 'MSS + LQ (Sell)',
        side: 'sell',
        image: mssLqSellImg,
        rules: `
Buy-Side Liquidity
Market Structure Shift (Break of Structure)${MSS_ENTRY}
Atleast TP 1:1.5`,
    },
]

/** Bundled image URL -> data: URL, the form useSaveSetup uploads. */
async function toDataUrl(url) {
    const blob = await (await fetch(url)).blob()
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
    })
}

/** Save the starter setups in order, after `startOrder` existing ones. One at a
 *  time so the order they were saved in is the order they are listed in. */
export async function useLoadStarterSetups(startOrder = 0) {
    for (const [i, s] of STARTER_SETUPS.entries()) {
        await useSaveSetup({
            name: s.name,
            side: s.side,
            rules: textToRules(s.rules),
            order: startOrder + i,
            imageData: await toDataUrl(s.image),
        })
    }
}
