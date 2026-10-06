/**
 * The other Pikzels tools in the Thumbnails tab: recreate from an image, edit (with a painted mask),
 * face swap, and title options. Each result is downloaded into the project and kept in History.
 */
import { useEffect, useRef, useState } from 'react'
import type { PikzelsPricing } from '@shared/ipc'
import type { Thumbnail } from '@shared/project'
import { call, toast } from '../state/app'
import { editor } from '../state/editor'
import { Icon } from '../components/Icon'
import { IMAGE_EXTS, basename, errorMessage, fmt, mediaUrl } from '../util'
import { costLabel } from './ThumbnailsPanelCosts'

export type ToolName = 'recreate' | 'edit' | 'faceswap' | 'titles'

export const TOOL_LABELS: Record<ToolName, string> = { recreate: 'Recreate', edit: 'Edit', faceswap: 'Face swap', titles: 'Titles' }

interface ToolProps {
  pricing: PikzelsPricing | null
  model: string
  dir: string
  /** The thumbnail the tool works on (chosen with the buttons on each option). */
  target: Thumbnail | null
  thumbs: Thumbnail[]
  setTarget: (id: string | null) => void
  disabled: boolean
  onDone: () => void
}

async function pickImage(title: string): Promise<string | null> {
  const files = await call(() => window.api.app.pickFiles({ title, filters: [{ name: 'Images', extensions: IMAGE_EXTS }] }))
  return files?.[0] ?? null
}

/** Run an action, toast the result and refresh the totals. */
async function run(label: string, fn: () => Promise<unknown>, done: () => void, ok: string): Promise<void> {
  try {
    await fn()
    toast(ok)
  } catch (e) {
    toast(`${label}: ${errorMessage(e)}`, { kind: 'error' })
  }
  done()
}

function TargetPicker({ target, thumbs, setTarget, dir, allowFile, file, setFile }: Pick<ToolProps, 'target' | 'thumbs' | 'setTarget' | 'dir'> & { allowFile?: boolean; file?: string | null; setFile?: (f: string | null) => void }) {
  const done = thumbs.filter((t) => t.status === 'done' && t.file)
  return (
    <div className="row">
      {target?.file ? <img src={mediaUrl(target.file, dir)} alt="" style={{ width: 96, borderRadius: 4 }} /> : file ? <img src={mediaUrl(file)} alt="" style={{ width: 96, borderRadius: 4 }} /> : null}
      <select
        className="grow"
        value={target?.id ?? (file ? '__file' : '')}
        onChange={(e) => {
          if (e.target.value === '__pick') {
            void pickImage('Choose an image').then((f) => {
              if (f) {
                setTarget(null)
                setFile?.(f)
              }
            })
          } else if (e.target.value !== '__file') {
            setFile?.(null)
            setTarget(e.target.value || null)
          }
        }}
      >
        <option value="">Choose a thumbnail…</option>
        {done
          .slice()
          .reverse()
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.prompt.slice(0, 50)}
            </option>
          ))}
        {file && <option value="__file">{basename(file)}</option>}
        {allowFile && <option value="__pick">An image file…</option>}
      </select>
    </div>
  )
}

