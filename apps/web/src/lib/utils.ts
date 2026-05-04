/**
 * Reducer for image payloads to avoid 413/400 errors from backend.
 * Scales image so max(w,h) <= maxPx and applies JPEG compression.
 */
export function resizeDataUrl(dataUrl: string, maxPx: number, quality: number = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas context failed'))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      try {
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = (e) => reject(new Error('Failed to load image for resizing'))
    img.src = dataUrl
  })
}
