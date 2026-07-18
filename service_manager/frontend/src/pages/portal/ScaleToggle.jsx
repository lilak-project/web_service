import { Button, Icon } from 'lilak-ui'
import { useLang } from '../../context/LangContext'
import { usePortalScale } from '../../portalScale'

/**
 * ScaleToggle — flip the portal between the compact (default) and roomy UI sizes.
 * Used in two spots on purpose (top bar + Settings › System) so the feature is
 * easy to find now and easy to hide later: delete both placements and the size
 * reverts to compact everywhere. `variant`/`size` let each spot style it.
 */
export default function ScaleToggle({ variant = 'ghost', size = 'sm' }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const { big, toggle } = usePortalScale()
  return (
    <Button variant={variant} size={size} onClick={toggle}
      title={L('화면 크기 전환 (기본 ↔ 크게)', 'Toggle UI size (default ↔ large)')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Icon name={big ? 'toggle-right' : 'toggle-left'} size={18} weight={big ? 'fill' : 'regular'}
        color={big ? 'var(--btn-primary-bg)' : undefined} />
      {big ? L('크게', 'Large') : L('기본', 'Default')}
    </Button>
  )
}
