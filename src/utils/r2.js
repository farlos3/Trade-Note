/****************************************************************************************
 * CLOUDFLARE R2 IMAGE STORAGE (client helpers)
 * --------------------------------------------------------------------------------------
 * Screenshots are uploaded to R2 through the server endpoints in index.mjs (the secret
 * R2 keys never reach the browser). MongoDB then stores only the public URL + object key
 * instead of the heavy base64 blob.
 *
 * Graceful fallback: if R2 isn't configured on the server, /api/uploadImage returns
 * { disabled: true } and the caller keeps storing base64 as before.
 ****************************************************************************************/
import axios from 'axios'

/**
 * Uploads a base64 data URL to R2.
 * @returns { url, key } on success, or null if R2 is disabled / upload failed.
 */
export async function useUploadImageToR2(base64, keyHint) {
    if (!base64 || typeof base64 !== 'string' || !base64.startsWith('data:')) {
        return null // not a data URL (e.g. already an http URL) -> nothing to upload
    }
    try {
        const res = await axios.post('/api/uploadImage', { base64, keyHint })
        if (res.data && res.data.disabled) return null
        if (res.data && res.data.url) return { url: res.data.url, key: res.data.key }
        return null
    } catch (error) {
        console.error(' -> R2 upload failed', error)
        return null
    }
}

export async function useDeleteImageFromR2(key) {
    if (!key) return
    try {
        await axios.post('/api/deleteImage', { key })
    } catch (error) {
        console.error(' -> R2 delete failed', error)
    }
}

/* True when a stored field already points at a remote image (R2) rather than base64. */
export function useIsRemoteImage(value) {
    return typeof value === 'string' && /^https?:\/\//.test(value)
}
