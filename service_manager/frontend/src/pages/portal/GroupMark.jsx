import { Icon } from 'lilak-ui'

/**
 * GroupMark — a group's visual mark: a BOLD icon inside a SQUARE border, tinted
 * with the group colour. Deliberately distinct from the round, filled user avatars.
 */
export default function GroupMark({ icon, color, size = 22 }) {
  const c = color || 'var(--text-secondary)'
  return (
    <span style={{
      display: 'grid', placeItems: 'center', width: size, height: size, borderRadius: 5,
      border: `1.5px solid ${c}`, color: c, flexShrink: 0,
    }}>
      <Icon name={icon || 'users'} size={Math.round(size * 0.58)} weight="bold" color={c} />
    </span>
  )
}
