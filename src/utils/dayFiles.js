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

/** Upload one file as the summary for `dateUnixDay` (start-of-day unix). Replaces
 *  any existing summary for that day so a day has a single current file. */
export async function useUploadDayFile(file, dateUnixDay) {
    if (!file) return
    spinnerLoadingPage.value = true
    try {
        const base64 = await fileToBase64(file)
        const safe = (file.name || 'day-summary').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
        // Readable, day-specific R2 name: daysummary_2026-07-27_<file> (the server
        // appends a short UUID + the real extension, e.g. .pdf).
        const dateStr = dayjs.unix(dateUnixDay).tz(timeZoneTrade.value).format('YYYY-MM-DD')
        const up = await useUploadImageToR2(base64, 'daysummary_' + dateStr + '_' + safe)

        // Replace an existing summary for this day (one file per day).
        const parseObject = Parse.Object.extend('dayFiles')
        const existingQ = new Parse.Query(parseObject)
        existingQ.equalTo('user', Parse.User.current())
        existingQ.equalTo('dateUnixDay', Number(dateUnixDay))
        const existing = await existingQ.first()
        const obj = existing || new parseObject()

        if (existing && existing.get('key') && (!up || existing.get('key') !== up.key)) {
            await useDeleteImageFromR2(existing.get('key'))
        }
        obj.set('user', Parse.User.current())
        obj.set('dateUnixDay', Number(dateUnixDay))
        // Neutral, per-day display name (not the original file's messy name), so
        // every day's summary reads consistently. The real file still keeps its
        // extension on R2.
        obj.set('filename', 'Day summary ' + dateStr)
        if (up) { obj.set('url', up.url); obj.set('key', up.key); obj.unset('base64') }
        else { obj.set('base64', base64) }   // R2 not configured -> keep in DB
        obj.setACL(new Parse.ACL(Parse.User.current()))
        await obj.save()
        await useGetDayFiles()
    } finally {
        spinnerLoadingPage.value = false
    }
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

/** The summary file for a given day, or undefined. */
export function useDayFileFor(dateUnixDay) {
    return dayFiles.find((d) => Number(d.dateUnixDay) === Number(dateUnixDay))
}
