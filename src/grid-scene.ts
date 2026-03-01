/**
 * Spatial model — task-driven pane grid with depth navigation.
 *
 * Panes are created/removed/updated in response to TaskGraph events.
 * The grid scene subscribes to onChange and reflects visible tasks as panes.
 *
 * Decomposition places child panes spatially behind the parent.
 * Clicking a parent with children flies the camera through to the child level.
 * Escape / back button returns to the parent level.
 *
 * Controls:
 *   A         — add a new task (auto-labeled, alternates terminal/plain)
 *   B         — add a browser pane (live tab via CDP relay)
 *   S         — decompose focused task into subtasks
 *   D         — run demo sequence
 *   X         — complete focused task
 *   Click     — focus a pane; click focused parent with children to dive in
 *   Escape    — go up one level (or zoom to overview)
 */

import * as THREE from 'three/webgpu';
import { TaskGraph, type TaskEvent, type TaskNode, type ResourceDescriptor } from './task-graph';
import { Ghostty } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';
import { TerminalTexture } from './terminal-texture';
import { PtyTexture } from './pty-texture';
import { BrowserTexture } from './browser-texture';
import { VoiceClient } from './voice-client';
import { TextTexture } from './text-texture';

// --- Dimensions ---
const PANE_W = 48;
const PANE_H = 24;
const GAP = 4;
const FLY_MS = 400;
const DEPTH_Z = -(PANE_H + GAP) * 1.5;  // Z offset per depth level

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

// Ghostty instance (shared by all terminal panes)
let ghosttyInstance: Ghostty | null = null;
// Terminal textures keyed by task ID
const termTextures = new Map<string, TerminalTexture>();
const ptyTextures = new Map<string, PtyTexture>();
const browserTextures = new Map<string, BrowserTexture>();
const textTextures = new Map<string, TextTexture>();

// WebSocket URLs — configurable via query params
const params = new URLSearchParams(window.location.search);
// WebSocket URLs — use Vite proxy paths so connections work through exe.dev HTTPS proxy
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsBase = `${wsProto}//${location.host}`;
const RELAY_WS_URL = params.get('relay') || `${wsBase}/ws/cdp`;
const PTY_WS_URL = params.get('pty') || `${wsBase}/ws/pty`;
const VOICE_WS_URL = params.get('voice') || `${wsBase}/ws/voice`;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let focusedPane: Pane | null = null;

// Depth navigation: which parent are we viewing children of?
// null = root level. Stack allows nested dive-in.
let currentParentId: string | null = null;
const navStack: (string | null)[] = [];  // previous parent IDs for back navigation

