import { Icon } from 'lilak-ui'

// Temporary tab body. Each tab gets its real page as features land; until then
// this shows what the tab will hold. Split into its own page component when it
// grows real content.
export default function Placeholder({ icon, title, note }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', maxWidth: 520 }}>
        {icon && <Icon name={icon} size={40} style={{ opacity: 0.5 }} />}
        <div style={{ fontSize: 'var(--fs-large, 16px)', color: 'var(--text-primary)', marginTop: 10, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 'var(--fs-small, 12px)', marginTop: 6 }}>{note}</div>
      </div>
    </div>
  )
}
