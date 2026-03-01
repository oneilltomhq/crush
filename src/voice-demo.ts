/**
 * Voice-mock demo — scripted agent conversation drives task creation.
 *
 * No keyboard needed. The "agent" initiates, asks what you're working on,
 * and crystallizes tasks from the conversation. Tasks emerge as 3D panes.
 *
 * This mocks the voice pipeline (Deepgram STT + ElevenLabs TTS) by
 * injecting text strings on timers. The agent doesn't care about input source.
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
const taskPaneMap = new Map<string, Pane>();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let focusedPane: Pane | null = null;

const taskGraph = new TaskGraph();

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

// =============================================
// Chat overlay
// =============================================
let chatEl: HTMLElement;
let chatMessages: HTMLElement;
let typingEl: HTMLElement;

function initChat(): void {
  chatEl = document.createElement('div');
  chatEl.id = 'chat';
  chatEl.innerHTML = `
    <div id="chat-messages"></div>
    <div id="chat-typing" class="hidden">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
    </div>
  `;
  document.body.appendChild(chatEl);
  chatMessages = document.getElementById('chat-messages')!;
  typingEl = document.getElementById('chat-typing')!;
}

function addMessage(role: 'agent' | 'user', text: string): void {
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping(): void { typingEl.classList.remove('hidden'); }
function hideTyping(): void { typingEl.classList.add('hidden'); }

// =============================================
// Scripted conversation
// =============================================
type Action =
  | { type: 'agent'; text: string }
  | { type: 'user'; text: string }
  | { type: 'think'; ms: number }
  | { type: 'create'; label: string }
  | { type: 'activate'; index: number }  // activate the Nth root task (0-based)
  | { type: 'decompose'; index: number; children: string[] }
  | { type: 'complete'; index: number }
  | { type: 'pause'; ms: number };

const script: Action[] = [
  // Agent initiates
  { type: 'think', ms: 800 },
  { type: 'agent', text: "Hey! What are we working on today?" },
  { type: 'pause', ms: 2200 },

  // User responds
  { type: 'user', text: "I need to ship the new landing page by Friday." },
  { type: 'think', ms: 1200 },
  { type: 'agent', text: "Got it — landing page, Friday deadline. Let me set that up." },
  { type: 'create', label: 'Landing page' },
  { type: 'pause', ms: 1000 },

  { type: 'agent', text: "What else is on your plate?" },
  { type: 'pause', ms: 2000 },

  { type: 'user', text: "There's also a bug in the auth flow that's blocking users." },
  { type: 'think', ms: 800 },
  { type: 'agent', text: "Auth bug — sounds urgent. Adding that." },
  { type: 'create', label: 'Auth bug' },
  { type: 'pause', ms: 800 },

  { type: 'user', text: "And I promised the team I'd write the API docs." },
  { type: 'think', ms: 600 },
  { type: 'create', label: 'API docs' },
  { type: 'agent', text: "Three things — landing page, auth bug, API docs. Which one do you want to tackle first?" },
  { type: 'pause', ms: 2200 },

  // User picks one
  { type: 'user', text: "The auth bug is blocking people, let's start there." },
  { type: 'think', ms: 1000 },
  { type: 'activate', index: 1 },  // Auth bug
  { type: 'agent', text: "Focusing on the auth bug. Can you describe what's happening?" },
  { type: 'pause', ms: 2500 },

  { type: 'user', text: "Users get a 401 after the OAuth redirect. I think the token refresh is broken." },
  { type: 'think', ms: 1500 },
  { type: 'agent', text: "Okay, I'm breaking that down — we need to check the redirect handler, the token refresh logic, and add a regression test." },
  { type: 'decompose', index: 1, children: ['Fix redirect handler', 'Debug token refresh', 'Add regression test'] },
  { type: 'pause', ms: 2000 },

  // Complete a subtask
  { type: 'user', text: "Actually, I already looked at the redirect handler — it's fine. The issue is in the refresh." },
  { type: 'think', ms: 800 },
  { type: 'agent', text: "Nice, crossing off the redirect handler then." },
  { type: 'complete', index: 3 },  // "Fix redirect handler" is the 4th root-visible task (index 3)
  { type: 'pause', ms: 1500 },

  { type: 'agent', text: "Two things left on the auth bug, plus the landing page and docs. We're making progress. 💪" },
  { type: 'pause', ms: 2000 },

  // Complete more
  { type: 'user', text: "Found it — the refresh token wasn't being stored after rotation. Fixed and pushed." },
  { type: 'think', ms: 1000 },
  { type: 'agent', text: "Great catch. Marking that done." },
  { type: 'complete', index: 3 },  // "Debug token refresh" is now at visible index 3
  { type: 'pause', ms: 1200 },

  { type: 'user', text: "And I wrote the test. Auth bug is fully resolved." },
  { type: 'think', ms: 800 },
  { type: 'agent', text: "Boom! Auth bug is done. Destroying it." },
  { type: 'complete', index: 3 },  // "Add regression test"
  { type: 'pause', ms: 800 },
  { type: 'complete', index: 1 },  // Complete parent "Auth bug"
  { type: 'pause', ms: 1500 },

  { type: 'agent', text: "Two tasks left — landing page and API docs. What's next?" },
];

async function runScript(): Promise<void> {
  const rootTaskIds: string[] = [];  // track created root task IDs in order

  for (const action of script) {
    switch (action.type) {
      case 'agent':
        hideTyping();
        addMessage('agent', action.text);
        await delay(Math.max(600, action.text.length * 35)); // simulate speech duration
        break;

      case 'user':
        addMessage('user', action.text);
        await delay(Math.max(400, action.text.length * 30));
        break;

      case 'think':
        showTyping();
        await delay(action.ms);
        break;

      case 'create': {
        const task = taskGraph.createTask(action.label);
        rootTaskIds.push(task.id);
        await delay(400);
        break;
      }

      case 'activate': {
        const visible = taskGraph.getVisibleTasks();
        if (action.index < visible.length) {
          taskGraph.activate(visible[action.index].id);
        }
        await delay(300);
        break;
      }

      case 'decompose': {
        const visible = taskGraph.getVisibleTasks();
        if (action.index < visible.length) {
          const subs = taskGraph.decompose(visible[action.index].id, action.children);
          // children become visible, track them
          for (const s of subs) rootTaskIds.push(s.id);
        }
        await delay(600);
        break;
      }

      case 'complete': {
        const visible = taskGraph.getVisibleTasks();
        if (action.index < visible.length) {
          taskGraph.completeAndDestroy(visible[action.index].id);
        }
        await delay(600);
        break;
      }

      case 'pause':
        await delay(action.ms);
        break;
    }
  }
  hideTyping();
  // Show replay button
  const replayBtn = document.getElementById('replay');
  if (replayBtn) replayBtn.style.display = 'block';
}

// =============================================
// Task → Pane bridge (same as grid-scene)
// =============================================
function onTaskEvent(event: TaskEvent): void {
  switch (event.type) {
    case 'created': {
      const task = taskGraph.getTask(event.taskId);
      if (!task) break;
      if (task.parentId === null) addPaneForTask(task);
      break;
    }
    case 'destroyed':
      removePaneForTask(event.taskId);
      break;
    case 'completed':
      flashPaneComplete(event.taskId);
      break;
    case 'decomposed':
      updateHUD();
      break;
    case 'activated':
      highlightPaneActive(event.taskId);
      break;
  }
}

function addPaneForTask(task: TaskNode): void {
  const idx = panes.length;
  const color = COLORS[idx % COLORS.length];
  const geo = new THREE.PlaneGeometry(PANE_W, PANE_H);
  const mat = new THREE.MeshBasicNodeMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.taskId = task.id;

  const labelMesh = makeLabel(task.label, idx + 1);
  labelMesh.position.set(0, 0, 0.1);
  mesh.add(labelMesh);

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
  scene.remove(pane.mesh);
  scene.remove(pane.border);
  const idx = panes.indexOf(pane);
  if (idx >= 0) panes.splice(idx, 1);
  taskPaneMap.delete(taskId);
  if (focusedPane === pane) { focusedPane = null; zoomOut(); }
  relayout();
  updateHUD();
}

function flashPaneComplete(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;
  const mat = pane.mesh.material as THREE.MeshBasicNodeMaterial;
  const orig = mat.color.getHex();
  mat.color.set(0x00ff88);
  setTimeout(() => {
    mat.color.set(orig);
    removePaneForTask(taskId);
  }, 500);
}

function highlightPaneActive(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;
  const bmat = pane.border.material as THREE.LineBasicNodeMaterial;
  bmat.color.set(0x88aaff);
}

// =============================================
// Layout, camera, interaction (reused from grid-scene)
// =============================================
function gridSize(n: number): [number, number] {
  if (n <= 0) return [1, 1];
  if (n === 1) return [1, 1];
  if (n === 2) return [2, 1];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return [cols, rows];
}

function relayout(): void {
  const n = panes.length;
  if (n === 0) return;
  const [cols, rows] = gridSize(n);
  const totalW = cols * PANE_W + (cols - 1) * GAP;
  const totalH = rows * PANE_H + (rows - 1) * GAP;

  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (PANE_W + GAP) - totalW / 2 + PANE_W / 2;
    const y = -(row * (PANE_H + GAP) - totalH / 2 + PANE_H / 2);
    const p = panes[i];
    p.mesh.position.set(x, y, 0);
    p.border.position.set(x, y, 0);
  }

  if (!focusedPane) setCameraOverview();
}

function overviewPos(): THREE.Vector3 {
  const n = panes.length || 1;
  const [cols, rows] = gridSize(n);
  const totalW = cols * PANE_W + (cols - 1) * GAP;
  const totalH = rows * PANE_H + (rows - 1) * GAP;
  const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
  const distH = (totalH / 2) / Math.tan(fovRad);
  const distW = (totalW / 2) / Math.tan(fovRad) / camera.aspect;
  const dist = Math.max(distH, distW) * 1.15;
  return new THREE.Vector3(0, 0, Math.max(dist, 30));
}

function focusPos(pane: Pane): THREE.Vector3 {
  const pos = pane.mesh.position.clone();
  const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
  const dist = (PANE_H / 2) / Math.tan(fovRad) * 1.05;
  pos.z = dist;
  return pos;
}

function setCameraOverview(): void {
  const target = overviewPos();
  animateTo(target, new THREE.Vector3(0, 0, 0));
}

function zoomTo(pane: Pane): void {
  focusedPane = pane;
  const target = focusPos(pane);
  const look = pane.mesh.position.clone();
  animateTo(target, look);
}

function zoomOut(): void {
  focusedPane = null;
  const target = overviewPos();
  animateTo(target, new THREE.Vector3(0, 0, 0));
}

function animateTo(pos: THREE.Vector3, lookAt: THREE.Vector3): void {
  animFrom.copy(camera.position);
  animTo.copy(pos);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  lookFrom.copy(camera.position).add(dir.multiplyScalar(10));
  lookTo.copy(lookAt);
  animStart = performance.now();
  animating = true;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function tick(_time: number): void {
  if (animating) {
    const elapsed = performance.now() - animStart;
    const t = Math.min(elapsed / FLY_MS, 1);
    const e = easeInOutCubic(t);
    camera.position.lerpVectors(animFrom, animTo, e);
    _tmpLook.lerpVectors(lookFrom, lookTo, e);
    camera.lookAt(_tmpLook);
    if (t >= 1) animating = false;
  }
  renderer.render(scene, camera);
}

function onTouch(event: TouchEvent): void {
  if (event.touches.length !== 1) return;
  event.preventDefault();
  const t = event.touches[0];
  handlePointer(t.clientX, t.clientY);
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
    const hitMesh = hits[0].object;
    const pane = panes.find(p => p.mesh === hitMesh);
    if (pane) {
      if (focusedPane === pane) zoomOut();
      else zoomTo(pane);
    }
  } else if (focusedPane) {
    zoomOut();
  }
}

function onResize(): void {
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  relayout();
}

// =============================================
// Visual helpers
// =============================================
function makeLabel(text: string, num: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.font = 'bold 160px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 256, 110);
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

// =============================================
// HUD
// =============================================
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
  hudEl.innerHTML = parts.join(' · ');
}

// =============================================
// Utilities
// =============================================
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================
// Init
// =============================================
async function init(): Promise<void> {
  container = document.getElementById('scene')!;

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050508);

  camera = new THREE.PerspectiveCamera(
    50,
    container.clientWidth / container.clientHeight,
    0.1,
    1000,
  );
  camera.position.set(0, 0, 60);
  camera.lookAt(0, 0, 0);

  // Subscribe to task events
  taskGraph.onChange(onTaskEvent);

  // Interaction
  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('touchstart', onTouch, { passive: false });
  window.addEventListener('resize', onResize);

  // Chat overlay
  initChat();

  // Start render loop
  renderer.setAnimationLoop(tick);

  // Start the scripted conversation after a short delay
  await delay(1200);
  runScript();
}

init().catch(console.error);