// Task graph
const taskGraph = new TaskGraph();
// Voice client
let voiceClient: VoiceClient | null = null;

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

  // Load Ghostty WASM (needed for terminal panes)
  ghosttyInstance = await Ghostty.load(ghosttyWasmUrl);

  // Subscribe to task graph events
  taskGraph.onChange(onTaskEvent);

  // Start with one PTY pane (real shell on the server)
  taskGraph.createTask('Shell', undefined, { type: 'pty', uri: `pty://${PTY_WS_URL}` });

  // Events
  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('touchend', onTouch);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);

  // Voice
  initVoice();

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
      // Add pane if this task belongs to the level we're currently viewing
      if (task.parentId === currentParentId) {
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
      // Mark the parent pane as having children (visual indicator)
      markPaneHasChildren(event.taskId);
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

  let mat: THREE.MeshBasicNodeMaterial;

  if (task.resource?.type === 'pty' && ghosttyInstance) {
    // Remote PTY pane — real shell via WebSocket
    let ptyTex = ptyTextures.get(task.id);
    if (!ptyTex) {
      ptyTex = new PtyTexture(ghosttyInstance, PTY_WS_URL);
      ptyTextures.set(task.id, ptyTex);
    }
    mat = new THREE.MeshBasicNodeMaterial({ map: ptyTex.texture });
  } else if (task.resource?.type === 'terminal' && ghosttyInstance) {
    // Local terminal pane — Ghostty WASM + LocalShell
    let termTex = termTextures.get(task.id);
    if (!termTex) {
      termTex = new TerminalTexture(ghosttyInstance);
      termTextures.set(task.id, termTex);
    }
    mat = new THREE.MeshBasicNodeMaterial({ map: termTex.texture });
  } else if (task.resource?.type === 'browser') {
    // Live browser tab pane — screencast via CDP relay WebSocket
    let browserTex = browserTextures.get(task.id);
    if (!browserTex) {
      browserTex = new BrowserTexture({ wsUrl: RELAY_WS_URL });
      browserTextures.set(task.id, browserTex);
    }
    mat = new THREE.MeshBasicNodeMaterial({ map: browserTex.texture });
  } else if (task.resource?.type === 'editor') {
    // Text content pane — renders markdown/text onto a canvas
    let textTex = textTextures.get(task.id);
    if (!textTex) {
      const content = task.resource.uri.startsWith('content://')
        ? decodeURIComponent(task.resource.uri.slice('content://'.length))
        : '';
      textTex = new TextTexture({ content, title: task.label });
      textTextures.set(task.id, textTex);
    }
    mat = new THREE.MeshBasicNodeMaterial({ map: textTex.texture });
  } else {
    mat = new THREE.MeshBasicNodeMaterial({ color });
  }

  const geo = new THREE.PlaneGeometry(PANE_W, PANE_H);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.taskId = task.id;

  // Label overlay (only for non-resource panes)
  if (!task.resource || (task.resource.type !== 'terminal' && task.resource.type !== 'pty' && task.resource.type !== 'browser' && task.resource.type !== 'editor')) {
    const labelMesh = makeLabel(task.label, idx + 1);
    labelMesh.position.set(0, 0, 0.1);
    mesh.add(labelMesh);
  }

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

  // Clean up textures
  const termTex = termTextures.get(taskId);
  if (termTex) { termTex.dispose(); termTextures.delete(taskId); }

  const ptyTex = ptyTextures.get(taskId);
  if (ptyTex) { ptyTex.dispose(); ptyTextures.delete(taskId); }

  const browserTex = browserTextures.get(taskId);
  if (browserTex) { browserTex.dispose(); browserTextures.delete(taskId); }

  const textTex = textTextures.get(taskId);
  if (textTex) { textTex.dispose(); textTextures.delete(taskId); }

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

function markPaneHasChildren(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;

  // Add a subtle depth indicator — double-line border bottom
  const borderMat = pane.border.material as THREE.LineBasicNodeMaterial;
  borderMat.color.set(0x6666aa);

  // Add a small "▸" indicator to signal "dive in"
  addDepthIndicator(pane);
}

function addDepthIndicator(pane: Pane): void {
  // Small arrow mesh showing there's depth to explore
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(100,100,200,0.7)';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('▸', 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true });
  const geo = new THREE.PlaneGeometry(3, 3);
  const indicator = new THREE.Mesh(geo, mat);
  indicator.position.set(PANE_W / 2 - 2.5, -PANE_H / 2 + 2.5, 0.2);
  indicator.name = 'depth-indicator';
  pane.mesh.add(indicator);
}

// --- Depth Navigation ---

/** Dive into a parent task — show its children as panes. */
function diveInto(parentTaskId: string): void {
  // Save current level on the stack
  navStack.push(currentParentId);
  currentParentId = parentTaskId;
  focusedPane = null;

  // Remove all current panes from scene
  clearAllPanes();

  // Get children and add them as panes
  const children = taskGraph.getChildren(parentTaskId);
  for (const child of children) {
    addPaneForTask(child);
  }

  updateHUD();
}

/** Navigate back up one level. */
function navigateUp(): void {
  if (navStack.length === 0) return;  // already at root

  currentParentId = navStack.pop()!;
  focusedPane = null;

  // Remove all current panes from scene
  clearAllPanes();

  // Get tasks at this level and add them
  const tasks = currentParentId === null
    ? taskGraph.getRootTasks()
    : taskGraph.getChildren(currentParentId);

  for (const task of tasks) {
    addPaneForTask(task);
  }

  updateHUD();
}

function clearAllPanes(): void {
  for (const pane of [...panes]) {
    scene.remove(pane.mesh);
    scene.remove(pane.border);
    pane.mesh.geometry.dispose();
    pane.border.geometry.dispose();
  }
  // Don't dispose terminal textures — they persist across navigation
  // so state is preserved when diving in/out
  panes.length = 0;
  taskPaneMap.clear();
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
  // Update all live textures
  for (const termTex of termTextures.values()) termTex.update(_time);
  for (const ptyTex of ptyTextures.values()) ptyTex.update(_time);
  for (const browserTex of browserTextures.values()) browserTex.update(_time);

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

function onWheel(event: WheelEvent): void {
  if (!focusedPane) return;
  const textTex = textTextures.get(focusedPane.taskId);
  if (!textTex) return;
  event.preventDefault();
  textTex.scroll(event.deltaY * 0.5);
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
        // If this pane's task has children, dive in
        const task = taskGraph.getTask(pane.taskId);
        if (task && task.childIds.length > 0) {
          diveInto(pane.taskId);
        } else {
          zoomOut();
        }
      } else {
        zoomTo(pane);
      }
    }
  } else if (focusedPane) {
    zoomOut();
  }
}

