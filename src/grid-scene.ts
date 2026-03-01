/**
 * Spatial model — task-driven pane grid.
 *
 * Panes are created/removed/updated in response to TaskGraph events.
 * The grid scene subscribes to onChange and reflects visible tasks as panes.
 *
 * Controls:
 *   A         — add a new task (auto-labeled)
 *   D         — run demo sequence
 *   X         — complete focused task
 *   Click     — focus a pane (click again or Escape to zoom out)
 *   Escape    — zoom to overview
 */

import * as THREE from 'three/webgpu';
import { TaskGraph, type TaskEvent, type TaskNode } from './task-graph';

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
  taskId: string;
}

// --- State ---
let renderer: THREE.WebGPURenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let container: HTMLElement;
const panes: Pane[] = [];
const taskPaneMap = new Map<string, Pane>();  // task ID → Pane
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let focusedPane: Pane | null = null;

// Task graph
const taskGraph = new TaskGraph();
let autoLabelCounter = 0;
const AUTO_LABELS = [
  'Agent', 'To-do list', 'API server', 'Database',
  'Tests', 'Deploy', 'Docs', 'Monitoring',
  'Auth service', 'Frontend', 'CI/CD', 'Logs',
];

// Camera animation
let animating = false;
let animStart = 0;
const animFrom = new THREE.Vector3();
const animTo = new THREE.Vector3();
const lookFrom = new THREE.Vector3();
const lookTo = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();

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

  // Subscribe to task graph events
  taskGraph.onChange(onTaskEvent);

  // Start with one task
  taskGraph.createTask('Agent');

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

// --- Task → Pane bridge ---

function onTaskEvent(event: TaskEvent): void {
  switch (event.type) {
    case 'created': {
      const task = taskGraph.getTask(event.taskId);
      if (!task) break;
      // Only add panes for root-level (visible) tasks
      if (task.parentId === null) {
        addPaneForTask(task);
      }
      break;
    }
    case 'destroyed': {
      removePaneForTask(event.taskId);
      break;
    }
    case 'completed': {
      flashPaneComplete(event.taskId);
      break;
    }
    case 'decomposed': {
      // Parent pane stays visible. Children are "behind" it conceptually.
      // TODO: depth rendering — show child panes stacked behind parent
      // For now the parent pane remains and children don't get their own top-level panes
      // (they're sub-tasks, not root-visible).
      updateHUD();
      break;
    }
    case 'activated': {
      highlightPaneActive(event.taskId);
      break;
    }
  }
}

function addPaneForTask(task: TaskNode): void {
  const idx = panes.length;
  const color = COLORS[idx % COLORS.length];

  // Pane background
  const geo = new THREE.PlaneGeometry(PANE_W, PANE_H);
  const mat = new THREE.MeshBasicNodeMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.taskId = task.id;

  // Label texture
  const labelMesh = makeLabel(task.label, idx + 1);
  labelMesh.position.set(0, 0, 0.1);
  mesh.add(labelMesh);

  // Border
  const border = makeBorder();

  scene.add(mesh);
  scene.add(border);

  const pane: Pane = { mesh, border, label: task.label, taskId: task.id };
  panes.push(pane);
  taskPaneMap.set(task.id, pane);
  relayout();
  updateHUD();
}

function removePaneForTask(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;

  if (focusedPane === pane) focusedPane = null;

  scene.remove(pane.mesh);
  scene.remove(pane.border);
  pane.mesh.geometry.dispose();
  pane.border.geometry.dispose();

  const idx = panes.indexOf(pane);
  if (idx !== -1) panes.splice(idx, 1);
  taskPaneMap.delete(taskId);

  relayout();
  updateHUD();
}

function flashPaneComplete(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;

  // Flash green
  const mat = pane.mesh.material as THREE.MeshBasicNodeMaterial;
  const borderMat = pane.border.material as THREE.LineBasicNodeMaterial;
  mat.color.set(0x1a4a1a);
  borderMat.color.set(0x33aa55);

  // Revert border color after a short delay, then remove after longer delay
  setTimeout(() => {
    borderMat.color.set(0x333355);
  }, 600);

  updateHUD();
}

function highlightPaneActive(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;

  const borderMat = pane.border.material as THREE.LineBasicNodeMaterial;
  borderMat.color.set(0x5577ff);
  updateHUD();
}

// --- Layout ---

function gridSize(n: number): [number, number] {
  if (n === 0) return [0, 0];
  if (n === 1) return [1, 1];
  if (n === 2) return [2, 1];
  const aspect = container.clientWidth / container.clientHeight;
  const paneAspect = (PANE_W + GAP) / (PANE_H + GAP);
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
  const key = event.key.toLowerCase();
  if (key === 'a') {
    event.preventDefault();
    const label = AUTO_LABELS[autoLabelCounter % AUTO_LABELS.length];
    autoLabelCounter++;
    taskGraph.createTask(label);
  } else if (key === 'x') {
    event.preventDefault();
    if (focusedPane) {
      const taskId = focusedPane.taskId;
      taskGraph.completeAndDestroy(taskId);
    }
  } else if (key === 'd') {
    event.preventDefault();
    runDemoSequence();
  } else if (event.key === 'Escape') {
    if (focusedPane) zoomOut();
  }
}

// --- Demo sequence ---
let demoRunning = false;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDemoSequence(): Promise<void> {
  if (demoRunning) return;
  demoRunning = true;

  // Step 1: Create "To-do list" task
  const todo = taskGraph.createTask('To-do list');
  await delay(800);

  // Step 2: Activate it
  taskGraph.activate(todo.id);
  await delay(600);

  // Step 3: Decompose into 3 subtasks
  const subs = taskGraph.decompose(todo.id, ['Design UI', 'Build API', 'Write tests']);
  await delay(1000);

  // Step 4: Create a separate root task to show grid growth
  taskGraph.createTask('Deploy');
  await delay(800);

  // Step 5: Complete one subtask
  taskGraph.complete(subs[0].id);
  await delay(1000);

  // Step 6: Complete the parent (to-do list) with flash
  taskGraph.complete(todo.id);
  await delay(1500);

  // Step 7: Destroy the completed parent (removes its pane)
  taskGraph.destroy(todo.id);
  await delay(500);

  demoRunning = false;
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

  const visible = taskGraph.getVisibleTasks();
  const pending = visible.filter(t => t.status === 'pending').length;
  const active = visible.filter(t => t.status === 'active').length;
  const complete = visible.filter(t => t.status === 'complete').length;

  const parts: string[] = [`${panes.length} pane${panes.length !== 1 ? 's' : ''}`];
  const statParts: string[] = [];
  if (pending) statParts.push(`${pending} pending`);
  if (active) statParts.push(`${active} active`);
  if (complete) statParts.push(`${complete} done`);
  if (statParts.length) parts.push(statParts.join(', '));

  hudEl.innerHTML = `${parts.join(' · ')}<br>A: add · D: demo · X: complete focused · Click: focus · Esc: overview`;
}

// --- Go ---
init().catch(console.error);
