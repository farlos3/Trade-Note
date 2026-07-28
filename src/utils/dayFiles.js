/**
 * Day-level files: a single file (e.g. a PDF summarising the WHOLE trading day,
 * across every order) attached to a day rather than to one trade. Stored in the
 * `dayFiles` class, with the actual file on R2 (base64 fallback if R2 is off).
 */
import Parse from 'parse/dist/parse.min.js'
import { dayFiles, selectedRange, spinnerLoadingPage, timeZoneTrade } from '../stores/globals.js'
import { useUploadImageToR2, useDeleteImageFromR2 } from './r2.js'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(utc)
dayjs.extend(timezone)

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}

/** Upload one or more files as summaries for `dateUnixDay` (start-of-day unix).
 *  Multiple files per day are allowed -- each new file becomes its own record;
 *  nothing existing is replaced. Accepts a single File, a FileList, or an array. */
export async function useUploadDayFile(fileOrFiles, dateUnixDay) {
    let files
    if (!fileOrFiles) files = []
    else if (typeof FileList !== 'undefined' && fileOrFiles instanceof FileList) files = Array.from(fileOrFiles)
    else if (Array.isArray(fileOrFiles)) files = fileOrFiles
    else files = [fileOrFiles]
    if (!files.length) return

    // NOTE: do NOT toggle the global spinnerLoadingPage here. The Daily view is
    // wrapped in `v-if="!spinnerLoadingPage"`, so flipping it unmounts the day
    // cards mid-upload and their per-day charts (pie / evolution) never re-render.
    // Uploading a day file must leave the page (and its charts) intact.
    const dateStr = dayjs.unix(dateUnixDay).tz(timeZoneTrade.value).format('YYYY-MM-DD')
    // Continue numbering after any files already saved for this day so display
    // names stay neutral & consistent: "Day summary <date>", then " (2)", " (3)"…
    let seq = dayFiles.filter((d) => Number(d.dateUnixDay) === Number(dateUnixDay)).length
    for (const file of files) {
        const base64 = await fileToBase64(file)
        const safe = (file.name || 'day-summary').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
        // Readable, day-specific R2 name: daysummary_2026-07-27_<file> (the server
        // appends a short UUID + the real extension, e.g. .pdf).
        const up = await useUploadImageToR2(base64, 'daysummary_' + dateStr + '_' + safe)

        const parseObject = Parse.Object.extend('dayFiles')
        const obj = new parseObject()
        obj.set('user', Parse.User.current())
        obj.set('dateUnixDay', Number(dateUnixDay))
        // Neutral per-day display name (not the file's messy original name), with
        // an index when a day has more than one so they stay distinguishable.
        obj.set('filename', 'Day summary ' + dateStr + (seq === 0 ? '' : ' (' + (seq + 1) + ')'))
        seq++
        if (up) { obj.set('url', up.url); obj.set('key', up.key); obj.unset('base64') }
        else { obj.set('base64', base64) }   // R2 not configured -> keep in DB
        obj.setACL(new Parse.ACL(Parse.User.current()))
        await obj.save()
    }
    await useGetDayFiles()
}

export async function useGetDayFiles() {
    dayFiles.length = 0
    const parseObject = Parse.Object.extend('dayFiles')
    const query = new Parse.Query(parseObject)
    query.equalTo('user', Parse.User.current())
    if (selectedRange.value && selectedRange.value.start) {
        query.greaterThanOrEqualTo('dateUnixDay', selectedRange.value.start)
        query.lessThan('dateUnixDay', selectedRange.value.end)
    }
    query.limit(1000)
    const results = await query.find()
    results.forEach((r) => dayFiles.push({
        objectId: r.id,
        dateUnixDay: r.get('dateUnixDay'),
        url: r.get('url'),
        key: r.get('key'),
        filename: r.get('filename'),
        base64: r.get('base64'),
    }))
}

export async function useDeleteDayFile(objectId) {
    if (!objectId || !window.confirm('Delete this day summary?')) return
    const parseObject = Parse.Object.extend('dayFiles')
    const query = new Parse.Query(parseObject)
    query.equalTo('objectId', objectId)
    const r = await query.first()
    if (r) {
        if (r.get('key')) await useDeleteImageFromR2(r.get('key'))
        await r.destroy()
        await useGetDayFiles()
    }
}

/** The first summary file for a given day, or undefined. */
export function useDayFileFor(dateUnixDay) {
    return dayFiles.find((d) => Number(d.dateUnixDay) === Number(dateUnixDay))
}

/** All summary files for a given day (a day can have several). */
export function useDayFilesFor(dateUnixDay) {
    return dayFiles.filter((d) => Number(d.dateUnixDay) === Number(dateUnixDay))
}
