/**
 * Spatial model prototype.
 *
 * Dynamic pane grid in a Three.js WebGPU scene.
 * Panes are added/removed at runtime. Layout adapts.
 * Camera flies between overview and focused pane.
 *
 * Controls:
 *   Space     — add a pane
 *   Backspace — remove last pane
 *   Click     — focus a pane (click again or Escape to zoom out)
 *   Escape    — zoom to overview
 */

import * as THREE from 'three/webgpu';

// --- Dimensions ---
const PANE_W = 48;
const PANE_H = 24;
const GAP = 4;
const FLY_MS = 400;

// --- Types ---
interface Pane {
  mesh: THREE.Mesh;
  border: THREE.LineSegments;
  label: string;
}

// --- State ---
let renderer: THREE.WebGPURenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let container: HTMLElement;
const panes: Pane[] = [];
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let focusedPane: Pane | null = null;

// Camera animation
let animating = false;
let animStart = 0;
const animFrom = new THREE.Vector3();
const animTo = new THREE.Vector3();
const lookFrom = new THREE.Vector3();
const lookTo = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();

// --- Pane labels ---
const LABELS = [
  'Agent', 'To-do list', 'API server', 'Database',
  'Tests', 'Deploy', 'Docs', 'Monitoring',
  'Auth service', 'Frontend', 'CI/CD', 'Logs',
];

const COLORS = [
  0x1e1e3a, 0x1a2a3e, 0x0f3460, 0x1b1b2f,
  0x162447, 0x1f4068, 0x1a1a40, 0x1b1b4b,
  0x2a2a5a, 0x1e2a1e, 0x2a1e2a, 0x2a2a1e,
];

// --- Init ---
async function init() {
  container = document.getElementById('scene')!;

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050508);

  camera = new THREE.PerspectiveCamera(
    50, container.clientWidth / container.clientHeight, 0.1, 500
  );

  // Start with one pane
  addPane();

  // Events
  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('touchend', onTouch);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);

  // HUD
  updateHUD();

  renderer.setAnimationLoop((time) => {
    tick(time);
    renderer.render(scene, camera);
  });
}

// --- Pane CRUD ---

function addPane(): void {
  const idx = panes.length;
  const label = LABELS[idx % LABELS.length];
  const color = COLORS[idx % COLORS.length];

  // Pane background
  const geo = new THREE.PlaneGeometry(PANE_W, PANE_H);
  const mat = new THREE.MeshBasicNodeMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.paneIndex = idx;

  // Label texture
  const labelMesh = makeLabel(label, idx + 1);
  labelMesh.position.set(0, 0, 0.1);
  mesh.add(labelMesh);

  // Border
  const border = makeBorder();

  scene.add(mesh);
  scene.add(border);

  panes.push({ mesh, border, label });
  relayout();
  updateHUD();
}

function removePane(): void {
  if (panes.length === 0) return;
  if (focusedPane === panes[panes.length - 1]) focusedPane = null;

  const pane = panes.pop()!;
  scene.remove(pane.mesh);
  scene.remove(pane.border);
  pane.mesh.geometry.dispose();
  pane.border.geometry.dispose();

  relayout();
  updateHUD();
}

// --- Layout ---

function gridSize(n: number): [number, number] {
  if (n === 0) return [0, 0];
  if (n === 1) return [1, 1];
  if (n === 2) return [2, 1];
  const aspect = container.clientWidth / container.clientHeight;
  const paneAspect = (PANE_W + GAP) / (PANE_H + GAP);
  // Find cols that best matches screen aspect
  let bestCols = 1;
  let bestScore = Infinity;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const gridAspect = (c * paneAspect) / r;
    const score = Math.abs(Math.log(gridAspect / aspect));
    if (score < bestScore) {
      bestScore = score;
      bestCols = c;
    }
  }
  return [bestCols, Math.ceil(n / bestCols)];
}

function relayout(): void {
  const n = panes.length;
  if (n === 0) {
    setCameraOverview();
    return;
  }

  const [cols, rows] = gridSize(n);

  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Center the grid at origin
    const x = (col - (cols - 1) / 2) * (PANE_W + GAP);
    const y = ((rows - 1) / 2 - row) * (PANE_H + GAP);
    panes[i].mesh.position.set(x, y, 0);
    panes[i].border.position.set(x, y, 0);
  }

  if (focusedPane) {
    zoomTo(focusedPane);
  } else {
    setCameraOverview();
  }
}

// --- Camera ---

function overviewPos(): THREE.Vector3 {
  const n = panes.length;
  if (n === 0) return new THREE.Vector3(0, 0, 50);
  const [cols, rows] = gridSize(n);
  const gridW = cols * PANE_W + (cols - 1) * GAP;
  const gridH = rows * PANE_H + (rows - 1) * GAP;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect;
  const distH = (gridH / 2) / Math.tan(fovRad / 2);
  const distW = (gridW / 2) / (aspect * Math.tan(fovRad / 2));
  return new THREE.Vector3(0, 0, Math.max(distH, distW) * 1.2);
}

