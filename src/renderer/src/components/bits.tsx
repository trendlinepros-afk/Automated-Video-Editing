/** Small shared controls. */
import { useEffect, useState, type ReactNode } from 'react'
import { call, toast } from '../state/app'
import { parseTime } from '@shared/timeline'
import { fmt } from '../util'
import { Icon } from './Icon'

export function ProfileChip({ name, color }: { name?: string; color?: string }) {
  if (!name) return <span className="chip">No profile</span>
  return (
    <span className="chip">
      <span className="dot" style={{ background: color ?? 'var(--accent)' }} />
      {name}
    </span>
  )
}

export function CopyButton({ text, label = 'Copy', small = true }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`btn${small ? ' small' : ''}`}
      disabled={!text}
      onClick={async () => {
        await call(() => window.api.app.copyText(text))
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {done ? 'Copied' : label}
    </button>
  )
}

/** A time field that accepts "1:02.5", "62.5" or "1m2s". Commits on Enter or when you leave it. */
export function TimeInput({ value, onCommit, disabled, ms = true }: { value: number; onCommit: (t: number) => void; disabled?: boolean; ms?: boolean }) {
  const [text, setText] = useState(fmt(value, ms))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(fmt(value, ms))
  }, [value, editing, ms])
  const commit = () => {
    setEditing(false)
    const t = /^\d+(\.\d+)?$/.test(text.trim()) ? parseFloat(text) : parseTime(text)
    if (t === null || !isFinite(t) || t < 0) {
      toast('Type a time like 1:02.5')
      setText(fmt(value, ms))
      return
    }
    if (Math.abs(t - value) > 1e-4) onCommit(t)
  }
  return (
    <input
      type="text"
      className="mono"
      style={{ width: 100 }}
      value={text}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(fmt(value, ms))
          setEditing(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** A number field that commits on Enter / blur. */
export function NumberInput(props: {
  value: number
  onCommit: (v: number) => void
  step?: number
  min?: number
  max?: number
  width?: number
  disabled?: boolean
}) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(round(props.value))), [props.value])
  const commit = () => {
    let v = parseFloat(text)
    if (!isFinite(v)) {
      setText(String(round(props.value)))
      return
    }
    if (props.min !== undefined) v = Math.max(props.min, v)
    if (props.max !== undefined) v = Math.min(props.max, v)
    setText(String(round(v)))
    if (v !== props.value) props.onCommit(v)
  }
  return (
    <input
      type="number"
      style={{ width: props.width ?? 80 }}
      value={text}
      step={props.step}
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** A slider that only commits when you let go, so one drag makes one undo step. */
export function CommitSlider(props: {
  value: number
  min: number
  max: number
  step: number
  onCommit: (v: number) => void
  format?: (v: number) => string
  width?: number
  disabled?: boolean
  title?: string
}) {
  const [v, setV] = useState(props.value)
  const [drag, setDrag] = useState(false)
  useEffect(() => {
    if (!drag) setV(props.value)
  }, [props.value, drag])
  const commit = () => {
    setDrag(false)
    if (v !== props.value) props.onCommit(v)
  }
  return (
    <span className="row" style={{ gap: 6 }} title={props.title}>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={v}
        disabled={props.disabled}
        style={{ width: props.width ?? 120 }}
        onPointerDown={() => setDrag(true)}
        onChange={(e) => {
          setV(parseFloat(e.target.value))
          if (!drag) setDrag(true)
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => drag && commit()}
      />
      {props.format && <span className="small muted mono" style={{ minWidth: 52 }}>{props.format(v)}</span>}
    </span>
  )
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={28} />}
      <h3>{title}</h3>
      {children}
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="row" style={{ cursor: disabled ? 'default' : 'pointer', gap: 6 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** A small spinner with an optional label. */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row small muted">
      <span className="spinner" />
      {label}
    </span>
  )
}
