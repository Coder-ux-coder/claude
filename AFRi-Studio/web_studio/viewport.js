/* AFRi Studio -- the stage.
 *
 * A viewport owns one canvas, one WebGL context and one copy of the scene.
 * Everything about it is an instance, which is what lets the Compare view put
 * two of them side by side and drive both cameras from one drag.
 */

import { MATERIALS, ENVIRONMENTS, VIEWS } from './schema.js';

const THREE = window.THREE;

export function createViewport(canvas, opts = {}) {
  const interactive = opts.interactive !== false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true,
    // Capture reads the live buffer back, so on the viewport that produces
    // thumbnails and stills the buffer has to survive the frame. The compare
    // panes never capture, and keeping this off there costs them nothing.
    preserveDrawingBuffer: opts.capture !== false,
  });
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
  camera.up.set(0, 0, 1);

  /* ---- lighting rig, rebuilt whenever the environment changes ---- */
  const rig = new THREE.Group();
  scene.add(rig);
  let envKey = null;
  function setEnvironment(key) {
    const env = ENVIRONMENTS.find((e) => e.key === key) || ENVIRONMENTS[0];
    if (envKey === env.key) return;
    envKey = env.key;
    for (const ch of rig.children.slice()) rig.remove(ch);
    rig.add(new THREE.HemisphereLight(env.hemi[0], env.hemi[1], env.hemi[2]));
    for (const spec of [env.key_, env.fill, env.rim]) {
      const l = new THREE.DirectionalLight(spec[0], spec[1]);
      l.position.set(spec[2][0], spec[2][1], spec[2][2]);
      rig.add(l);
    }
  }
  setEnvironment(opts.environment || 'studio');

  /* ---- contact shadow ----
   * A painted pool rather than a shadow map: the same read at a fraction of
   * the cost on 130,000 triangles, and it survives a wireframe toggle. */
  const poolCanvas = document.createElement('canvas');
  poolCanvas.width = poolCanvas.height = 256;
  {
    const g = poolCanvas.getContext('2d');
    const rg = g.createRadialGradient(128, 128, 8, 128, 128, 126);
    rg.addColorStop(0, 'rgba(0,0,0,0.5)');
    rg.addColorStop(0.55, 'rgba(0,0,0,0.18)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
  }
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(poolCanvas), transparent: true,
      depthWrite: false, opacity: 0.9,
    })
  );
  pool.position.z = -0.12;
  pool.visible = false;   // nothing to cast it until geometry arrives
  scene.add(pool);

  /* ---- materials ---- */
  const mk = (hex, rough, metal) => new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex), roughness: rough, metalness: metal,
  });
  const matA = mk(0xF2A007, 0.62, 0.02);
  const matB = mk(0xE0780D, 0.62, 0.02);
  const matWallA = mk(0xC8541B, 0.48, 0.02);
  const matWallB = mk(0xA8431A, 0.48, 0.02);
  const matHat = mk(0x17150F, 0.92, 0.0);
  const matBand = mk(0x0B0A08, 0.55, 0.0);
  let materialKey = null;
  function setMaterial(key) {
    const m = MATERIALS.find((x) => x.key === key) || MATERIALS[0];
    if (materialKey === m.key) return;
    materialKey = m.key;
    matA.color.setHex(m.a); matB.color.setHex(m.b);
    matWallA.color.setHex(m.wall);
    matWallB.color.setHex(m.wall).multiplyScalar(0.82);
    for (const mm of [matA, matB]) { mm.roughness = m.roughness; mm.metalness = m.metalness; }
    for (const mm of [matWallA, matWallB]) { mm.roughness = m.wallRough; mm.metalness = m.metalness; }
  }
  setMaterial(opts.material || 'resin');

  /* ---- groups ---- */
  const rootA = new THREE.Group();
  const rootB = new THREE.Group();
  const rootHat = new THREE.Group();
  scene.add(rootA, rootB, rootHat);

  const curveGeo = new THREE.BufferGeometry();
  curveGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const curveLine = new THREE.Line(curveGeo, new THREE.LineBasicMaterial({ color: 0x8FD6FF }));
  curveLine.renderOrder = 999;
  curveLine.material.depthTest = false;
  curveLine.visible = false;
  scene.add(curveLine);

  /* ---- camera state ---- */
  const cam = { az: 0.66, el: 0.52, dist: 26, target: new THREE.Vector3(0, 0, 0.9) };
  let framed = false, frameR = 4.7, lastHatR = 0;
  let autoSpin = interactive && !reduceMotion && opts.autoSpin !== false;
  let sepDir = [1, 0];
  let loaded = false;
  let viewKey = 'three_quarter';
  let onCamera = null;
  let mm = 1;                       // scene units per millimetre, set on load

  function setView(key) {
    const v = VIEWS[key] || VIEWS.three_quarter;
    viewKey = key;
    autoSpin = false;
    cam.az = v[0]; cam.el = v[1]; cam.dist = v[2] * (frameR || 4.7);
  }

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function place() {
    const ce = Math.cos(cam.el), se = Math.sin(cam.el);
    camera.position.set(
      cam.target.x + cam.dist * ce * Math.cos(cam.az),
      cam.target.y + cam.dist * ce * Math.sin(cam.az),
      cam.target.z + cam.dist * se
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(cam.target);
  }

  let running = true;
  function tick() {
    if (!running) return;
    if (autoSpin) cam.az += 0.0016;
    place();
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(tick);

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  /* ---- pointer control ---- */
  if (interactive) {
    let drag = null, pinch = 0;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      autoSpin = false;
      canvas.classList.add('dragging');
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      cam.az -= (e.clientX - drag.x) * 0.0072;
      cam.el = Math.max(-1.45, Math.min(1.45, cam.el + (e.clientY - drag.y) * 0.0062));
      drag = { x: e.clientX, y: e.clientY };
      if (onCamera) onCamera(cam);
    });
    const end = (e) => {
      drag = null; canvas.classList.remove('dragging');
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault(); autoSpin = false;
      cam.dist = Math.max(6, Math.min(90, cam.dist * (1 + Math.sign(e.deltaY) * 0.09)));
      if (onCamera) onCamera(cam);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
      if (pinch) {
        autoSpin = false;
        cam.dist = Math.max(6, Math.min(90, cam.dist * pinch / d));
        if (onCamera) onCamera(cam);
      }
      pinch = d;
    }, { passive: true });
    canvas.addEventListener('touchend', () => { pinch = 0; });
  }

  /* ---- geometry upload ---- */
  function buildGroup(group, piece, mat, wallMat) {
    for (const ch of group.children.slice()) { ch.geometry.dispose(); group.remove(ch); }
    if (!piece) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(piece.pos, 3));
    if (piece.flowerIdx.length) {
      const g1 = geo.clone();
      g1.setIndex(new THREE.BufferAttribute(piece.flowerIdx, 1));
      g1.computeVertexNormals();
      group.add(new THREE.Mesh(g1, mat));
    }
    if (piece.wallIdx.length) {
      const g2 = geo.clone();
      g2.setIndex(new THREE.BufferAttribute(piece.wallIdx, 1));
      g2.computeVertexNormals();
      const m = new THREE.Mesh(g2, wallMat);
      m.userData.isWall = true;
      group.add(m);
    }
    geo.dispose();
  }

  function setResult(res, MM) {
    mm = MM;
    loaded = true;
    sepDir = res.sepDir;
    buildGroup(rootA, res.A, matA, matWallA);
    buildGroup(rootB, res.B, matB, matWallB);
    buildGroup(rootHat, res.hat, matHat, matBand);
    rootHat.visible = !!res.hat;

    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(res.curve, 3));
    curveLine.geometry.dispose();
    curveLine.geometry = cg;

    // The hat is roughly four times the flower across, so whenever it is on it
    // decides both the framing and where the camera looks.
    const hatR = res.metrics.hat ? res.metrics.hat.overall_diameter_mm * 0.5 * MM : 0;
    frameR = hatR || res.metrics.radius_scene;
    cam.target.set(0, 0, hatR
      ? res.metrics.hat.overall_height_mm * MM * 0.34
      : res.metrics.height_scene * 0.45);
    if (!framed || hatR !== lastHatR) {
      framed = true; lastHatR = hatR;
      cam.dist = (VIEWS[viewKey] || VIEWS.three_quarter)[2] * frameR;
    }
  }

  function setDisplay(ui) {
    rootA.visible = ui.mode !== 'b';
    rootB.visible = ui.mode !== 'a';
    const half = (ui.gapMm || 0) * mm * 0.5;
    rootA.position.set(sepDir[0] * half, sepDir[1] * half, 0);
    rootB.position.set(-sepDir[0] * half, -sepDir[1] * half, 0);
    for (const g of [rootA, rootB]) {
      for (const ch of g.children) if (ch.userData.isWall) ch.visible = ui.showWall;
    }
    matA.wireframe = matB.wireframe = matWallA.wireframe = matWallB.wireframe = !!ui.wireframe;
    curveLine.visible = !!ui.showCurve;
    pool.visible = loaded && ui.showGround !== false;
  }

  /* How many millimetres one CSS pixel spans at the camera's focal distance.
   * This is what the scale bar is drawn from, so the number under it is
   * measured rather than decorative. */
  function mmPerPixel() {
    const h = canvas.clientHeight || 1;
    const worldPerPx = 2 * cam.dist * Math.tan((camera.fov * Math.PI / 180) / 2) / h;
    return worldPerPx / mm;
  }

  /* The stage sweep, painted into the scene for a capture. On screen the
   * backdrop is CSS behind a transparent canvas, which is free and follows the
   * theme; a saved still has no CSS behind it, so the same sweep is drawn into
   * the render instead of leaving the flower on black. */
  function backdrop(c1, c2) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 512;
    const g = cv.getContext('2d');
    g.fillStyle = c2; g.fillRect(0, 0, 512, 512);
    const rg = g.createRadialGradient(256, 164, 12, 256, 164, 392);
    rg.addColorStop(0, c1); rg.addColorStop(1, c2);
    g.fillStyle = rg; g.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* Render once at a multiple of the on-screen size and hand back the pixels.
   * Restores the live size before returning so the viewport never flickers. */
  function capture({ scale = 2, type = 'image/png', quality = 0.92, width, height, sweep } = {}) {
    const w0 = canvas.clientWidth || 640, h0 = canvas.clientHeight || 480;
    const w = Math.max(16, Math.round(width || w0 * scale));
    const h = Math.max(16, Math.round(height || h0 * scale));
    const dpr = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    let tex = null;
    if (sweep) { tex = backdrop(sweep[0], sweep[1]); scene.background = tex; }
    place();
    renderer.render(scene, camera);
    let url = '';
    try { url = canvas.toDataURL(type, quality); } catch (e) { url = ''; }
    if (tex) { scene.background = null; tex.dispose(); }
    renderer.setPixelRatio(dpr);
    resize();
    place();
    renderer.render(scene, camera);
    return url;
  }

  return {
    cam, camera, scene, renderer,
    setResult, setDisplay, setView, setMaterial, setEnvironment,
    capture, mmPerPixel, resize,
    get viewKey() { return viewKey; },
    get frameRadius() { return frameR || 4.7; },
    get loaded() { return loaded; },
    get spinning() { return autoSpin; },
    set spinning(v) { autoSpin = !!v; },
    onCamera(fn) { onCamera = fn; },
    syncFrom(other) {
      cam.az = other.az; cam.el = other.el; cam.dist = other.dist;
      cam.target.copy(other.target);
    },
    setPoolOpacity(v) { pool.material.opacity = v; },
    stop() { running = false; renderer.setAnimationLoop(null); ro.disconnect(); },
  };
}
