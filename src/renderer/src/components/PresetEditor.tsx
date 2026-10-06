/** Export preset fields: resolution, frame rate, quality and codec. Used by profiles and the Export dialog. */
import type { ExportPreset } from '@shared/project'

export const PRESETS: ExportPreset[] = [
  { name: '4K 60 fps', width: 3840, height: 2160, fps: 60, quality: 'best', codec: 'h264' },
  { name: '4K 30 fps', width: 3840, height: 2160, fps: 30, quality: 'best', codec: 'h264' },
  { name: '1440p 60 fps', width: 2560, height: 1440, fps: 60, quality: 'best', codec: 'h264' },
  { name: '1080p 60 fps', width: 1920, height: 1080, fps: 60, quality: 'good', codec: 'h264' },
  { name: '1080p 30 fps', width: 1920, height: 1080, fps: 30, quality: 'good', codec: 'h264' },
  { name: 'Shorts 1080x1920', width: 1080, height: 1920, fps: 60, quality: 'good', codec: 'h264' }
]

function presetName(p: ExportPreset): string {
  const known = PRESETS.find((k) => k.width === p.width && k.height === p.height && k.fps === p.fps)
  if (known) return known.name
  return `${p.width}x${p.height} ${p.fps} fps`
}

export function PresetEditor({ value, onChange, disabled }: { value: ExportPreset; onChange: (p: ExportPreset) => void; disabled?: boolean }) {
  const match = PRESETS.find((k) => k.width === value.width && k.height === value.height && k.fps === value.fps)
  const set = (patch: Partial<ExportPreset>) => {
    const next = { ...value, ...patch }
    onChange({ ...next, name: presetName(next) })
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap">
        <select
          disabled={disabled}
          value={match ? match.name : 'custom'}
          onChange={(e) => {
            const p = PRESETS.find((k) => k.name === e.target.value)
            if (p) onChange({ ...value, ...p })
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          {!match && <option value="custom">Custom: {presetName(value)}</option>}
        </select>
        <select disabled={disabled} value={value.quality} onChange={(e) => set({ quality: e.target.value as ExportPreset['quality'] })} title="Quality">
          <option value="best">Best quality</option>
          <option value="good">Good quality</option>
          <option value="draft">Draft quality</option>
        </select>
        <select disabled={disabled} value={value.codec} onChange={(e) => set({ codec: e.target.value as ExportPreset['codec'] })} title="Codec">
          <option value="h264">H.264 (works everywhere)</option>
          <option value="hevc">HEVC (smaller files)</option>
        </select>
      </div>
      <div className="row small muted">
        <span>Size</span>
        <input type="number" disabled={disabled} style={{ width: 80 }} value={value.width} min={16} step={2} onChange={(e) => set({ width: Math.max(16, parseInt(e.target.value) || value.width) })} />
        <span>×</span>
        <input type="number" disabled={disabled} style={{ width: 80 }} value={value.height} min={16} step={2} onChange={(e) => set({ height: Math.max(16, parseInt(e.target.value) || value.height) })} />
        <span>at</span>
        <input type="number" disabled={disabled} style={{ width: 64 }} value={value.fps} min={1} max={120} onChange={(e) => set({ fps: Math.max(1, parseFloat(e.target.value) || value.fps) })} />
        <span>fps</span>
      </div>
    </div>
  )
}

export const CAPTION_EXPORT_LABELS: Record<'burn' | 'srt' | 'both' | 'none', string> = {
  burn: 'Burned into the video',
  srt: 'Separate subtitle file (for YouTube)',
  both: 'Both',
  none: 'No captions'
}
