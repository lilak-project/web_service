import { useEffect, useRef } from 'react'
import { Icon } from 'lilak-ui'

/**
 * HomeModeMenu — the small menu that drops under the Home tab when Home is
 * pressed while already on Home. Picks the cover's MODE:
 *
 *   manage  — (managers) rename / icon / visibility / order / hide / delete
 *   groups  — (managers) make service groups and drag cards in and out of them
 *   live    — (everyone) live-capable cards grow and show their live numbers
 *   null    — the normal cover
 *
 * Closes on outside click or Escape.
 */
export const HOME_MODES = [
  { id: 'manage', icon: 'wrench', ko: '관리 모드', en: 'Manage mode', admin: true, ko_hint: '이름 · 아이콘 · 공개 범위 · 숨김 · 그룹 · 끌어서 정렬', en_hint: 'name · icon · visibility · hide · groups · drag to arrange' },
  { id: 'live', icon: 'broadcast', ko: '라이브 모드', en: 'Live mode', admin: false, ko_hint: '지원하는 카드에 실시간 숫자 표시', en_hint: 'live numbers on cards that support it' },
]

export default function HomeModeMenu({ open, onClose, mode, onPick, isManager, lang = 'ko', anchor = 'left' }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose?.() }
    const esc = (e) => { if (e.key === 'Escape') onClose?.() }
    // Deferred so the click that opened the menu is not the click that closes it.
    const t = setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', esc) }, 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open, onClose])
  if (!open) return null
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const items = HOME_MODES.filter((m) => !m.admin || isManager)
  const row = (active) => ({
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer',
    background: active ? 'var(--surface-2)' : 'transparent', border: 'none', borderRadius: 8, padding: '9px 12px',
    font: 'inherit', fontSize: 'var(--fs-medium, 14px)', color: 'var(--text-primary)',
  })
  return (
    <div ref={ref} style={{ position: 'absolute', [anchor]: 0, top: 'calc(100% + 6px)', minWidth: 250, zIndex: 1000,
      background: 'var(--surface)', border: '1px solid var(--border-default)', borderRadius: 12,
      boxShadow: '0 8px 26px rgba(0,0,0,.16)', padding: 6 }}>
      <div style={{ padding: '4px 12px 8px', fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', letterSpacing: '.05em', textTransform: 'uppercase' }}>{L('홈 보기 모드', 'Home mode')}</div>
      <button type="button" style={row(mode == null)} onClick={() => { onPick(null); onClose?.() }}>
        <Icon name="home" size={16} /> <span style={{ flex: 1 }}>{L('일반', 'Normal')}</span>{mode == null && <Icon name="check" size={14} />}
      </button>
      {items.map((m) => {
        const active = mode === m.id
        return (
          <button key={m.id} type="button" style={row(active)} onClick={() => { onPick(active ? null : m.id); onClose?.() }}>
            <Icon name={m.icon} size={16} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              <span>{L(m.ko, m.en)}</span>
              <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{L(m.ko_hint, m.en_hint)}</span>
            </span>
            {active && <Icon name="check" size={14} />}
          </button>
        )
      })}
    </div>
  )
}
