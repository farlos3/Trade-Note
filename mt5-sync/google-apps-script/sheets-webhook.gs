/**
 * Pushes one edited journal row straight into TradeNote, the moment you finish
 * typing a result. Lives INSIDE the Google Sheet (Extensions -> Apps Script), not
 * in this repo's own runtime -- this file is what you paste in there.
 *
 * TradeNote never reads this Sheet and never calls out to Google in either
 * direction. This script is the only thing that talks to Google's API (to read
 * the row you just edited); it then POSTs plain JSON to YOUR TradeNote. No
 * Google credential of any kind lives on the TradeNote side.
 *
 * ----------------------------------------------------------------------------
 * ONE-TIME SETUP (about two minutes)
 * ----------------------------------------------------------------------------
 *   1. Open this Sheet -> Extensions -> Apps Script.
 *   2. Delete whatever is in the editor, paste this whole file in, Ctrl+S.
 *   3. Fill in TRADENOTE_URL and TRADENOTE_API_KEY just below (the API key is
 *      the same one already in TradeNote's Settings -> API Keys -- the one MT5
 *      sync already uses; this does not need a new/different one).
 *   4. Left sidebar -> clock icon ("Triggers") -> "+ Add Trigger" (bottom right).
 *        Function: onSheetEdit
 *        Event source: From spreadsheet
 *        Event type: On edit
 *      Save, then approve the permission prompt (it is asking to run inside
 *      YOUR OWN Sheet and send data out -- not to read anything else of yours).
 *   5. Edit a row with a result already filled in. It should land in TradeNote
 *      within a couple of seconds. Check Executions (the list icon) in the Apps
 *      Script editor if it doesn't -- that log shows exactly why.
 *
 * Function name is deliberately NOT `onEdit` -- a plain `onEdit(e)` is a "simple
 * trigger" and Google will not let a simple trigger call out to the network
 * (UrlFetchApp). Only an INSTALLED trigger (step 4) is allowed to, which is why
 * this has to be wired up by hand once rather than just working on paste.
 * ----------------------------------------------------------------------------
 */

const TRADENOTE_URL = 'https://your-tradenote-host/api/sheets-webhook' // <-- fill in
const TRADENOTE_API_KEY = 'PASTE_YOUR_TRADENOTE_API_KEY_HERE'          // <-- fill in

/* Header names exactly as this Sheet has them today (confirmed against the live
   header row). If you rename a column, update the matching string here --
   lookup is by name, not by column letter, so reordering columns needs no
   change here, only a rename does. */
const COLUMNS = {
  date: 'Date',
  pair: 'Pair',
  side: 'Buy/Sell',
  technique: 'Technique',
  entry: 'Entry (Price)',
  stopLossPrice: 'Stop Loss (Price)',
  stopLossPoints: 'Stop Loss (Points)',
  lot: 'Lot Size ที่แนะนำ',
  takeProfit: 'Take Profit (Price)',
  result: 'ผลลัพธ์ (ได้/เสีย $)',
  note: 'บันทึก/หมายเหตุ',
}

/** "$1,000.00" / "$0.01" / "10" -> 1000 / 0.01 / 10. Blank -> null, not 0 -- a
 *  blank cell and an actual zero mean different things to the fields that use
 *  this (missing vs. genuinely zero). */
function parseMoney_(v) {
  if (v === '' || v === null || v === undefined) return null
  if (typeof v === 'number') return v
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''))
  return isNaN(n) ? null : n
}

/** Sheet date cell -> ISO string. Handles both a real Date (normal case, Sheets
 *  auto-converts a typed date) and a plain typed string, so a column formatted
 *  as plain text still works. */
function toIso_(v) {
  if (!v) return null
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString()
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function onSheetEdit(e) {
  if (!e || !e.range) return
  const sheet = e.range.getSheet()
  const sheetId = e.source.getId()

  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
  const colIndex = {}
  Object.keys(COLUMNS).forEach((key) => {
    colIndex[key] = headerRow.indexOf(COLUMNS[key]) // -1 if that header is missing
  })

  // Whichever rows the edit touched -- a paste can span several at once, a
  // single keystroke just one.
  const firstRow = e.range.getRow()
  const numRows = e.range.getNumRows()

  for (let r = firstRow; r < firstRow + numRows; r++) {
    if (r === 1) continue // header row
    syncRow_(sheet, r, colIndex, sheetId)
  }
}

function syncRow_(sheet, row, colIndex, sheetId) {
  const get = (key) => (colIndex[key] === -1 ? null : sheet.getRange(row, colIndex[key] + 1).getValue())

  const resultAmount = parseMoney_(get('result'))
  // Still being planned (no outcome yet) -- v1 of this integration only syncs
  // CLOSED trades, so a half-written row is skipped rather than sent as a
  // phantom open position. Edit it again once the result is filled in.
  if (resultAmount === null) return

  const date = toIso_(get('date'))
  const pair = get('pair')
  const side = get('side')
  const entry = parseMoney_(get('entry'))
  if (!date || !pair || !side || entry === null) return // not enough to be a trade yet

  const payload = {
    sheetId: sheetId,
    row: row,
    date: date,
    pair: pair,
    side: side,
    entryPrice: entry,
    stopLossPrice: parseMoney_(get('stopLossPrice')),
    takeProfitPrice: parseMoney_(get('takeProfit')),
    lot: parseMoney_(get('lot')) || 0.01,
    resultAmount: resultAmount,
    technique: get('technique') || '',
    note: [
      get('note') || '',
      get('stopLossPoints') != null ? ('SL points: ' + get('stopLossPoints')) : '',
    ].filter(Boolean).join(' | '),
  }

  const resp = UrlFetchApp.fetch(TRADENOTE_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'api-key': TRADENOTE_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  })
  console.log('row ' + row + ' -> HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText())
}
