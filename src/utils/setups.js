/**
 * Trade setups: the trader's library of named entry patterns ("Follow Trend",
 * "Liquidity Sweep (Buy)", "Trump Trump"...), each a checklist of rules plus the
 * diagram it is drawn from. This is what the Setup tab shows.
 *
 * Its own class rather than the old `playbooks` one. A playbook entry is dated
 * long-form text, one per day -- a journal. A setup is named, has no date, and
 * stays the same until the trader changes the rules; it is a reference card,
 * not a record of a day.
 *
 * Rules are stored structured, `[{ text, sub: [text] }]`, because the cards read
 * as numbered rules with lettered sub-points and a flat string would lose that.
 * They are edited as plain text (see rulesToText / textToRules): one rule per
 * line, and a line starting with whitespace or "-" is a sub-point of the rule
 * above it.
 */
import Parse from 'parse/dist/parse.min.js'
import { useUploadImageToR2, useDeleteImageFromR2 } from './r2.js'

const CLASS = 'setups'

function currentUserOrNull() {
    try {
        return Parse.User.current()
    } catch {
        return null
    }
}

const shape = (r) => ({
    objectId: r.id,
    name: r.get('name') || '',
    side: r.get('side') || 'any',
    rules: Array.isArray(r.get('rules')) ? r.get('rules') : [],
    imageUrl: r.get('imageUrl') || '',
    imageKey: r.get('imageKey') || '',
    order: Number(r.get('order')) || 0,
})

/** Every setup, in the trader's order (then oldest first, so new ones land last). */
export async function useGetSetups(limit = 200) {
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    query.equalTo('user', currentUserOrNull())
    query.ascending('order')
    query.addAscending('createdAt')
    query.limit(limit)
    return (await query.find()).map(shape)
}

/** Structured rules -> the editable text form. */
export function rulesToText(rules) {
    return (rules || []).map((r) => [r.text, ...(r.sub || []).map((s) => '  - ' + s)].join('\n')).join('\n')
}

/** The editable text form -> structured rules. Blank lines are ignored; a sub-point
 *  with no rule above it becomes a rule of its own rather than being dropped. */
export function textToRules(text) {
    const rules = []
    for (const raw of String(text || '').split('\n')) {
        if (!raw.trim()) continue
        const isSub = /^\s+/.test(raw) || /^\s*-\s/.test(raw)
        const clean = raw.trim().replace(/^-\s*/, '')
        if (isSub && rules.length) rules[rules.length - 1].sub.push(clean)
        else rules.push({ text: clean, sub: [] })
    }
    return rules
}

/**
 * Create or update. `imageData` is a data: URL from the file picker when the
 * image was replaced; it is uploaded to R2 and the previous object deleted AFTER
 * the record no longer points at it, so a failed save never leaves a dead link.
 */
export async function useSaveSetup({ objectId, name, side, rules, order, imageData, removeImage }) {
    const parseObject = Parse.Object.extend(CLASS)
    let obj
    if (objectId) {
        obj = await new Parse.Query(parseObject).get(objectId)
    } else {
        obj = new parseObject()
        obj.set('user', currentUserOrNull())
        obj.setACL(new Parse.ACL(currentUserOrNull()))
    }
    obj.set('name', (name || '').trim())
    obj.set('side', side || 'any')
    obj.set('rules', rules || [])
    if (order !== undefined) obj.set('order', Number(order) || 0)

    const previousKey = (imageData || removeImage) ? obj.get('imageKey') : null
    if (imageData) {
        const safe = (name || 'setup').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
        const up = await useUploadImageToR2(imageData, 'setup_' + safe)
        // R2 off: keep the data URL in the record itself, like weekly plans do.
        obj.set('imageUrl', up ? up.url : imageData)
        obj.set('imageKey', up ? up.key : '')
    } else if (removeImage) {
        obj.set('imageUrl', '')
        obj.set('imageKey', '')
    }
    const saved = await obj.save()
    if (previousKey && previousKey !== saved.get('imageKey')) await useDeleteImageFromR2(previousKey)
    return shape(saved)
}

export async function useDeleteSetup(setup) {
    const obj = await new Parse.Query(Parse.Object.extend(CLASS)).get(setup.objectId)
    await obj.destroy()
    if (setup.imageKey) await useDeleteImageFromR2(setup.imageKey)
}
