/**
 * Demo day QR code overlay — shown only when ?demo=1 is in the URL.
 * Renders a simple SVG QR-like placeholder; real QR generated server-side
 * or via a lightweight library in production.
 *
 * Usage: Add <DemoQR /> to Welcome.tsx when demoing from a poster/projector.
 */
import { useEffect, useState } from 'react'

export function DemoQR() {
  const [show, setShow] = useState(false)
  const [url, setUrl] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('demo') === '1') {
      setShow(true)
      setUrl(window.location.origin)
    }
  }, [])

  if (!show) return null

  // Simple visual QR placeholder — replace with qrcode.react if needed
  return (
    <div className="fixed bottom-6 right-4 z-50 flex flex-col items-center gap-1">
      <div className="bg-white rounded-xl p-2 shadow-xl">
        {/* 7×7 placeholder grid approximating a QR code */}
        <svg width="72" height="72" viewBox="0 0 7 7" xmlns="http://www.w3.org/2000/svg">
          {/* Top-left finder */}
          <rect x="0" y="0" width="3" height="3" fill="#000" />
          <rect x="1" y="1" width="1" height="1" fill="#fff" />
          {/* Top-right finder */}
          <rect x="4" y="0" width="3" height="3" fill="#000" />
          <rect x="5" y="1" width="1" height="1" fill="#fff" />
          {/* Bottom-left finder */}
          <rect x="0" y="4" width="3" height="3" fill="#000" />
          <rect x="1" y="5" width="1" height="1" fill="#fff" />
          {/* Data cells (illustrative) */}
          <rect x="3" y="3" width="1" height="1" fill="#000" />
          <rect x="4" y="3" width="1" height="1" fill="#000" />
          <rect x="3" y="4" width="1" height="1" fill="#000" />
          <rect x="5" y="4" width="1" height="1" fill="#000" />
          <rect x="6" y="5" width="1" height="1" fill="#000" />
          <rect x="4" y="6" width="1" height="1" fill="#000" />
          <rect x="6" y="6" width="1" height="1" fill="#000" />
        </svg>
      </div>
      <p className="text-[9px] text-white/50 bg-black/60 px-2 py-0.5 rounded-full max-w-[80px] text-center truncate">
        {url}
      </p>
      <p className="text-[9px] text-gold-400 font-semibold">Scan to try</p>
    </div>
  )
}
