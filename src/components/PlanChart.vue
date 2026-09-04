<script setup>
/**
 * The chart attached to a weekly plan, shown in place: an image as an image, a PDF
 * in an embedded viewer, with the file name under it as a link to the full thing.
 *
 * The PDF preview is the point of the whole column. A link alone meant the chart
 * the plan was written about was one click away at the exact moment the plan was
 * being re-read -- so it was not looked at, which is the failure this page exists
 * to prevent. R2 serves these as `application/pdf` with no attachment disposition,
 * so an iframe renders them inline; a data: URL cannot be embedded (Chrome blocks
 * it) and falls back to the link.
 *
 * One component rather than the same markup inside each of WeeklyPlan's two card
 * types, because those two copies drifted: the history card kept only the image
 * branch, so a PDF attached to a past week rendered nothing at all -- the file was
 * still in R2 and still on the record, and the card even offered a Remove button
 * for it, but there was no way left to open it.
 *
 * Display only. Removing an attachment belongs to the card's file row, next to the
 * picker that would replace it.
 */
import { computed } from 'vue'

const props = defineProps({
    href: { type: String, required: true },
    name: { type: String, default: 'plan.pdf' },
    isImage: { type: Boolean, default: false },
})

/* The picker only ever accepts images and PDFs, so "not an image" means PDF --
   except for a data: URL, which browsers refuse to render in a frame. */
const canEmbed = computed(() => !props.isImage && !props.href.startsWith('data:'))
</script>

<template>
    <div class="planChartCol">
        <!-- A chart you can see without opening anything is the difference between
             re-reading the plan and clicking past it. -->
        <a v-if="isImage" :href="href" target="_blank" rel="noopener" class="planChartLink">
            <img :src="href" :alt="name" class="planChart" loading="lazy">
            <span class="planChartCaption">
                <i class="uil uil-image-v me-1"></i>{{ name }}
                <i class="uil uil-external-link-alt ms-1"></i>
            </span>
        </a>

        <template v-else-if="canEmbed">
            <!-- title, so a screen reader announces the frame as this file rather
                 than as an unnamed embedded document. -->
            <iframe :src="href" :title="name" class="planChartPdf"></iframe>
            <a :href="href" target="_blank" rel="noopener" class="planChartCaption">
                <i class="uil uil-file-alt me-1"></i>{{ name }}
                <i class="uil uil-external-link-alt ms-1"></i>
            </a>
        </template>

        <a v-else :href="href" target="_blank" rel="noopener" class="planChartFile">
            <i class="uil uil-file-alt me-1"></i>{{ name }}
            <i class="uil uil-external-link-alt ms-1"></i>
        </a>
    </div>
</template>

<style scoped>
.planChartLink {
    display: block;
}

.planChart {
    display: block;
    width: 100%;
    max-height: 24rem;
    object-fit: contain;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
}

/* Same height as an image chart, so a card carrying a PDF and one carrying a
   screenshot sit at the same size in the list instead of jumping. */
.planChartPdf {
    display: block;
    width: 100%;
    height: 24rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: #fff;
}

.planChartCaption {
    display: block;
    margin-top: 0.4rem;
    font-size: 0.8rem;
    color: #2f9bff;
    text-decoration: none;
}

.planChartLink:hover .planChartCaption,
a.planChartCaption:hover {
    text-decoration: underline;
}

/* The fallback, for a file that cannot be framed. Nothing is shown, so the link
   itself has to look like the attachment it stands for -- unstyled it read as
   stray text in the middle of the card. */
.planChartFile {
    display: inline-flex;
    align-items: center;
    gap: 0.1rem;
    padding: 0.5rem 0.7rem;
    font-size: 0.85rem;
    color: #2f9bff;
    background: rgba(47, 155, 255, 0.08);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    text-decoration: none;
    word-break: break-all;
}

.planChartFile:hover {
    text-decoration: underline;
}
</style>
