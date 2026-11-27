import type { CSSProperties } from 'react'

interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

const baseProps = (size: number, className?: string, style?: CSSProperties) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  className,
  style
})

/** Foliopair 对开双页品牌标识，平实几何线条，不带渐变与发光。 */
export function BrandPageIcon({ size = 16, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.3" />
      <path d="M8 2.5v11M4.2 6h1.8M4.2 8.75h1.8M10 6h1.8M10 8.75h1.8" />
    </svg>
  )
}

export function DocumentIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M3.5 2.5h6l3 3v8h-9v-11Z" />
      <path d="M9.5 2.5v3h3" />
    </svg>
  )
}

export function StackIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="2.5" y="4.5" width="9" height="9" rx="1.2" />
      <path d="M5.5 4.5V2.8c0-.3.2-.55.55-.55h7.15c.3 0 .55.25.55.55v7.15c0 .3-.25.55-.55.55H11.5" />
    </svg>
  )
}

export function ChatIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M2.5 3.5h11v7.5H6.5l-3 2.5V11h-1V3.5Z" />
    </svg>
  )
}

export function SummaryIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="2.75" y="2.25" width="10.5" height="11.5" rx="1.2" />
      <path d="M5.25 5.75h5.5M5.25 8.25h5.5M5.25 10.75h3.5" />
    </svg>
  )
}

export function SlidesIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="2" y="3" width="12" height="8" rx="1.2" />
      <path d="M8 11v2.5M5.5 13.5h5" />
    </svg>
  )
}

export function ReviewIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.2 10.2 3.3 3.3" />
    </svg>
  )
}

export function GlobeSearchIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.75 8h10.5M8 2.5c1.6 1.5 2.4 3.4 2.4 5.5S9.6 12 8 13.5M8 2.5C6.4 4 5.6 5.9 5.6 8S6.4 12 8 13.5" />
    </svg>
  )
}

export function CompareIcon({ size = 15, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="2" y="2.75" width="5" height="10.5" rx="1" />
      <rect x="9" y="2.75" width="5" height="10.5" rx="1" />
    </svg>
  )
}

export function BoltIcon({ size = 14, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M9 1.75 3.75 8.75H8l-1 5.5 5.25-7H8l1-5.5Z" />
    </svg>
  )
}

export function PagesIcon({ size = 14, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M3.25 3.5h6l2.5 2.5v7.5h-8.5v-10Z" />
      <path d="M5.25 2h6.25l2 2v7.25" />
    </svg>
  )
}

export function SettingsIcon({ size = 13, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.9v1.4M8 12.7v1.4M1.9 8h1.4M12.7 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M3.7 12.3l1-1M11.3 4.7l1-1" />
    </svg>
  )
}

export function FolderMoveIcon({ size = 13, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M2 4.5h3.6l1.2 1.4H14v6.6H2v-8Z" />
      <path d="M7.5 9.2h3.5m0 0-1.4-1.4M11 9.2l-1.4 1.4" />
    </svg>
  )
}

export function SplitIcon({ size = 13, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.2" />
      <path d="M8 2.75v10.5" />
    </svg>
  )
}

export function FolderTreeIcon({ size = 14, className, style }: IconProps): React.JSX.Element {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M2.25 4h4l1.25 1.5h6.25v6.75H2.25V4Z" />
    </svg>
  )
}
