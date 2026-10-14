import { useEffect, useState } from 'react'
import { Button } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Pill, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

const input = { ...fieldInput, width: 100 }

// Manager-only: the managed-service port window. Widening it lets more sessions
// run at once (each launched service claims one loopback port from this range).
export default function SystemAdmin() {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [d, setD] = useState(null)          // server status
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [msg, setMsg] = useState('')
  const flash = (m, tone) => { setMsg(m); notify(m, tone); setTimeout(() => setMsg(''), 3000) }

  const load = () => launcher.get('/admin/system/ports').then((r) => {
    setD(r.data); setStart(String(r.data.start)); setEnd(String(r.data.end))
  }).catch((e) => flash(e?.response?.data?.detail || String(e), 'bad'))
  useEffect(() => { load() }, [])

  const save = async () => {
    try {
      const r = await launcher.put('/admin/system/ports', { start: Number(start), end: Number(end) })
      setD(r.data); flash(L('포트 범위 저장됨', 'port range saved'), 'ok')
    } catch (e) { flash(e?.response?.data?.detail || String(e), 'bad') }
  }

  if (!d) return <div className="set-msg">{msg || '…'}</div>

  const slots = (Number(end) - Number(start) + 1)
  const dirty = Number(start) !== d.start || Number(end) !== d.end
  const bad = !(start && end) || Number(end) < Number(start) || slots < 1

  return (
    <>
      <Panel title={L('서비스 포트 배정', 'Service port pool')} hint={msg}
        right={<Button variant="secondary" onClick={load}>{L('새로고침', 'Refresh')}</Button>}>
        <Field label={L('사용 현황', 'In use')}>
          <Pill>{L('총 슬롯', 'total')} {d.total}</Pill>
          <Pill tone="warn">{L('사용 중', 'in use')} {d.in_use}</Pill>
          <Pill tone={d.free ? 'ok' : 'bad'}>{L('여유', 'free')} {d.free}</Pill>
        </Field>

        <Field label={L('범위', 'Range')}>
          <input style={input} type="number" value={start} onChange={(e) => setStart(e.target.value)} />
          <span style={fieldMuted}>–</span>
          <input style={input} type="number" value={end} onChange={(e) => setEnd(e.target.value)} />
          <span style={{ color: bad ? 'var(--danger-text)' : 'var(--text-secondary)' }}>
            = {Number.isFinite(slots) ? slots : '?'} {L('슬롯', 'slots')}
          </span>
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty || bad} onClick={save}>{L('저장', 'Save')}</Button>
          <span style={fieldMuted}>
            {L(`기본값 ${d.default_start}–${d.default_end} · 허용 ${d.min}–${d.max}, 최대 ${d.max_slots}슬롯`,
              `Default ${d.default_start}–${d.default_end} · allowed ${d.min}–${d.max}, up to ${d.max_slots} slots`)}
          </span>
        </FieldActions>

        <Field label={L('설명', 'What this is')}>
          {L(`실행되는 각 세션은 이 범위에서 포트를 하나씩 사용합니다. 범위가 모두 차면 "No free service port" 오류가 납니다. 넓히면 더 많은 동시 사용자를 받을 수 있습니다. 컨테이너 내부 포트이고, 재시작 없이 즉시 반영됩니다. 포탈 포트 ${d.portal_port}은 범위에서 제외해야 합니다.`,
            `Each running session claims one port from this range. When it fills up you get "No free service port" — widen it to admit more concurrent users. These are internal container ports, applied live with no restart. Portal port ${d.portal_port} must stay outside the range.`)}
        </Field>
      </Panel>
    </>
  )
}
