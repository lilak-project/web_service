import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ServiceManage — admin panel for one service (inline, under its row in the
 * Services screen). Create/delete projects, grant per-project (or whole-service)
 * access to each account, and mint invite codes (1–7 day expiry) that let people
 * self-grant without approval.
 *
 * A permission with project="" is a whole-service grant; otherwise it's that one
 * project. The "All" column toggles the whole-service grant.
 */
const cellBtn = (on) => ({
  width: 22, height: 22, borderRadius: 5, cursor: 'pointer', padding: 0,
  border: on ? '1px solid var(--btn-primary-bg)' : '1px solid var(--border-default)',
  background: on ? 'var(--btn-primary-bg)' : 'var(--surface)', color: '#fff',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
})
const input = { height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }
const th = { fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', fontWeight: 600, padding: '2px 6px', textAlign: 'center', whiteSpace: 'nowrap' }
const td = { padding: '3px 6px', textAlign: 'center' }

export default function ServiceManage({ svc, users }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [projects, setProjects] = useState([])
  const [perms, setPerms] = useState(new Set())   // `${uid}:${project}`
  const [codes, setCodes] = useState([])
  const [nc, setNc] = useState({ project: '', days: 1 })
  const [newProj, setNewProj] = useState('')
  const [msg, setMsg] = useState('')
  const fileRef = useRef(null)
  const multi = !!svc.multi_project

  async function load() {
    try {
      const reqs = [
        launcher.get('/admin/permissions'),
        launcher.get('/admin/invite-codes'),
      ]
      if (multi) reqs.push(launcher.get(`/services/${svc.name}/projects`))
      const [p, c, pr] = await Promise.all(reqs)
      setPerms(new Set(p.data.filter((x) => x.service === svc.name).map((x) => `${x.user_id}:${x.project || ''}`)))
      setCodes(c.data.filter((x) => x.service === svc.name))
      if (multi && pr) setProjects(pr.data)
    } catch (e) { setMsg(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const say = (m) => setMsg(m)
  async function run(p, ok) { try { const r = await p; if (ok) say(ok(r)); await load() } catch (e) { say(e?.response?.data?.detail || L('실패', 'failed')) } }

  async function toggle(uid, project) {
    const key = `${uid}:${project}`
    const has = perms.has(key)
    if (has) await launcher.delete('/admin/permissions', { data: { user_id: uid, service: svc.name, project } })
    else await launcher.post('/admin/permissions', { user_id: uid, service: svc.name, project })
    setPerms((s) => { const n = new Set(s); has ? n.delete(key) : n.add(key); return n })
  }

  const createProject = () => newProj.trim() && run(launcher.post(`/services/${svc.name}/projects`, { name: newProj.trim() }), () => { setNewProj(''); return L('프로젝트 생성됨', 'project created') })
  const deleteProject = (name) => { if (window.confirm(L(`프로젝트 '${name}' 삭제? 데이터가 사라집니다.`, `Delete project '${name}'? Its data is removed.`))) run(launcher.delete(`/services/${svc.name}/projects/${name}`), () => L('삭제됨', 'deleted')) }
  async function importProj(file) {
    if (!file) return
    const fd = new FormData(); fd.append('file', file)
    run(launcher.post(`/services/${svc.name}/projects/import`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }), () => L('가져옴', 'imported'))
  }
  const genCode = () => run(launcher.post('/admin/invite-codes', { service: svc.name, project: nc.project, days: Number(nc.days) }),
    (r) => L(`코드 생성: ${r.data.code}`, `code: ${r.data.code}`))
  const revokeCode = (id) => run(launcher.delete(`/admin/invite-codes/${id}`), () => L('코드 삭제됨', 'code removed'))
  const copyCode = (code) => { try { navigator.clipboard.writeText(code) } catch { /* ignore */ } say(L(`복사됨: ${code}`, `copied: ${code}`)) }
  async function exportProj(name) {
    try {
      const res = await launcher.get(`/services/${svc.name}/projects/${name}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a'); a.href = url; a.download = `${name}.zip`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
    } catch (e) { say(e?.response?.data?.detail || L('내보내기 실패', 'export failed')) }
  }

  const normalUsers = users.filter((u) => u.role !== 'manager')
  const targets = [{ key: '', label: L('전체', 'All') }, ...projects.map((p) => ({ key: p.name, label: p.name }))]

  return (
    <div style={{ padding: '10px 12px 12px', background: 'var(--surface-2)', borderRadius: 8, marginTop: 6 }}>
      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', marginBottom: 6 }}>{msg}</div>}

      {/* Projects */}
      {multi && (
        <>
          <div style={{ fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{L('프로젝트', 'Projects')}</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <input value={newProj} onChange={(e) => setNewProj(e.target.value)} placeholder={L('새 프로젝트 이름', 'new project name')} style={{ ...input, flex: 1, minWidth: 140 }} onKeyDown={(e) => e.key === 'Enter' && createProject()} />
            <Button size="sm" variant="primary" disabled={!newProj.trim()} onClick={createProject}>{L('생성', 'Create')}</Button>
            {svc.import_export && <>
              <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>{L('가져오기', 'Import')}</Button>
              <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => importProj(e.target.files?.[0])} />
            </>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {projects.length === 0 ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>—</span>
              : projects.map((p) => (
                <span key={p.name} title={p.label ? p.name : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-small, 12px)', padding: '3px 6px 3px 10px', borderRadius: 999, border: '1px solid var(--border-default)', fontFamily: 'var(--font-mono)' }}>
                  {p.label || p.name}
                  {svc.import_export && <button onClick={() => exportProj(p.name)} title={L('내보내기', 'export')} style={{ display: 'inline-flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 0 }}><Icon name="download" size={13} /></button>}
                  <button onClick={() => deleteProject(p.name)} title={L('삭제', 'delete')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger-text)', padding: 0, display: 'inline-flex' }}><Icon name="trash" size={13} /></button>
                </span>
              ))}
          </div>
        </>
      )}

      {/* Per-project permissions */}
      <div style={{ fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{L('권한 (계정 × 프로젝트)', 'Access (account × project)')}</div>
      {normalUsers.length === 0 ? <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{L('일반 계정 없음', 'no non-admin accounts')}</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 'var(--fs-small, 12px)' }}>
            <thead><tr><th style={{ ...th, textAlign: 'left' }}>{L('계정', 'account')}</th>{targets.map((t) => <th key={t.key} style={th}>{t.label}</th>)}</tr></thead>
            <tbody>
              {normalUsers.map((u) => (
                <tr key={u.id}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{u.username}</td>
                  {targets.map((t) => {
                    const on = perms.has(`${u.id}:${t.key}`)
                    return <td key={t.key} style={td}><button onClick={() => toggle(u.id, t.key)} style={cellBtn(on)} title={t.label}>{on && <Icon name="check" size={12} />}</button></td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Invite codes */}
      <div style={{ fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', margin: '12px 0 6px' }}>{L('임시 허용 코드', 'Invite codes')}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <select value={nc.project} onChange={(e) => setNc((s) => ({ ...s, project: e.target.value }))} style={input}>
          {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('유효', 'valid')}</span>
        <input type="number" min={1} max={7} value={nc.days} onChange={(e) => setNc((s) => ({ ...s, days: e.target.value }))} style={{ ...input, width: 56 }} />
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('일 (최대 7)', 'days (max 7)')}</span>
        <Button size="sm" variant="primary" onClick={genCode}>{L('코드 생성', 'Generate')}</Button>
      </div>
      {codes.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 'var(--fs-small, 12px)' }}>
          <code style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: 1 }}>{c.code}</code>
          <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{c.project ? c.project : L('전체', 'all')} · {c.status} · {c.uses}{L('회', 'x')}</span>
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" icon title={L('복사', 'copy')} onClick={() => copyCode(c.code)}><Icon name="copy" size={13} /></Button>
          <Button size="sm" variant="ghost" icon title={L('삭제', 'delete')} onClick={() => revokeCode(c.id)}><Icon name="trash" size={13} /></Button>
        </div>
      ))}
      {codes.length === 0 && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>—</div>}
    </div>
  )
}
