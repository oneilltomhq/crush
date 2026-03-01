/**
 * Spatial workspace — voice-driven pane grid.
 *
 * Panes are created/removed/updated in response to TaskGraph events,
 * triggered exclusively by voice commands from the LLM.
 *
 * No keyboard shortcuts. No mouse interaction. Voice only.
 * Tap anywhere on the canvas to toggle conversation mode.
 */

import * as THREE from 'three/webgpu';
import { TaskGraph, type TaskEvent, type TaskNode, type ResourceDescriptor } from './task-graph';
import { Ghostty } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';
import { VoiceClient } from './voice-client';
import {
  Pane, PtyPane, BrowserPane, TextPane, TerminalPane, PlainPane,
  PANE_W, PANE_H,
} from './pane';

// --- Dimensions ---
const GAP = 4;
const FLY_MS = 400;
const DEPTH_Z = -(PANE_H + GAP) * 1.5;

// --- State ---
let renderer: THREE.WebGPURenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let container: HTMLElement;
const panes: Pane[] = [];
const taskPaneMap = new Map<string, Pane>();

// Ghostty instance (shared by all terminal panes)
let ghosttyInstance: Ghostty | null = null;

// WebSocket URLs
const params = new URLSearchParams(window.location.search);
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsBase = `${wsProto}//${location.host}`;
const RELAY_WS_URL = params.get('relay') || `${wsBase}/ws/cdp`;
const PTY_WS_URL = params.get('pty') || `${wsBase}/ws/pty`;
const VOICE_WS_URL = params.get('voice') || `${wsBase}/ws/voice`;

// Depth navigation
let currentParentId: string | null = null;
const navStack: (string | null)[] = [];

// Task graph
const taskGraph = new TaskGraph();
let voiceClient: VoiceClient | null = null;
let autoLabelCounter = 0;

// Camera animation
let animating = false;
let animStart = 0;
const animFrom = new THREE.Vector3();
const animTo = new THREE.Vector3();
const lookFrom = new THREE.Vector3();
const lookTo = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();

// Voice state — drives scene atmosphere
type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';
let currentVoiceState: VoiceState = 'idle';

// Scene atmosphere colors
const ATMOSPHERE = {
  idle:       { bg: 0x050508, border: 0x333355, glow: 0x000000 },
  listening:  { bg: 0x0a0508, border: 0x664455, glow: 0xff4466 },
  processing: { bg: 0x050810, border: 0x334466, glow: 0x4466ff },
  speaking:   { bg: 0x050a08, border: 0x336644, glow: 0x44bb88 },
} as const;

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

  // Load Ghostty WASM
  ghosttyInstance = await Ghostty.load(ghosttyWasmUrl);

  // Subscribe to task graph events
  taskGraph.onChange(onTaskEvent);

  // Start with one PTY pane
  taskGraph.createTask('Shell', undefined, { type: 'pty', uri: `pty://${PTY_WS_URL}` });

  // Tap canvas to toggle voice
  renderer.domElement.addEventListener('click', () => {
    voiceClient?.toggleConversation();
  });

  window.addEventListener('resize', onResize);

  // Voice
  initVoice();

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
      if (task.parentId === currentParentId) {
        addPaneForTask(task);
      }
      break;
    }
    case 'destroyed':
      removePaneForTask(event.taskId);
      break;
    case 'completed':
      flashPaneComplete(event.taskId);
      break;
    case 'decomposed':
      markPaneHasChildren(event.taskId);
      break;
    case 'activated':
      highlightPaneActive(event.taskId);
      break;
  }
}

function addPaneForTask(task: TaskNode): void {
  let pane: Pane;

  if (task.resource?.type === 'pty' && ghosttyInstance) {
    pane = new PtyPane(task.id, task.label, ghosttyInstance, PTY_WS_URL);
  } else if (task.resource?.type === 'terminal' && ghosttyInstance) {
    pane = new TerminalPane(task.id, task.label, ghosttyInstance);
  } else if (task.resource?.type === 'browser') {
    pane = new BrowserPane(task.id, task.label, RELAY_WS_URL);
  } else if (task.resource?.type === 'editor') {
    const content = task.resource.uri.startsWith('content://')
      ? decodeURIComponent(task.resource.uri.slice('content://'.length))
      : '';
    pane = new TextPane(task.id, task.label, content);
  } else {
    pane = new PlainPane(task.id, task.label);
  }

  scene.add(pane.mesh);
  scene.add(pane.border);
  panes.push(pane);
  taskPaneMap.set(task.id, pane);
  relayout();
}

