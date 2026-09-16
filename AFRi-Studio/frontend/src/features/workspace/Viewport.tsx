import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, useGLTF, Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useStore, activeVersion } from '../../state/store'
import { api } from '../../services/api'
import { Icon, Empty, Spinner } from '../../components/ui'

type ViewName = 'top' | 'front' | 'side' | 'three_quarter'
type Shading = 'shaded' | 'wireframe'

/** The loaded GLB. Blender exports Y-up, so the model arrives rotated. */
function Model({ url, shading, visible, selected, onSelect, exploded,
                 separation, onInfo }: {
  url: string; shading: Shading
  visible: Record<string, boolean>
  selected: string | null
  onSelect: (n: string | null) => void
  exploded: boolean
  separation: number
  onInfo: (info: any) => void
}) {
  const { scene } = useGLTF(url)
  const root = useRef<THREE.Group>(null)

  const parts = useMemo(() => {
    const found: { name: string; mesh: THREE.Mesh }[] = []
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) found.push({ name: o.name, mesh: o as THREE.Mesh })
    })
    return found
  }, [scene])

  useEffect(() => {
    const info: any = { parts: [] }
    const box = new THREE.Box3()
    parts.forEach(({ name, mesh }) => {
      const g = mesh.geometry as THREE.BufferGeometry
      g.computeBoundingBox()
      const b = g.boundingBox!
      info.parts.push({
        name,
        triangles: g.index ? g.index.count / 3 : g.attributes.position.count / 3,
        vertices: g.attributes.position.count,
        size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z],
      })
      box.expandByObject(mesh)
    })
    const s = new THREE.Vector3()
    box.getSize(s)
    // Scene units are 10 mm each. After the Y-up export, Y is height.
    info.bounds_mm = [s.x * 10, s.y * 10, s.z * 10]
    onInfo(info)
  }, [parts, onInfo])

  useEffect(() => {
    parts.forEach(({ name, mesh }) => {
      mesh.visible = visible[name] !== false
      const mat = mesh.material as THREE.MeshStandardMaterial
      if (mat) {
        mat.wireframe = shading === 'wireframe'
        mat.emissive = new THREE.Color(selected === name ? 0x3a2a00 : 0x000000)
        // The glTF export carries the Principled BSDF's base colour but not its
        // sheen, so nudge roughness to keep the petals from reading as plastic.
        mat.roughness = Math.min(0.85, Math.max(0.35, mat.roughness || 0.5))
        mat.flatShading = false
        mat.needsUpdate = true
      }
      const sign = name.includes('piece_a') ? 1 : name.includes('piece_b') ? -1 : 0
      mesh.position.x = exploded ? sign * separation * 0.05 : 0
      mesh.position.z = 0
    })
  }, [parts, visible, shading, selected, exploded, separation])

  // The GLB is exported with export_yup=True, so it already arrives in
  // three.js' Y-up convention. Rotating it again here would lay the flower on
  // its side and show the back of the base disc.
  return (
    <group ref={root}>
      <primitive
        object={scene}
        onClick={(e: any) => { e.stopPropagation(); onSelect(e.object.name) }}
        onPointerMissed={() => onSelect(null)}
      />
    </group>
  )
}