function onKeyDown(event: KeyboardEvent): void {
  // If a terminal/pty pane is focused, route input to the shell
  if (focusedPane) {
    const termTex = termTextures.get(focusedPane.taskId);
    const ptyTex = ptyTextures.get(focusedPane.taskId);
    const activeTex = ptyTex || termTex;  // prefer pty if both exist (shouldn't)
    if (activeTex && !event.metaKey) {
      if (!event.altKey) {
        if (event.key === 'Escape') {
          // Escape always goes to grid navigation
        } else if (event.key === 'Enter') {
          event.preventDefault();
          activeTex.feed('\r');
          return;
        } else if (event.key === 'Backspace') {
          event.preventDefault();
          activeTex.feed('\x7f');
          return;
        } else if (event.key === 'Tab') {
          event.preventDefault();
          activeTex.feed('\t');
          return;
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          activeTex.feed('\x1b[A');
          return;
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          activeTex.feed('\x1b[B');
          return;
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          activeTex.feed('\x1b[C');
          return;
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          activeTex.feed('\x1b[D');
          return;
        } else if (event.key.length === 1 && event.ctrlKey) {
          event.preventDefault();
          const code = event.key.toLowerCase().charCodeAt(0) - 96;
          if (code > 0 && code < 32) {
            activeTex.feed(String.fromCharCode(code));
          }
          return;
        } else if (event.key.length === 1) {
          event.preventDefault();
          activeTex.feed(event.key);
          return;
        }
      }
    }
  }

  const key = event.key.toLowerCase();
  if (key === 'a') {
    event.preventDefault();
    const label = AUTO_LABELS[autoLabelCounter % AUTO_LABELS.length];
    autoLabelCounter++;
    // Alternate: every other pane is a terminal
    const resource = (autoLabelCounter % 2 === 0)
      ? { type: 'terminal' as const, uri: `wasm://ghostty/term/${label.toLowerCase().replace(/\s/g, '-')}` }
      : undefined;
    taskGraph.createTask(label, currentParentId ?? undefined, resource);
  } else if (key === 'p') {
    // Create a PTY pane (real shell via WebSocket)
    event.preventDefault();
    const label = `Shell ${autoLabelCounter++}`;
    const resource: ResourceDescriptor = { type: 'pty', uri: `pty://${PTY_WS_URL}` };
    taskGraph.createTask(label, currentParentId ?? undefined, resource);
  } else if (key === 'b') {
    // Create a browser pane (live tab via CDP relay)
    event.preventDefault();
    const label = 'Browser';
    const resource: ResourceDescriptor = {
      type: 'browser',
      uri: `cdp://remote/tab/live`,
    };
    taskGraph.createTask(label, currentParentId ?? undefined, resource);
  } else if (key === 's') {
    event.preventDefault();
    if (focusedPane) {
      const task = taskGraph.getTask(focusedPane.taskId);
      if (task && task.childIds.length === 0) {
        // Decompose into 3 random subtasks
        const subs = ['Design', 'Implement', 'Test', 'Review', 'Deploy', 'Research', 'Refactor'];
        const pick = [0, 1, 2].map(i => `${subs[(autoLabelCounter + i) % subs.length]} ${task.label}`);
        autoLabelCounter += 3;
        taskGraph.decompose(task.id, pick);
      }
    }
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
    if (focusedPane) {
      zoomOut();
    } else if (navStack.length > 0) {
      navigateUp();
    }
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

  // Create a mix of resource types
  taskGraph.createTask('Build', undefined,
    { type: 'terminal', uri: 'wasm://ghostty/term/build' });
  await delay(500);

  const deployTask = taskGraph.createTask('Deploy');
  await delay(500);

  taskGraph.createTask('Tests', undefined,
    { type: 'terminal', uri: 'wasm://ghostty/term/tests' });
  await delay(500);

  // Decompose Deploy into children, dive in, come back
  taskGraph.decompose(deployTask.id, ['Stage', 'Smoke test', 'Promote']);
  await delay(600);

  const deployPane = taskPaneMap.get(deployTask.id);
  if (deployPane) zoomTo(deployPane);
  await delay(800);

  diveInto(deployTask.id);
  await delay(1500);

  navigateUp();
  await delay(500);
  zoomOut();

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

  // Breadcrumb: show navigation path
  const breadcrumb: string[] = ['root'];
  for (const parentId of navStack) {
    if (parentId !== null) {
      const t = taskGraph.getTask(parentId);
      breadcrumb.push(t ? t.label : parentId);
    }
  }
  if (currentParentId !== null) {
    const t = taskGraph.getTask(currentParentId);
    breadcrumb.push(t ? t.label : currentParentId);
  }

  const depth = navStack.length;
  const depthStr = depth > 0 ? ` · depth ${depth}` : '';

  const parts: string[] = [`${panes.length} pane${panes.length !== 1 ? 's' : ''}${depthStr}`];

  // Show breadcrumb if not at root
  if (currentParentId !== null) {
    parts.push(breadcrumb.join(' › '));
  }

  const keys = ['P:shell', 'A:add', 'B:browser', 'S:split', 'D:demo', 'X:done', 'Click:focus/dive', 'Esc:back'];
  hudEl.innerHTML = `${parts.join(' · ')}<br>${keys.join(' · ')}`;
}

// --- Voice commands from LLM ---

function handleVoiceCommand(cmd: { action: string; [key: string]: unknown }): void {
  switch (cmd.action) {
    case 'create_task': {
      const label = String(cmd.label || 'Task');
      const parentId = cmd.parentId ? String(cmd.parentId) : (currentParentId ?? undefined);
      taskGraph.createTask(label, parentId);
      break;
    }
    case 'create_pty': {
      const label = String(cmd.label || 'Shell');
      const resource: ResourceDescriptor = { type: 'pty', uri: `pty://${PTY_WS_URL}` };
      taskGraph.createTask(label, currentParentId ?? undefined, resource);
      break;
    }
    case 'create_browser': {
      const label = String(cmd.label || 'Browser');
      const resource: ResourceDescriptor = { type: 'browser', uri: 'cdp://remote/tab/live' };
      taskGraph.createTask(label, currentParentId ?? undefined, resource);
      break;
    }
    case 'complete_task': {
      // Find by taskId or label
      if (cmd.taskId) {
        taskGraph.completeAndDestroy(String(cmd.taskId));
      } else if (cmd.label) {
        const label = String(cmd.label).toLowerCase();
        const tasks = currentParentId ? taskGraph.getChildren(currentParentId) : taskGraph.getRootTasks();
        const match = tasks.find(t => t.label.toLowerCase().includes(label));
        if (match) taskGraph.completeAndDestroy(match.id);
      }
      break;
    }
    default:
      console.log('[voice] Unknown command action:', cmd.action);
  }
}

// --- Voice ---

let voiceOverlay: HTMLElement | null = null;
let micBtn: HTMLElement | null = null;
let transcriptEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;

function initVoice(): void {
  // Create voice UI overlay
  voiceOverlay = document.createElement('div');
  voiceOverlay.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    z-index: 20; display: flex; flex-direction: column; align-items: center; gap: 8px;
    pointer-events: none;
  `;

  // Transcript bubble
  transcriptEl = document.createElement('div');
  transcriptEl.style.cssText = `
    background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
    padding: 8px 16px; font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: rgba(255,255,255,0.8); max-width: 500px; text-align: center;
    opacity: 0; transition: opacity 0.2s; pointer-events: none;
  `;
  voiceOverlay.appendChild(transcriptEl);

  // Status pill
  statusEl = document.createElement('div');
  statusEl.style.cssText = `
    background: rgba(0,0,0,0.65); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
    padding: 4px 12px; font: 11px -apple-system, system-ui, sans-serif;
    color: rgba(255,255,255,0.5); opacity: 0; transition: opacity 0.2s;
    pointer-events: none;
  `;
  voiceOverlay.appendChild(statusEl);

  // Mic button (toggle, not hold)
  micBtn = document.createElement('button');
  micBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>`;
  micBtn.style.cssText = `
    pointer-events: auto; width: 56px; height: 56px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.5);
    backdrop-filter: blur(8px); color: rgba(255,255,255,0.6); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; -webkit-tap-highlight-color: transparent;
  `;
  voiceOverlay.appendChild(micBtn);

  // Connection dot
  const connDot = document.createElement('div');
  connDot.id = 'voice-conn';
  connDot.style.cssText = `
    position: fixed; top: 12px; right: 12px; width: 8px; height: 8px;
    border-radius: 50%; background: #ff4466; z-index: 20; transition: background 0.3s;
  `;
  document.body.appendChild(connDot);
  document.body.appendChild(voiceOverlay);

  // Voice client
  let transcriptFadeTimer: number | null = null;

  voiceClient = new VoiceClient({
    wsUrl: VOICE_WS_URL,
    deepgramApiKey: params.get('dgkey') || 'REDACTED_DEEPGRAM_KEY',
    elevenlabsApiKey: params.get('elkey') || 'REDACTED_ELEVENLABS_KEY',
    onTranscript(text, isFinal) {
      if (transcriptFadeTimer !== null) clearTimeout(transcriptFadeTimer);
      if (text && !isFinal) {
        transcriptEl!.textContent = text;
        transcriptEl!.style.opacity = '1';
      } else {
        transcriptFadeTimer = window.setTimeout(() => {
          transcriptEl!.style.opacity = '0';
        }, 500);
      }
    },
    onResponse(text) {
      console.log('[voice] Response:', text);
    },
    onStateChange(state) {
      updateVoiceUI(state);
    },
    onError(message) {
      console.error('[voice] Error:', message);
      statusEl!.textContent = '\u26a0 ' + message;
      statusEl!.style.opacity = '1';
      setTimeout(() => { statusEl!.style.opacity = '0'; }, 3000);
    },
    onConnected(connected) {
      connDot.style.background = connected ? '#44ff88' : '#ff4466';
    },
    onCommand(cmd) {
      console.log('[voice] Command:', cmd);
      handleVoiceCommand(cmd);
    },
    onInit(data) {
      if (data.todo) {
        // Create a todo pane with the content rendered as text
        const content = data.todo;
        const resource: ResourceDescriptor = {
          type: 'editor',
          uri: `content://${encodeURIComponent(content)}`,
        };
        taskGraph.createTask('Todo', currentParentId ?? undefined, resource);
      }
    },
  });

  voiceClient.connect();

  // Click to toggle conversation mode
  micBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    voiceClient!.toggleConversation();
  });

  // Spacebar toggle (when no terminal focused)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !focusedPane && !e.repeat) {
      e.preventDefault();
      voiceClient!.toggleConversation();
    }
  });
}

