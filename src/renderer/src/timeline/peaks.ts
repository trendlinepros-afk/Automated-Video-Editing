/** Waveform peaks from the app (cached per source or file). */
export interface Peaks {
  peaksPerSecond: number
  peaks: number[]
}

const cache = new Map<string, Promise<Peaks | null>>()

export function peaksKey(k: { sourceId?: string; file?: string }): string {
  return k.sourceId ? `s:${k.sourceId}` : `f:${k.file ?? ''}`
}

export function loadPeaks(k: { sourceId?: string; file?: string }): Promise<Peaks | null> {
  const key = peaksKey(k)
  let p = cache.get(key)
  if (!p) {
    p = window.api.project.waveform(k).catch(() => null)
    cache.set(key, p)
    // A missing waveform may appear once the app has built it; ask again later.
    void p.then((r) => {
      if (!r) setTimeout(() => cache.delete(key), 15000)
    })
  }
  return p
}

/** Forget cached peaks (a project was closed or a file swapped). */
export function clearPeaks(): void {
  cache.clear()
}
