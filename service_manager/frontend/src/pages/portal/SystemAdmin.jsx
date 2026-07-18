import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ScaleToggle from './ScaleToggle'

const card = { border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--card-bg, transparent)' }
const lbl = { fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', minWidth: 76 }
const input = { border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', width: 100, fontSize: 'var(--fs-small, 12px)' }

// Manager-only: the managed-service port window. Widening it lets more sessions
// run at once (each launched service claims one loopback port from this range).
export default function SystemAdmin() {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [d, setD] = useState(null)          // server status
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [msg, setMsg] = useState('')
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  const load = () => launcher.get('/admin/system/ports').then((r) => {
    setD(r.data); setStart(String(r.data.start)); setEnd(String(r.data.end))
  }).catch((e) => flash(e?.response?.data?.detail || String(e)))
  useEffect(() => { load() }, [])

  const save = async () => {
    try {
      const r = await launcher.put('/admin/system/ports', { start: Number(start), end: Number(end) })
      setD(r.data); flash(L('저장됨', 'saved'))
    } catch (e) { flash(e?.response?.data?.detail || String(e)) }
  }

  if (!d) return <div style={{ padding: 12, color: 'var(--text-muted)' }}>{msg || '…'}</div>

  const slots = (Number(end) - Number(start) + 1)
  const dirty = Number(start) !== d.start || Number(end) !== d.end
  const bad = !(start && end) || Number(end) < Number(start) || slots < 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* UI size — the same toggle that's in the top bar, kept here so it has a
          settled home once it's removed from the top bar. */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Icon name="images" size={16} />
          <b style={{ fontSize: 'var(--fs-body, 13px)' }}>{L('화면 크기', 'UI size')}</b>
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
            {L('기본(작게) ↔ 크게', 'default (compact) ↔ large')}
          </span>
          <span style={{ flex: 1 }} />
          <ScaleToggle variant="secondary" />
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Icon name="sliders" size={16} />
          <b style={{ fontSize: 'var(--fs-body, 13px)' }}>{L('서비스 포트 배정', 'Service port pool')}</b>
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{msg}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="secondary" onClick={load}>{L('새로고침', 'Refresh')}</Button>
        </div>

        <p style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          {L('실행되는 각 세션은 이 범위에서 포트를 하나씩 사용합니다. 범위가 모두 차면 "No free service port" 오류가 납니다. 넓히면 더 많은 동시 사용자를 받을 수 있습니다. (컨테이너 내부 포트 · 재시작 없이 즉시 반영)',
            'Each running session claims one port from this range. When it fills up you get "No free service port". Widen it to admit more concurrent users. (Internal container ports · applied live, no restart.)')}
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 12 }}>
          <div><div style={{ fontSize: 20, fontWeight: 600 }}>{d.total}</div><div style={lbl}>{L('총 슬롯', 'total slots')}</div></div>
          <div><div style={{ fontSize: 20, fontWeight: 600 }}>{d.in_use}</div><div style={lbl}>{L('사용 중', 'in use')}</div></div>
          <div><div style={{ fontSize: 20, fontWeight: 600, color: d.free ? 'var(--ok-text, #2f9e44)' : 'var(--danger-text)' }}>{d.free}</div><div style={lbl}>{L('여유', 'free')}</div></div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={lbl}>{L('시작 포트', 'Start port')}</span>
          <input style={input} type="number" value={start} onChange={(e) => setStart(e.target.value)} />
          <span style={lbl}>{L('끝 포트', 'End port')}</span>
          <input style={input} type="number" value={end} onChange={(e) => setEnd(e.target.value)} />
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: bad ? 'var(--danger-text)' : 'var(--text-muted)' }}>
            = {Number.isFinite(slots) ? slots : '?'} {L('슬롯', 'slots')}
          </span>
          <Button size="sm" disabled={!dirty || bad} onClick={save}>{L('저장', 'Save')}</Button>
        </div>

        <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', marginTop: 10 }}>
          {L(`기본값 ${d.default_start}–${d.default_end} · 포탈 포트 ${d.portal_port}은 범위에서 제외 · 허용 ${d.min}–${d.max}, 최대 ${d.max_slots}슬롯`,
            `Default ${d.default_start}–${d.default_end} · portal port ${d.portal_port} must stay outside · allowed ${d.min}–${d.max}, up to ${d.max_slots} slots`)}
        </div>
      </div>
    </div>
  )
}
