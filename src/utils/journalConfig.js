/**
 * Journal prompts that can be switched off.
 *
 * These gates are deliberately hard to dismiss while they are on -- that is the
 * whole point of them -- so the decision to not be asked at all belongs here,
 * made once and on purpose, rather than in a "don't show again" checkbox that
 * gets clicked past in the moment the prompt was meant to interrupt.
 *
 * A flag turns off the ASKING, never the recording. With `review` off nothing
 * pops up on Monday and the page stops saying a re-read is due, but the week's
 * "Mark reviewed" button, the written re-check it requires, and the Reviewed
 * badge all still work -- so a plan can still be reviewed deliberately, it just
 * is not demanded.
 */
export const weeklyGateConfig = {
    /** Last week has a summary but no written reflection on it. */
    reflection: true,

    /**
     * Monday from 06:00: this week's plan has not been re-read.
     *
     * Off. The other two gates ask for something that does not exist yet -- a
     * reflection, a plan -- so they cannot be satisfied in advance. This one asks
     * you to re-read a plan you already wrote, which makes it the one gate whose
     * answer is a formality on any week you already know your plan, and a gate
     * answered by reflex teaches dismissal and weakens the two that matter.
     */
    review: false,

    /** Friday 23:59 through Sunday: next week's plan (text + chart) is missing. */
    plan: true,
}