function removePaneForTask(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;

  scene.remove(pane.mesh);
  scene.remove(pane.border);
  pane.dispose();

  const idx = panes.indexOf(pane);
  if (idx !== -1) panes.splice(idx, 1);
  taskPaneMap.delete(taskId);

  relayout();
}

function flashPaneComplete(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;
  pane.setBorderColor(0x33aa55);
  setTimeout(() => pane.setBorderColor(0x333355), 600);
}

function highlightPaneActive(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;
  pane.setBorderColor(0x5577ff);
}

function markPaneHasChildren(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (!pane) return;
  pane.setBorderColor(0x6666aa);
}

// --- Depth Navigation ---

function diveInto(parentTaskId: string): void {
  navStack.push(currentParentId);
  currentParentId = parentTaskId;
  clearAllPanes();
  const children = taskGraph.getChildren(parentTaskId);
  for (const child of children) addPaneForTask(child);
}

function navigateUp(): void {
  if (navStack.length === 0) return;
  currentParentId = navStack.pop()!;
  clearAllPanes();
  const tasks = currentParentId === null
    ? taskGraph.getRootTasks()
    : taskGraph.getChildren(currentParentId);
  for (const task of tasks) addPaneForTask(task);
}

function clearAllPanes(): void {
  for (const pane of [...panes]) {
    scene.remove(pane.mesh);
    scene.remove(pane.border);
    // Don't dispose — textures persist across depth navigation
  }
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
    panes[i].setPosition(x, y, 0);
  }
  setCameraOverview();
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

function setCameraOverview(): void {
  animateTo(overviewPos(), new THREE.Vector3(0, 0, 0));
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

function tick(time: number): void {
  // Update all pane textures
  for (const pane of panes) pane.update(time);

  // Update scene atmosphere based on voice state
  updateAtmosphere();

  // Camera animation
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

// --- Scene Atmosphere ---

function updateAtmosphere(): void {
  const atm = ATMOSPHERE[currentVoiceState];
  const bg = scene.background as THREE.Color;
  const targetBg = new THREE.Color(atm.bg);
  bg.lerp(targetBg, 0.03);

  // Subtle border glow on all panes during active states
  if (currentVoiceState !== 'idle') {
    // Don't override individual pane border colors — just gently pulse
    // the scene background is enough for now
  }
}

function onResize(): void {
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  relayout();
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

let transcriptEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;

function initVoice(): void {
  // Transcript bar — minimal, anchored to bottom of viewport
  const voiceBar = document.createElement('div');
  voiceBar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; flex-direction: column; align-items: center;
    padding: 16px 24px 24px; pointer-events: none; z-index: 20;
  `;

  transcriptEl = document.createElement('div');
  transcriptEl.style.cssText = `
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: rgba(255,255,255,0.7); max-width: 600px; text-align: center;
    opacity: 0; transition: opacity 0.3s;
  `;
  voiceBar.appendChild(transcriptEl);

  statusEl = document.createElement('div');
  statusEl.style.cssText = `
    font: 11px -apple-system, system-ui, sans-serif;
    color: rgba(255,255,255,0.35); margin-top: 4px;
    opacity: 0; transition: opacity 0.3s;
  `;
  voiceBar.appendChild(statusEl);

  document.body.appendChild(voiceBar);

  // Connection indicator — tiny dot, top-right
  const connDot = document.createElement('div');
  connDot.id = 'voice-conn';
  connDot.style.cssText = `
    position: fixed; top: 12px; right: 12px; width: 6px; height: 6px;
    border-radius: 50%; background: #ff4466; z-index: 20; transition: background 0.3s;
  `;
  document.body.appendChild(connDot);

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
        }, 800);
      }
    },
    onResponse(text) {
      console.log('[voice] Response:', text);
    },
    onStateChange(state) {
      currentVoiceState = state as VoiceState;
      updateVoiceStatusText(state);
    },
    onError(message) {
      console.error('[voice] Error:', message);
      if (statusEl) {
        statusEl.textContent = message;
        statusEl.style.opacity = '1';
        setTimeout(() => { statusEl!.style.opacity = '0'; }, 3000);
      }
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
}

function updateVoiceStatusText(state: string): void {
  if (!statusEl) return;
  switch (state) {
    case 'idle':
      statusEl.style.opacity = '0';
      break;
    case 'listening':
      statusEl.textContent = 'listening';
      statusEl.style.opacity = '1';
      break;
    case 'processing':
      statusEl.textContent = 'thinking';
      statusEl.style.opacity = '1';
      break;
    case 'speaking':
      statusEl.textContent = 'speaking';
      statusEl.style.opacity = '1';
      break;
  }
}

// --- Go ---
init().catch(console.error);
