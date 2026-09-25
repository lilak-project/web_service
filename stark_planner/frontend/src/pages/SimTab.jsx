// The design stage: nptoy's full-bleed 3D viewer with a floating rail, carrying
// the volume dock it came with plus the planner and kinematics docks.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Stack, SlidersHorizontal, Ruler, ChartLine, Crosshair, ArrowsOutSimple, Bookmarks } from '@phosphor-icons/react'
import { RailNav } from 'lilak-ui'
import { usePlanner } from '../stark/store.jsx'
import { defaultStyles, sceneFrame } from '../stark/scene.js'
import VolumesPanel from './panels/VolumesPanel.jsx'
import PlannerPanel from './panels/PlannerPanel.jsx'
import KinematicsPanel from './panels/KinematicsPanel.jsx'
import ProfilesPanel from './panels/ProfilesPanel.jsx'
import ZEditPanel from './panels/ZEditPanel.jsx'
import '../g4/styles.css'
import '../stark/planner.css'

// three.js + react-three-fiber are ~1 MB — load them with the stage, not the app.
const Viewer = lazy(() => import('../g4/Viewer.jsx'))

const PANELS = [
  { key: 'profiles', label: 'profiles', Icon: Bookmarks },
  { key: 'planner', label: 'planner', Icon: Ruler },
  { key: 'zedit', label: 'z-edit', Icon: Crosshair },
  { key: 'volumes', label: 'volumes', Icon: Stack },
  { key: 'display', label: 'display', Icon: SlidersHorizontal },
]

const hexToRgbArr = (hex) => {
  const h = (hex || '#ffffff').replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0)
}
const isDarkHex = (hex) => { const [r, g, b] = hexToRgbArr(hex); return 0.299 * r + 0.587 * g + 0.114 * b < 128 }
const rgbCss = (hex) => hexToRgbArr(hex).join(',')

function webglSupported() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch { return false }
}

const EMPTY_EVENT = { tracks: [], edep: [], meta: { n_events: 0, n_points: 0, energy_max: 0 } }