function focusPos(pane: Pane): THREE.Vector3 {
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect;
  const distH = (PANE_H / 2) / Math.tan(fovRad / 2);
  const distW = (PANE_W / 2) / (aspect * Math.tan(fovRad / 2));
  const dist = Math.max(distH, distW) * 1.08;
  return new THREE.Vector3(
    pane.mesh.position.x,
    pane.mesh.position.y,
    dist
  );
}

function setCameraOverview(): void {
  const pos = overviewPos();
  animateTo(pos, new THREE.Vector3(0, 0, 0));
}

function zoomTo(pane: Pane): void {
  focusedPane = pane;
  const pos = focusPos(pane);
  const target = new THREE.Vector3(pane.mesh.position.x, pane.mesh.position.y, 0);
  animateTo(pos, target);

  // Dim unfocused panes
  for (const p of panes) {
    const m = p.mesh.material as THREE.MeshBasicNodeMaterial;
    m.opacity = p === pane ? 1.0 : 0.15;
    m.transparent = true;
  }
  for (const p of panes) {
    const bm = p.border.material as THREE.LineBasicNodeMaterial;
    bm.opacity = p === pane ? 1.0 : 0.15;
    bm.transparent = true;
  }
}

function zoomOut(): void {
  focusedPane = null;
  for (const p of panes) {
    const m = p.mesh.material as THREE.MeshBasicNodeMaterial;
    m.opacity = 1.0;
    m.transparent = false;
  }
  for (const p of panes) {
    const bm = p.border.material as THREE.LineBasicNodeMaterial;
    bm.opacity = 1.0;
    bm.transparent = false;
  }
  setCameraOverview();
}

function animateTo(pos: THREE.Vector3, lookAt: THREE.Vector3): void {
  animFrom.copy(camera.position);
  animTo.copy(pos);
  // Current lookAt: project forward from camera
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  lookFrom.copy(camera.position).add(dir.multiplyScalar(100));
  lookTo.copy(lookAt);
  animStart = performance.now();
  animating = true;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function tick(_time: number): void {
  if (!animating) return;
  const elapsed = performance.now() - animStart;
  const t = Math.min(elapsed / FLY_MS, 1);
  const e = easeInOutCubic(t);

  camera.position.lerpVectors(animFrom, animTo, e);
  _tmpLook.lerpVectors(lookFrom, lookTo, e);
  camera.lookAt(_tmpLook);

  if (t >= 1) {
    animating = false;
    camera.position.copy(animTo);
    camera.lookAt(lookTo);
  }
}

// --- Interaction ---

function onTouch(event: TouchEvent): void {
  event.preventDefault();
  const touch = event.changedTouches[0];
  if (!touch) return;
  handlePointer(touch.clientX, touch.clientY);
}

function onClick(event: MouseEvent): void {
  handlePointer(event.clientX, event.clientY);
}

function handlePointer(clientX: number, clientY: number): void {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const meshes = panes.map(p => p.mesh);
  const hits = raycaster.intersectObjects(meshes, false);

  if (hits.length > 0) {
    const hitMesh = hits[0].object as THREE.Mesh;
    const pane = panes.find(p => p.mesh === hitMesh);
    if (pane) {
      if (focusedPane === pane) {
        zoomOut();
      } else {
        zoomTo(pane);
      }
    }
  } else if (focusedPane) {
    zoomOut();
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === ' ') {
    event.preventDefault();
    addPane();
  } else if (event.key === 'Backspace') {
    event.preventDefault();
    removePane();
  } else if (event.key === 'Escape') {
    if (focusedPane) zoomOut();
  }
}

function onResize(): void {
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  relayout();
}

// --- Visual helpers ---

function makeLabel(text: string, num: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Big number watermark
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.font = 'bold 160px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 256, 110);

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '28px monospace';
  ctx.fillText(text, 256, 215);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true });
  const geo = new THREE.PlaneGeometry(PANE_W * 0.9, PANE_H * 0.9);
  return new THREE.Mesh(geo, mat);
}

function makeBorder(): THREE.LineSegments {
  const hw = PANE_W / 2, hh = PANE_H / 2;
  const pts = [
    new THREE.Vector3(-hw, -hh, 0.05), new THREE.Vector3(hw, -hh, 0.05),
    new THREE.Vector3(hw, -hh, 0.05), new THREE.Vector3(hw, hh, 0.05),
    new THREE.Vector3(hw, hh, 0.05), new THREE.Vector3(-hw, hh, 0.05),
    new THREE.Vector3(-hw, hh, 0.05), new THREE.Vector3(-hw, -hh, 0.05),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicNodeMaterial({ color: 0x333355 });
  return new THREE.LineSegments(geo, mat);
}

// --- HUD ---
let hudEl: HTMLElement | null = null;

function updateHUD(): void {
  if (!hudEl) {
    hudEl = document.createElement('div');
    hudEl.style.cssText = 'position:fixed;top:12px;left:12px;color:rgba(255,255,255,0.4);font:13px monospace;pointer-events:none;z-index:10;line-height:1.6';
    document.body.appendChild(hudEl);
  }
  hudEl.textContent = `${panes.length} pane${panes.length !== 1 ? 's' : ''} · Space: add · Backspace: remove · Click: focus · Esc: overview`;
}

// --- Go ---
init().catch(console.error);
