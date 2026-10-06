/**
 * The playhead and transport. The preview <video> registers itself here; the timeline, transcript
 * and keyboard shortcuts drive playback through these functions.
 * When no preview file exists yet the playhead still runs on a clock, so the transcript follows along.
 */
import { editor } from './editor'
import { currentDerived } from './derived'

let video: HTMLVideoElement | null = null
let raf = 0
let clockStart = 0
let clockFrom = 0
let reverseTimer: ReturnType<typeof setInterval> | null = null

function duration(): number {
  return currentDerived()?.duration ?? (video && isFinite(video.duration) ? video.duration : 0)
}

function fps(): number {
  return currentDerived()?.fps ?? 30
}

export function attachVideo(v: HTMLVideoElement | null): void {
  video = v
  if (v) {
    v.playbackRate = Math.max(0.25, Math.abs(editor.get().rate))
  }
}

function tick() {
  const s = editor.get()
  if (!s.playing) return
  let t: number
  if (video && video.src && video.readyState > 0) {
    t = video.currentTime
    if (video.ended) {
      pause()
      return
    }
  } else {
    t = clockFrom + ((performance.now() - clockStart) / 1000) * Math.abs(s.rate)
    if (t >= duration()) {
      editor.set({ playhead: duration() })
      pause()
      return
    }
  }
  if (Math.abs(t - s.playhead) > 1e-4) editor.set({ playhead: t })
  raf = requestAnimationFrame(tick)
}

export function seek(t: number): void {
  const time = Math.max(0, Math.min(duration() || t, t))
  editor.set({ playhead: time })
  clockFrom = time
  clockStart = performance.now()
  if (video && video.src && video.readyState > 0) video.currentTime = time
}

export function play(rate = 1): void {
  stopReverse()
  if (rate < 0) {
    reverse()
    return
  }
  const s = editor.get()
  if (s.playhead >= duration() - 0.05) seek(0)
  editor.set({ playing: true, rate })
  clockFrom = editor.get().playhead
  clockStart = performance.now()
  if (video && video.src) {
    video.playbackRate = rate
    video.play().catch(() => undefined)
  }
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(tick)
}

export function pause(): void {
  stopReverse()
  cancelAnimationFrame(raf)
  if (video && !video.paused) video.pause()
  editor.set({ playing: false, rate: 1 })
}

export function toggle(): void {
  if (editor.get().playing) pause()
  else play(1)
}

export function stepFrames(n: number): void {
  pause()
  seek(editor.get().playhead + n / fps())
}

/** J: play backwards by stepping frames (browsers cannot play video in reverse). Press again to go faster. */
function reverse(): void {
  const cur = editor.get()
  const speed = cur.rate < 0 ? Math.min(8, Math.abs(cur.rate) * 2) : 1
  cancelAnimationFrame(raf)
  if (video && !video.paused) video.pause()
  editor.set({ playing: true, rate: -speed })
  const interval = 1000 / 15
  reverseTimer = setInterval(() => {
    const t = editor.get().playhead - (speed * interval) / 1000
    if (t <= 0) {
      seek(0)
      pause()
      return
    }
    seek(t)
  }, interval)
}

function stopReverse(): void {
  if (reverseTimer) clearInterval(reverseTimer)
  reverseTimer = null
}

/** J K L shuttle. */
export function shuttle(key: 'j' | 'k' | 'l'): void {
  const s = editor.get()
  if (key === 'k') {
    pause()
    return
  }
  if (key === 'l') {
    const rate = s.playing && s.rate > 0 ? Math.min(4, s.rate * 2) : 1
    play(rate)
    return
  }
  if (s.playing && s.rate < 0) {
    stopReverse()
    reverse()
  } else {
    pause()
    reverse()
  }
}

/** Called by the preview when its file is replaced: keep the moment you were at. */
export function videoReloaded(): void {
  if (!video) return
  const s = editor.get()
  if (video.readyState > 0) video.currentTime = s.playhead
  if (s.playing && s.rate > 0) {
    video.playbackRate = s.rate
    video.play().catch(() => undefined)
  }
}
