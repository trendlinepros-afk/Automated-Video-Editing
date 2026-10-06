import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icon'

export function Modal(props: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog">
        <header>
          <h2 className="grow">{props.title}</h2>
          <button className="btn ghost icon" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  )
}