function updateVoiceUI(state: string): void {
  if (!micBtn || !statusEl) return;

  switch (state) {
    case 'idle':
      micBtn.style.background = 'rgba(0,0,0,0.5)';
      micBtn.style.borderColor = 'rgba(255,255,255,0.15)';
      micBtn.style.color = 'rgba(255,255,255,0.6)';
      micBtn.style.boxShadow = 'none';
      statusEl.style.opacity = '0';
      break;
    case 'listening':
      micBtn.style.background = '#ff4466';
      micBtn.style.borderColor = '#ff4466';
      micBtn.style.color = 'white';
      micBtn.style.boxShadow = '0 0 20px rgba(255,68,102,0.4)';
      statusEl.textContent = '\uD83C\uDFA4 Listening...';
      statusEl.style.opacity = '1';
      break;
    case 'processing':
      micBtn.style.background = '#4466ff';
      micBtn.style.borderColor = '#4466ff';
      micBtn.style.color = 'white';
      micBtn.style.boxShadow = '0 0 20px rgba(68,102,255,0.4)';
      statusEl.textContent = 'Thinking...';
      statusEl.style.opacity = '1';
      break;
    case 'speaking':
      micBtn.style.background = '#44bb88';
      micBtn.style.borderColor = '#44bb88';
      micBtn.style.color = 'white';
      micBtn.style.boxShadow = '0 0 20px rgba(68,187,136,0.4)';
      statusEl.textContent = '\u266A Speaking';
      statusEl.style.opacity = '1';
      break;
  }
}

// --- Go ---
init().catch(console.error);
