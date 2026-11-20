import { cx } from '../lib/util'

interface IconProps {
  /** SVG path data on a 24x24 grid (from @mdi/js). */
  path: string
  size?: number
  className?: string
  spin?: boolean
}

export function Icon({ path, size = 18, className, spin }: IconProps): React.JSX.Element {
  return (
    <svg
      className={cx('icon', spin && 'spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} fill="currentColor" />
    </svg>
  )
}

/** The Underleaf mark: a leaf resting on a baseline. */
export function LogoMark({ size = 28, baseline = '#ffffff' }: { size?: number; baseline?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M7.2 21.6C5.9 13.2 11.6 5.4 25.6 4.4c1 12.3-5 18.4-13.3 18.4-1 0-1.9-.1-2.8-.3 2.2-4.7 5.5-8.4 10.3-11.5-5.6 2.300-9.800 5.800-12.600 10.600z"
        fill="#33aa58"
      />
      <rect x="5" y="25.4" width="22" height="2.8" rx="1.4" fill={baseline} />
    </svg>
  )
}

export function Logo({ dark = true }: { dark?: boolean }): React.JSX.Element {
  return (
    <span className="logo">
      <LogoMark baseline={dark ? '#ffffff' : '#1b222c'} />
      <span className="logo-word">Underleaf</span>
    </span>
  )
}