function CameraRig({ view, fit, tick }:
  { view: ViewName; fit: number; tick: number }) {
  const { camera } = useThree()
  useEffect(() => {
    const d = fit
    const pos: Record<ViewName, [number, number, number]> = {
      top: [0, d * 1.6, 0.001],
      front: [0, d * 0.18, d * 1.5],
      side: [d * 1.5, d * 0.2, 0],
      three_quarter: [d * 0.95, d * 0.75, d * 0.95],
    }
    camera.position.set(...pos[view])
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [view, fit, tick, camera])
  return null
}

export function Viewport() {
  const version = useStore(activeVersion)
  const jobs = useStore((s) => s.jobs)
  const [view, setView] = useState<ViewName>('three_quarter')
  const [shading, setShading] = useState<Shading>('shaded')
  const [exploded, setExploded] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showMaster, setShowMaster] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [info, setInfo] = useState<any>(null)
  const [tick, setTick] = useState(0)
  const [mode, setMode] = useState<'model' | 'render'>('model')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const glbUrl = version?.assets?.glb
    ? api.assetUrl(version.id, 'viewer.glb') : null
  const renderKeys = Object.keys(version?.assets ?? {})
    .filter((k) => k !== 'glb' && k !== 'blend' && !k.endsWith('_stl') && !k.endsWith('_obj'))
  const [renderKey, setRenderKey] = useState<string | null>(null)
  useEffect(() => { setRenderKey(renderKeys[0] ?? null) }, [version?.id, renderKeys.length])

  const busy = jobs.some((j) => (j.status === 'running' || j.status === 'claimed') &&
                                j.version_id === version?.id)

  const visible = useMemo(() => ({
    master: showMaster, piece_a: !showMaster, piece_b: !showMaster,
  }), [showMaster])

  const separation = version?.config?.split?.separation_mm ?? 14

  function screenshot() {
    const cvs = document.querySelector('#afri-viewport canvas') as HTMLCanvasElement
    if (!cvs) return
    const a = document.createElement('a')
    a.download = `afri_viewport_${Date.now()}.png`
    a.href = cvs.toDataURL('image/png')
    a.click()
  }

  const views: { id: ViewName; label: string }[] = [
    { id: 'three_quarter', label: '3/4' }, { id: 'top', label: 'Top' },
    { id: 'front', label: 'Front' }, { id: 'side', label: 'Side' },
  ]

  return (
    <div className="flex flex-col h-full min-h-0 bg-ink-900" id="afri-viewport">
      {/* toolbar */}
      <div className="flex items-center gap-1 px-2 h-9 border-b border-ink-700 shrink-0 overflow-x-auto">
        <div className="flex rounded-md bg-ink-800 p-0.5 shrink-0">
          {(['model', 'render'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-2 h-6 rounded text-2xs font-medium transition-colors ${
                mode === m ? 'bg-ink-600 text-mute-300' : 'text-mute-500 hover:text-mute-400'}`}>
              {m === 'model' ? 'Interactive' : 'Blender render'}
            </button>
          ))}
        </div>

        {mode === 'model' ? (
          <>
            <div className="w-px h-4 bg-ink-700 mx-1 shrink-0" />
            {views.map((v) => (
              <button key={v.id} onClick={() => { setView(v.id); setTick(tick + 1) }}
                className={`btn-ghost shrink-0 ${view === v.id ? 'text-marigold-300' : ''}`}>
                {v.label}
              </button>
            ))}
            <button className="btn-ghost shrink-0" onClick={() => setTick(tick + 1)}
                    title="Fit model to view">
              <Icon name="refresh" /> Fit
            </button>
            <div className="w-px h-4 bg-ink-700 mx-1 shrink-0" />
            <button onClick={() => setShading(shading === 'shaded' ? 'wireframe' : 'shaded')}
              className={`btn-ghost shrink-0 ${shading === 'wireframe' ? 'text-marigold-300' : ''}`}>
              <Icon name="grid" /> Wire
            </button>
            <button onClick={() => setExploded(!exploded)}
              className={`btn-ghost shrink-0 ${exploded ? 'text-marigold-300' : ''}`}>
              <Icon name="split" /> {exploded ? 'Separated' : 'Assembled'}
            </button>
            <button onClick={() => setShowMaster(!showMaster)}
              className={`btn-ghost shrink-0 ${showMaster ? 'text-marigold-300' : ''}`}>
              <Icon name="eye" /> {showMaster ? 'Master' : 'Pieces'}
            </button>
            <button onClick={() => setShowGrid(!showGrid)}
              className={`btn-ghost shrink-0 ${showGrid ? 'text-marigold-300' : ''}`}>
              Grid
            </button>
            <div className="flex-1" />
            <button className="btn-ghost shrink-0" onClick={screenshot}>
              <Icon name="camera" /> Capture
            </button>
          </>
        ) : (
          <>
            <div className="w-px h-4 bg-ink-700 mx-1 shrink-0" />
            {renderKeys.map((k) => (
              <button key={k} onClick={() => setRenderKey(k)}
                className={`btn-ghost shrink-0 ${renderKey === k ? 'text-marigold-300' : ''}`}>
                {k.replace(/^\d+_/, '').replace(/_/g, ' ')}
              </button>
            ))}
            <div className="flex-1" />
          </>
        )}
      </div>

      {/* stage */}
      <div className="flex-1 min-h-0 relative">
        {busy && (
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1
                          rounded-md bg-ink-800/90 border border-ink-600 text-2xs text-marigold-300">
            <Spinner className="w-3 h-3" /> generating…
          </div>
        )}

        {mode === 'render' ? (
          renderKey && version ? (
            <div className="h-full grid place-items-center p-3 bg-ink-900">
              <img src={api.assetUrl(version.id, `${renderKey}.png`)}
                   alt={renderKey}
                   className="max-h-full max-w-full object-contain rounded-md
                              border border-ink-700 animate-fade-in" />
            </div>
          ) : (
            <Empty icon="camera" title="No Blender render yet"
                   hint="Apply changes or run a render job. Blender renders are produced by Cycles on the CPU and are higher fidelity than the interactive preview." />
          )
        ) : glbUrl ? (
          <Canvas camera={{ fov: 32, near: 0.1, far: 400, position: [9, 7, 9] }}
                  gl={{ preserveDrawingBuffer: true, antialias: true }}
                  onCreated={({ gl }) => {
                    gl.toneMapping = THREE.ACESFilmicToneMapping
                    gl.toneMappingExposure = 1.15
                  }}
                  dpr={[1, 2]}>
            <color attach="background" args={['#0B0D10']} />
            {/* A low ambient with a strong key is what makes the petal relief
                read; a bright hemisphere light flattens the whole rosette into
                a disc. No HDRI is used, so the viewport works fully offline. */}
            <hemisphereLight intensity={0.16} groundColor="#0d1013" color="#4a5560" />
            <directionalLight position={[6, 11, 5]} intensity={2.6} color="#fff4e2" />
            <directionalLight position={[-8, 4, -7]} intensity={0.55} color="#6f93cc" />
            <directionalLight position={[0, 3, -10]} intensity={0.75} color="#ffd9a0" />
            <pointLight position={[0, 6, 0]} intensity={12} distance={26} color="#ffcf8a" />
            <Suspense fallback={null}>
              <Model url={glbUrl} shading={shading} visible={visible}
                     selected={selected} onSelect={setSelected}
                     exploded={exploded} separation={separation} onInfo={setInfo} />
            </Suspense>
            {showGrid && (
              <Grid args={[40, 40]} cellSize={1} cellColor="#1F252C"
                    sectionSize={5} sectionColor="#2A323B" fadeDistance={45}
                    infiniteGrid position={[0, -0.05, 0]} />
            )}
            <OrbitControls makeDefault enableDamping dampingFactor={0.08}
                           minDistance={2} maxDistance={70} target={[0, 0.6, 0]} />
            <CameraRig view={view} fit={11} tick={tick} />
          </Canvas>
        ) : (
          <Empty icon="cube" title="No model yet"
                 hint="Generate the design to build geometry. The interactive viewport shows the real exported mesh — the same triangles Blender renders." />
        )}

        {/* object info */}
        {mode === 'model' && info && (
          <div className="absolute bottom-2 left-2 px-2 py-1.5 rounded-md bg-ink-850/92
                          border border-ink-700 text-2xs text-mute-500 font-mono
                          pointer-events-none animate-fade-in">
            {info.parts?.map((p: any) => (
              <div key={p.name} className={selected === p.name ? 'text-marigold-300' : ''}>
                {p.name}: {p.triangles.toLocaleString()} tris
              </div>
            ))}
            {info.bounds_mm && (
              <div className="mt-1 pt-1 border-t border-ink-700 text-mute-400">
                {info.bounds_mm[0].toFixed(1)} × {info.bounds_mm[2].toFixed(1)} ×{' '}
                {info.bounds_mm[1].toFixed(1)} mm
              </div>
            )}
          </div>
        )}
        {mode === 'model' && selected && (
          <div className="absolute bottom-2 right-2 px-2 py-1 rounded-md bg-marigold-400/15
                          border border-marigold-400/30 text-2xs text-marigold-300">
            selected: {selected}
          </div>
        )}
      </div>
    </div>
  )
}
