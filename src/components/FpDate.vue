<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import flatpickr from 'flatpickr'
import monthSelectPlugin from 'flatpickr/dist/plugins/monthSelect/index.js'
import 'flatpickr/dist/plugins/monthSelect/style.css'

const props = defineProps({
    modelValue: { type: [String, Number], default: '' },
    mode: { type: String, default: 'datetime' }, // 'datetime' | 'date' | 'month'
    placeholder: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

const inputEl = ref(null)
let fp = null

function buildOptions() {
    const base = {
        allowInput: true,
        disableMobile: true,
        // Use the < > arrows to change month (no native white dropdown) for a consistent look
        monthSelectorType: 'static',
        onChange: (_dates, dateStr) => {
            if (dateStr !== String(props.modelValue)) emit('update:modelValue', dateStr)
        }
    }
    if (props.mode === 'datetime') {
        // Machine value stays 24h ("Y-m-d H:i") so dayjs parses it reliably;
        // the visible altInput shows a friendly AM/PM format.
        return { ...base, enableTime: true, dateFormat: 'Y-m-d H:i', altInput: true, altFormat: 'M j, Y  h:i K' }
    }
    if (props.mode === 'month') {
        return {
            ...base,
            plugins: [new monthSelectPlugin({ shorthand: true, dateFormat: 'Y-m', altFormat: 'F Y' })]
        }
    }
    // date
    return { ...base, dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y' }
}

onMounted(() => {
    fp = flatpickr(inputEl.value, buildOptions())
    if (props.modelValue) fp.setDate(props.modelValue, false)
})

onBeforeUnmount(() => {
    if (fp) fp.destroy()
})

// Keep the picker in sync when the value changes from outside
watch(() => props.modelValue, (val) => {
    if (fp && val !== (fp.input.value || '')) {
        fp.setDate(val || '', false)
    }
})
</script>

<template>
    <input ref="inputEl" type="text" class="form-control" :placeholder="placeholder" :value="modelValue" />
</template>
