/** A handful of line icons, drawn inline so nothing loads from the network. */
const PATHS: Record<string, string> = {
  play: 'M7 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  prev: 'M6 5h2v14H6zM19 5v14L9 12z',
  next: 'M16 5h2v14h-2zM5 5v14l10-7z',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  folder: 'M3 6h6l2 2h10v11H3z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  note: 'M5 4h14v12l-4 4H5zM15 20v-4h4',
  check: 'M5 12l5 5L20 7',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  export: 'M12 3v12M7 8l5-5 5 5M5 15v5h14v-5',
  log: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3',
  stop: 'M7 7h10v10H7z',
  scissors: 'M6 6a2 2 0 100 4 2 2 0 000-4zM6 14a2 2 0 100 4 2 2 0 000-4zM8 9l12 9M8 15l12-9',
  wand: 'M4 20L16 8M14 4v3M18 8h3M17 3l1.5 1.5M19 11l1 1',
  zoomIn: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6M11 8v6',
  zoomOut: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6',
  fit: 'M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 10a3.5 3.5 0 100 7 3.5 3.5 0 000-7z'
}

export function Icon({ name, size = 16, fill = false }: { name: keyof typeof PATHS | string; size?: number; fill?: boolean }) {
  const filled = fill || name === 'play' || name === 'pause' || name === 'prev' || name === 'next' || name === 'stop'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}