export default function SimTab() {
  const P = usePlanner()
  const { S, scene, setSel, setView, gen } = P
  const [active, setActive] = useState('profiles')
  // kinematics is what you watch WHILE editing, so it is its own dock on the
  // other side of the stage rather than another entry in the exclusive set
  const [kin, setKin] = useState(false)
  const [hidden, setHidden] = useState(() => new Set())
  const [styles, setStyles] = useState({})
  const [ortho, setOrtho] = useState(false)
  const [bgColor, setBgColor] = useState('#ffffff')
  const [glass, setGlass] = useState(0.42)
  const [showAxes, setShowAxes] = useState(true)
  const controlsRef = useRef(null)
  const viewerApi = useRef(null)
  // World framing is pinned, not recomputed per edit — otherwise moving a ring
  // shifts the scene under a camera that lives in world coordinates. `fit`
  // re-reads it on demand.
  const [frame, setFrame] = useState(null)

  // Re-seed styling and re-frame the world whenever the setup is REPLACED — a
  // loaded profile has different volume names and a different extent, so keeping
  // the old framing leaves it off-screen. Plain edits are left alone on purpose.
  const seeded = useRef(-1)
  useEffect(() => {
    if (seeded.current === gen || !scene.length) return
    seeded.current = gen
    setStyles(defaultStyles(scene))
    setFrame(sceneFrame(scene))
  }, [scene, gen])

  // Drop hidden ids that no longer exist (a component was deleted).
  useEffect(() => {
    setHidden((h) => {
      if (!h.size) return h
      const live = new Set(scene.map((g) => g.id))
      const n = new Set([...h].filter((i) => live.has(i)))
      return n.size === h.size ? h : n
    })
  }, [scene])

  const show = useMemo(() => ({ tracks: false, edep: false, axes: showAxes, pointSize: 0.5 }), [showAxes])

  const onPick = (g) => { if (g.starkId) setSel(g.starkId) }

  const railItems = [
    ...PANELS.map(({ key, label, Icon }) => ({
      id: key, label, Icon, on: active === key,
      onClick: () => setActive((a) => (a === key ? null : key)),
    })),
    { type: 'divider' },
    {
      id: 'kinematics', label: 'kinematics', Icon: ChartLine, on: kin,
      weight: kin ? 'fill' : 'regular', title: '킨매틱스 (따로 열림)',
      onClick: () => setKin((v) => !v),
    },
    {
      id: 'fit', label: 'fit', Icon: ArrowsOutSimple, title: '전체가 보이는 처음 각도로',
      onClick: () => { setFrame(sceneFrame(scene)); viewerApi.current?.resetView?.() },
    },
  ]

  return (
    <div className={`stage ${isDarkHex(bgColor) ? 'darkui' : ''} clearglass`}
      style={{ '--glass-panel': glass, '--glass-rail': +(glass * 0.72).toFixed(2), '--glass-rgb': rgbCss(bgColor) }}>
      {!webglSupported() ? (
        <div className="placeholder viewererr">
          <div className="vetitle">3D 뷰어를 표시할 수 없습니다 (WebGL 사용 불가)</div>
          <div className="vemsg">브라우저가 WebGL 컨텍스트를 만들지 못했습니다. 설계 데이터는 정상이며 3D 렌더링만 막혀 있습니다.</div>
        </div>
      ) : (
        <Suspense fallback={<div className="placeholder">3D 뷰어 로딩…</div>}>
          {/* Keyed on `gen` so a loaded profile REMOUNTS the rig: the Viewer caches
              the live camera, and re-framing under it would leave the scene
              off-screen. Flying the camera back instead depends on rAF, which a
              blurred window stalls — that is what left the stage blank until you
              switched windows. Remounting is instant and needs no animation. */}
          <Viewer key={gen} geometry={scene} event={EMPTY_EVENT} show={show} ortho={ortho} bgColor={bgColor}
            hidden={hidden} styles={styles} trackStyles={{}} pointStyle={{}}
            controlsRef={controlsRef} apiRef={viewerApi}
            onPick={onPick} frame={frame} />
        </Suspense>
      )}

      <RailNav float items={railItems} />

      {kin && (
        <div className="simpanel kinematics right">
          <div className="sphead">
            <span className="sptitle">kinematics</span>
            <button className="spclose" title="닫기" onClick={() => setKin(false)}>✕</button>
          </div>
          <div className="spbody"><KinematicsPanel /></div>
        </div>
      )}

      {active && (
        <div className={`simpanel ${active}`}>
          <div className="sphead">
            <span className="sptitle">{active}</span>
            <button className="spclose" title="닫기" onClick={() => setActive(null)}>✕</button>
          </div>
          <div className="spbody">
            {active === 'planner' && <PlannerPanel />}
            {active === 'volumes' && (
              <VolumesPanel geometry={scene} hidden={hidden} setHidden={setHidden}
                styles={styles} setStyles={setStyles} />
            )}
            {active === 'profiles' && <ProfilesPanel />}
            {active === 'zedit' && <ZEditPanel />}
            {active === 'display' && (
              <div className="displaypanel">
                <label className="vsrow"><span>직교 투영</span>
                  <input type="checkbox" checked={ortho} onChange={(e) => setOrtho(e.target.checked)} /></label>
                <label className="vsrow"><span>축 표시</span>
                  <input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} /></label>
                <label className="vsrow"><span>링 프레임</span>
                  <input type="checkbox" checked={S.view.showFrames !== false}
                    onChange={(e) => setView({ showFrames: e.target.checked })} /></label>
                <label className="vsrow"><span>빔 3σ</span>
                  <input type="checkbox" checked={S.view.showBeam !== false}
                    onChange={(e) => setView({ showBeam: e.target.checked })} /></label>
                <label className="vsrow"><span>배경</span>
                  <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} /></label>
                <label className="vsrow"><span>패널 불투명도</span>
                  <input type="range" min="0" max="1" step="0.02" value={glass}
                    onChange={(e) => setGlass(+e.target.value)} />
                  <b className="vsval">{glass.toFixed(2)}</b></label>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
