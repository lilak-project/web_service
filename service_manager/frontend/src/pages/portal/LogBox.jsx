import { useEffect, useRef, useState } from 'react'
import { Button } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * LogBox — the tail of a captured service.log, for a manager.
 *
 * Fetched when it is shown, not before: a log can be long and is wanted only
 * when something went wrong. It opens scrolled to the END, because the end is
 * the part that says why a service stopped; refresh re-reads the file, which is
 * truncated on every start, so after a restart it shows the new run only.
 *
 * `url` is the launcher path that answers { text, path }.
 */
export default function LogBox({ url }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [data, setData] = useState(null)   // null = loading
  const [busy, setBusy] = useState(false)
  const pre = useRef(null)

  async function load() {
    setBusy(true)
    try { setData((await launcher.get(url)).data) }
    catch (e) {
      setData({ text: '', path: '', error: e?.response?.data?.detail || L('로그를 불러오지 못했습니다.', 'Could not read the log.') })
    } finally { setBusy(false) }
  }
  useEffect(() => { load() }, [url])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight }, [data])

  return (
    <div className="pl-log">
      <div className="pl-logbar">
        <span className="pl-logpath">{data?.path || ''}</span>
        <span className="sp" />
        <Button variant="secondary" disabled={busy} onClick={load}>
          {busy ? L('읽는 중…', 'Reading…') : L('새로고침', 'Refresh')}
        </Button>
      </div>
      {data?.error ? <div className="pl-logempty">{data.error}</div>
        : data === null ? <div className="pl-logempty">{L('읽는 중…', 'Reading…')}</div>
          : !data.text ? <div className="pl-logempty">{L('아직 기록이 없습니다 — 시작한 적이 없거나, 아무것도 출력하지 않았습니다.', 'Nothing yet — it has not been started, or printed nothing.')}</div>
            : <pre ref={pre} className="pl-logtext">{data.text}</pre>}
    </div>
  )
}