export function RecreateTool(p: ToolProps) {
  const [from, setFrom] = useState<'thumbnail' | 'file' | 'frame' | 'youtube'>('frame')
  const [file, setFile] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [prompt, setPrompt] = useState('')
  const [weight, setWeight] = useState<'low' | 'medium' | 'high'>('medium')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (p.target) setFrom('thumbnail')
  }, [p.target])
  const playhead = editor.get().playhead
  const ready = from === 'thumbnail' ? !!p.target : from === 'file' ? !!file : from === 'youtube' ? /^https?:\/\//i.test(url.trim()) : true
  const go = async () => {
    setBusy(true)
    const src =
      from === 'thumbnail' ? { thumbnailId: p.target!.id } : from === 'file' ? { path: file! } : from === 'youtube' ? { url: url.trim() } : { time: editor.get().playhead }
    await run('Recreate', () => window.api.thumbnails.recreate({ from: src, prompt: prompt.trim() || undefined, model: p.model, imageWeight: p.model === 'pkz_2' ? weight : undefined }), p.onDone, 'Recreated. The new image is in History.')
    setBusy(false)
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="seg">
        {(['frame', 'thumbnail', 'file', 'youtube'] as const).map((k) => (
          <button key={k} className={from === k ? 'on' : ''} onClick={() => setFrom(k)}>
            {{ frame: 'Video frame', thumbnail: 'Thumbnail', file: 'Image file', youtube: 'YouTube link' }[k]}
          </button>
        ))}
      </div>
      {from === 'frame' && <span className="small">The frame at the playhead ({fmt(playhead)}).</span>}
      {from === 'thumbnail' && <TargetPicker {...p} />}
      {from === 'file' && (
        <div className="row">
          <button className="btn small" onClick={() => void pickImage('Choose an image to recreate').then(setFile)}>
            Choose image
          </button>
          <span className="small ellipsis grow">{file ? basename(file) : 'No image chosen'}</span>
        </div>
      )}
      {from === 'youtube' && <input type="text" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} />}
      <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What to change or keep (optional), e.g. put me in it, red text" />
      {p.model === 'pkz_2' && (
        <div className="row small">
          <span className="label">Follow the image</span>
          <select value={weight} onChange={(e) => setWeight(e.target.value as typeof weight)}>
            <option value="low">A little</option>
            <option value="medium">Medium</option>
            <option value="high">Closely</option>
          </select>
        </div>
      )}
      <div className="row">
        <span className="spacer" />
        <button className="btn primary small" disabled={p.disabled || busy || !ready} onClick={go}>
          <Icon name="sparkle" size={13} /> {busy ? 'Working…' : `Recreate${costLabel(p.pricing, 'recreate', p.model)}`}
        </button>
      </div>
    </div>
  )
}

/** Paint where the image may change. The mask is sent as white on black at the image's own size. */
function MaskPainter({ src, onMask }: { src: string; onMask: (b64: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [brush, setBrush] = useState(0.05)
  const drawing = useRef(false)
  const painted = useRef(false)

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
  }
  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current
    if (!c || !drawing.current) return
    const g = c.getContext('2d')!
    const { x, y } = point(e)
    g.fillStyle = 'rgba(255, 70, 70, 0.55)'
    g.beginPath()
    g.arc(x, y, brush * c.width, 0, Math.PI * 2)
    g.fill()
    painted.current = true
  }
  const exportMask = () => {
    const c = canvas.current
    if (!c || !painted.current) return onMask(null)
    const out = document.createElement('canvas')
    out.width = c.width
    out.height = c.height
    const src = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
    const g = out.getContext('2d')!
    const img = g.createImageData(c.width, c.height)
    for (let i = 0; i < src.data.length; i += 4) {
      const v = src.data[i + 3] > 0 ? 255 : 0
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
    onMask(out.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''))
  }
  const clear = () => {
    const c = canvas.current
    if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    painted.current = false
    onMask(null)
  }
  return (
    <div className="col" style={{ gap: 4 }}>
      <div style={{ position: 'relative' }}>
        <img src={src} alt="" style={{ width: '100%', display: 'block', borderRadius: 4 }} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {size && (
          <canvas
            ref={canvas}
            width={size.w}
            height={size.h}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={(e) => {
              drawing.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              paint(e)
            }}
            onPointerMove={paint}
            onPointerUp={() => {
              drawing.current = false
              exportMask()
            }}
          />
        )}
      </div>
      <div className="row tiny">
        <span className="faint grow">Paint over the part to change (optional). Without a mask Pikzels decides.</span>
        <select value={brush} onChange={(e) => setBrush(Number(e.target.value))} title="Brush size">
          <option value={0.02}>Small brush</option>
          <option value={0.05}>Medium brush</option>
          <option value={0.1}>Big brush</option>
        </select>
        <a onClick={clear}>Clear</a>
      </div>
    </div>
  )
}

