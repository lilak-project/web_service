import { Icon } from 'lilak-ui'

/**
 * GroupMark — a group's visual mark: a BOLD icon inside a HEXAGON outline, tinted
 * with the group colour. Deliberately distinct from the round, filled user avatars.
 */
export default function GroupMark({ icon, color, size = 22 }) {
  const c = color || 'var(--dock-text-secondary)'
  return (
    <span style={{ position: 'relative', display: 'grid', placeItems: 'center', width: size, height: size, color: c, flexShrink: 0 }}>
      {/* A hexagon outline: a user group, not a person (round) and not a service (square). */}
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
        <polygon points="50,3 92,27 92,73 50,97 8,73 8,27" fill="none" stroke={c} strokeWidth="1.5"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <Icon name={icon || 'users'} size={Math.round(size * 0.52)} weight="bold" color={c} />
    </span>
  )
}
