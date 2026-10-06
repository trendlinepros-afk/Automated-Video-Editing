/** A waveform drawn on a canvas for just the visible part of an audio item. */
import { useEffect, useRef } from 'react'
import { loadPeaks } from './peaks'

export function Waveform(props: {
  source: { sourceId?: string; file?: string }
  /** Left edge of the canvas inside the item, in px. */
  left: number
  width: number
  /** Source time at the canvas's left edge, and source seconds per pixel. */
  srcStart: number
  srcPerPx: number
  /** Loop length in source seconds (music set to loop), if any. */
  loopLength?: number
  gainDb: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { source, left, width, srcStart, srcPerPx, loopLength, gainDb } = props
  const sourceId = source.sourceId
  const file = source.file

  useEffect(() => {
    let alive = true
    const w = Math.max(1, Math.min(8192, Math.round(width)))
    void loadPeaks({ sourceId, file }).then((p) => {
      const c = ref.current
      if (!alive || !c || !p || !p.peaks.length) return
      const h = c.clientHeight || 30
      const dpr = window.devicePixelRatio || 1
      c.width = w * dpr
      c.height = h * dpr
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      const gain = Math.min(2, Math.pow(10, gainDb / 20))
      const mid = h / 2
      const n = p.peaks.length
      const pps = p.peaksPerSecond
      for (let x = 0; x < w; x++) {
        let a = srcStart + x * srcPerPx
        let b = a + srcPerPx
        if (loopLength && loopLength > 0) {
          a %= loopLength
          b = a + srcPerPx
        }
        const i0 = Math.max(0, Math.floor(a * pps))
        const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(b * pps)))
        if (i0 >= n) break
        let m = 0
        for (let i = i0; i < i1; i++) {
          const v = Math.abs(p.peaks[i])
          if (v > m) m = v
        }
        const bar = Math.max(0.5, Math.min(1, m * gain) * (h / 2 - 1))
        ctx.fillRect(x, mid - bar, 1, bar * 2)
      }
    })
    return () => {
      alive = false
    }
  }, [sourceId, file, width, srcStart, srcPerPx, loopLength, gainDb])

  return <canvas ref={ref} style={{ left, width: Math.max(1, Math.round(width)) }} />
}