export function EditTool(p: ToolProps) {
  const [file, setFile] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [mask, setMask] = useState<string | null>(null)
  const [support, setSupport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const src = p.target?.file ? mediaUrl(p.target.file, p.dir) : file ? mediaUrl(file) : undefined
  useEffect(() => setMask(null), [p.target?.id, file])
  const go = async () => {
    setBusy(true)
    await run(
      'Edit',
      () => window.api.thumbnails.edit({ thumbnailId: p.target?.id, imagePath: p.target ? undefined : file ?? undefined, prompt: prompt.trim(), maskBase64: mask ?? undefined, supportImagePath: support ?? undefined }),
      p.onDone,
      'Edited. The new image is in History; the original stays.'
    )
    setBusy(false)
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <TargetPicker {...p} allowFile file={file} setFile={setFile} />
      {src && <MaskPainter key={src} src={src} onMask={setMask} />}
      <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="The change, e.g. make the text say IT EXPLODED" />
      <div className="row small">
        <button className="btn small ghost" onClick={() => void pickImage('Choose a support image').then(setSupport)}>
          {support ? basename(support) : 'Support image (optional)'}
        </button>
        {support && <a onClick={() => setSupport(null)}>Remove</a>}
        <span className="spacer" />
        <button className="btn primary small" disabled={p.disabled || busy || !prompt.trim() || (!p.target && !file)} onClick={go}>
          <Icon name="wand" size={13} /> {busy ? 'Working…' : `Edit${costLabel(p.pricing, 'edit')}`}
        </button>
      </div>
    </div>
  )
}

export function FaceSwapTool(p: ToolProps) {
  const [file, setFile] = useState<string | null>(null)
  const [face, setFace] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    await run('Face swap', () => window.api.thumbnails.faceSwap({ thumbnailId: p.target?.id, imagePath: p.target ? undefined : file ?? undefined, facePath: face! }), p.onDone, 'Face swapped. The new image is in History.')
    setBusy(false)
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <TargetPicker {...p} allowFile file={file} setFile={setFile} />
      <div className="row">
        {face && <img src={mediaUrl(face)} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4 }} />}
        <button className="btn small" onClick={() => void pickImage('Choose a photo of the face').then(setFace)}>
          {face ? 'Another face photo' : 'Choose face photo'}
        </button>
        <span className="spacer" />
        <button className="btn primary small" disabled={p.disabled || busy || !face || (!p.target && !file)} onClick={go}>
          {busy ? 'Working…' : `Swap face${costLabel(p.pricing, 'faceswap')}`}
        </button>
      </div>
      <span className="hint">Only you can start a face swap; Claude never does.</span>
    </div>
  )
}

export function TitlesTool(p: ToolProps & { chosenId?: string }) {
  const [prompt, setPrompt] = useState('')
  const [withThumb, setWithThumb] = useState(true)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<string[]>([])
  const thumbId = p.target?.id ?? p.chosenId
  const go = async () => {
    setBusy(true)
    try {
      const titles = await window.api.thumbnails.titles({ prompt: prompt.trim() || undefined, thumbnailId: withThumb ? thumbId : undefined })
      setOut(titles)
      toast(`${titles.length} title options added to the Publish tab.`)
    } catch (e) {
      toast(`Titles: ${errorMessage(e)}`, { kind: 'error' })
    }
    p.onDone()
    setBusy(false)
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What the video is about (optional). Empty: the start of the transcript is used." />
      {thumbId && (
        <label className="row small">
          <input type="checkbox" checked={withThumb} onChange={(e) => setWithThumb(e.target.checked)} /> Show Pikzels the {p.target ? 'selected' : 'chosen'} thumbnail too
        </label>
      )}
      <div className="row">
        <span className="spacer" />
        <button className="btn primary small" disabled={p.disabled || busy} onClick={go}>
          {busy ? 'Working…' : `Generate titles${costLabel(p.pricing, 'title')}`}
        </button>
      </div>
      {out.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {out.map((t) => (
            <li key={t} className="selectable">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
