import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * InvitesAdmin — admin invite-code manager (in the Account screen). One place to
 * mint, list, extend and revoke every code. Two kinds:
 *   project — grants a service / single project on redeem.
 *   group   — joins the redeemer to a group, inheriting that group's project grants.
 * The code may be auto-generated or admin-chosen (8–64 chars). Expiry 1–365 days.
 */
const input = { height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }

export default function InvitesAdmin({ services, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [codes, setCodes] = useState([])
  const [groups, setGroups] = useState([])
  const [projCache, setProjCache] = useState({})
  const [f, setF] = useState({ kind: 'project', service: '', project: '', group_id: '', days: 7, code: '', max_uses: 0, count: 1, no_verify: false })
  const [msg, setMsg] = useState('')
  const setF1 = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  async function load() {
    try {
      const [c, g] = await Promise.all([launcher.get('/admin/invite-codes'), launcher.get('/admin/groups')])
      setCodes(c.data); setGroups(g.data)
    } catch (e) { setMsg(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) setMsg(ok(r)); await load(); onChanged?.() } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) } }

  async function pickSvc(svc) {
    setF((s) => ({ ...s, service: svc, project: '' }))
    if (svc && !projCache[svc]) {
      try { const r = await launcher.get(`/services/${svc}/projects`); setProjCache((c) => ({ ...c, [svc]: r.data })) }
      catch { setProjCache((c) => ({ ...c, [svc]: [] })) }
    }
  }

  function create() {
    const count = Math.max(1, Math.min(100, Number(f.count) || 1))
    const body = { kind: f.kind, days: Number(f.days) || 7, code: f.code.trim() || undefined,
      max_uses: Math.max(0, Number(f.max_uses) || 0), count, no_verify: !!f.no_verify }
    if (f.kind === 'project') { body.service = f.service; body.project = f.project }
    else body.group_id = Number(f.group_id)
    if (f.kind === 'project' ? !f.service : !f.group_id) { setMsg(L('대상을 선택하세요.', 'pick a target')); return }
    run(launcher.post('/admin/invite-codes', body), (r) => {
      setF((s) => ({ ...s, code: '' }))
      const codes = (r.data.codes || []).map((c) => c.code)
      return codes.length > 1 ? L(`${codes.length}개 생성: ${codes.join(', ')}`, `${codes.length} created: ${codes.join(', ')}`)
        : L(`코드 생성: ${codes[0] || r.data.code}`, `code: ${codes[0] || r.data.code}`)
    })
  }
  const extend = (c) => { const d = window.prompt(L('며칠 연장? (1~365)', 'extend by days (1–365)'), '7'); if (d) run(launcher.put(`/admin/invite-codes/${c.id}`, { days: Number(d) }), () => L('기간 연장됨', 'extended')) }
  const pruneExpired = () => run(launcher.post('/admin/invite-codes/prune-expired'), (r) => L(`만료 코드 ${r.data.deleted}개 삭제됨`, `${r.data.deleted} expired codes deleted`))
  const del = (c) => { if (window.confirm(L(`코드 ${c.code} 삭제?`, `Delete code ${c.code}?`))) run(launcher.delete(`/admin/invite-codes/${c.id}`), () => L('삭제됨', 'deleted')) }
  const copy = (code) => { try { navigator.clipboard.writeText(code) } catch { /* ignore */ } setMsg(L(`복사됨: ${code}`, `copied: ${code}`)) }
  const fmt = (iso) => { try { return new Date(iso).toLocaleDateString() } catch { return iso } }

  return (
    <div>
      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', marginBottom: 6 }}>{msg}</div>}

      {/* create */}
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 8, padding: 10, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={f.kind} onChange={setF1('kind')} style={input}>
            <option value="project">{L('프로젝트/서비스 코드', 'project/service code')}</option>
            <option value="group">{L('그룹 코드', 'group code')}</option>
          </select>
          {f.kind === 'project' ? (
            <>
              <select value={f.service} onChange={(e) => pickSvc(e.target.value)} style={{ ...input, maxWidth: 150 }}>
                <option value="">{L('서비스…', 'service…')}</option>
                {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <select value={f.project} onChange={setF1('project')} style={{ ...input, maxWidth: 150 }} disabled={!f.service}>
                <option value="">{L('전체', 'all')}</option>
                {(projCache[f.service] || []).map((p) => <option key={p.name} value={p.name}>{p.label || p.name}</option>)}
              </select>
            </>
          ) : (
            <select value={f.group_id} onChange={setF1('group_id')} style={{ ...input, maxWidth: 180 }}>
              <option value="">{L('그룹…', 'group…')}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={f.code} onChange={setF1('code')} disabled={Number(f.count) > 1}
            placeholder={Number(f.count) > 1 ? L('여러 개는 자동 생성', 'auto for bulk') : L('직접 코드 (선택, 8자+)', 'custom code (optional, 8+)')}
            style={{ ...input, flex: 1, minWidth: 140, opacity: Number(f.count) > 1 ? 0.5 : 1 }} />
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('유효', 'valid')}</span>
          <input type="number" min={1} max={365} value={f.days} onChange={setF1('days')} style={{ ...input, width: 56 }} />
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('일', 'd')}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            title={L('체크하면 1회만 사용 가능', 'redeemable once')}>
            <input type="checkbox" checked={Number(f.max_uses) === 1} onChange={(e) => setF((s) => ({ ...s, max_uses: e.target.checked ? 1 : 0 }))} /> {L('일회용', 'Single-use')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            title={L('이 코드로 가입하면 이메일 인증 없이 승인됨', 'signup with this code is approved without email verification')}>
            <input type="checkbox" checked={!!f.no_verify} onChange={(e) => setF((s) => ({ ...s, no_verify: e.target.checked }))} /> {L('이메일 인증 생략', 'Skip email verify')}
          </label>
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('사용 횟수', 'max uses')}</span>
          <input type="number" min={0} max={100000} value={f.max_uses} onChange={setF1('max_uses')} style={{ ...input, width: 64 }} title={L('0 = 무제한', '0 = unlimited')} />
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('개수', 'count')}</span>
          <input type="number" min={1} max={100} value={f.count} onChange={setF1('count')} style={{ ...input, width: 56 }} />
          <Button size="sm" variant="primary" onClick={create}>{L('코드 생성', 'Generate')}</Button>
        </div>
      </div>

      {/* list header + bulk actions */}
      {codes.some((c) => c.status === 'expired') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <Button size="sm" variant="dangerSoft" onClick={pruneExpired}>
            <Icon name="trash" size={13} /> {L('만료 코드 일괄 삭제', 'Delete expired')}
          </Button>
        </div>
      )}

      {/* list */}
      {codes.length === 0 ? <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('코드 없음', 'no codes')}</div>
        : codes.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
            <code style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: 1 }}>{c.code}</code>
            <span style={{ fontSize: 'var(--fs-micro, 10px)', padding: '1px 6px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              {c.kind === 'group' ? `${L('그룹', 'group')}: ${c.group}` : `${c.service}${c.project ? '/' + c.project : ''}`}
            </span>
            {c.no_verify && <span style={{ fontSize: 'var(--fs-micro, 10px)', padding: '1px 6px', borderRadius: 999, background: 'var(--info-bg, var(--surface-2))', color: 'var(--info-text, var(--text-secondary))' }}>{L('인증생략', 'no-verify')}</span>}
            <span style={{ fontSize: 'var(--fs-micro, 10px)', color: c.status === 'active' ? 'var(--ok-text, #2f9e44)' : 'var(--text-muted)' }}>
              {c.status} · {c.uses}/{c.max_uses ? c.max_uses : '∞'}{L('회', 'x')}{c.max_uses === 1 ? L(' (일회용)', ' (single)') : ''} · ~{fmt(c.expires_at)}
            </span>
            <div style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" icon title={L('복사', 'copy')} onClick={() => copy(c.code)}><Icon name="copy" size={13} /></Button>
            <Button size="sm" variant="ghost" onClick={() => extend(c)}>{L('연장', 'Extend')}</Button>
            <Button size="sm" variant="ghost" icon title={L('삭제', 'delete')} onClick={() => del(c)}><Icon name="trash" size={13} /></Button>
          </div>
        ))}
    </div>
  )
}
