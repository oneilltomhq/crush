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
  PANE_W, PANE_H, DEFAULT_BORDER_COLOR,
} from './pane';

// --- Dimensions ---
const GAP = 4;
const FLY_MS = 400;
const DEPTH_Z = -(PANE_H + GAP) * 1.5;

// --- Agent-presence flash ---
const FLASH_COLOR = 0xffaa44;   // warm gold/amber
const FLASH_DURATION = 800;     // ms
const _defaultBorderColor = new THREE.Color(DEFAULT_BORDER_COLOR);

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

// Transcript (DOM overlay only, no 3D pane)

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
// Set to false to disable voice-state background color shifts
const ENABLE_ATMOSPHERE = true;
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

  // Demo mode: ?demo=browser shows a single browser pane cycling through sites
  const demoMode = params.get('demo');
  if (demoMode === 'browser') {
    runBrowserDemo();
  } else {
    // Panes created after user taps to start (via onInit from server)
  }

  // Tap-to-start overlay
  const overlay = document.createElement('div');
  overlay.id = 'start-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 100;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; background: #050508;
  `;
  overlay.innerHTML = `
    <div style="text-align:center; font: 18px/1.6 -apple-system, system-ui, sans-serif; color: rgba(255,255,255,0.6);">
      <div style="font-size: 28px; color: rgba(255,255,255,0.9); margin-bottom: 12px;">crush</div>
      <div>tap anywhere to start</div>
    </div>
  `;
  document.body.appendChild(overlay);

  let started = false;
  const startOnTap = async () => {
    if (started) return;
    started = true;
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.4s';
    setTimeout(() => overlay.remove(), 500);

    // Unlock audio playback with a silent buffer (user gesture required)
    try {
      const ctx = new AudioContext();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      await ctx.close();
    } catch (_) { /* ignore */ }

    // Ask server for opening line (will trigger TTS)
    voiceClient?.sendStartSignal();

    // Start mic capture
    try {
      await voiceClient?.startConversation();
    } catch (e) {
      console.warn('[voice] Mic unavailable:', e);
    }
  };
  overlay.addEventListener('click', startOnTap);

  // After started, tap canvas to toggle voice
  renderer.domElement.addEventListener('click', () => {
    if (!started) return;
    voiceClient?.toggleConversation();
  });

  window.addEventListener('resize', onResize);

  // Voice (skip in demo mode)
  if (!demoMode) initVoice();

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

function tickFlashes(): void {
  const now = performance.now();
  for (const pane of panes) {
    if (!pane._flashColor) continue;
    const elapsed = now - pane._flashStart;
    if (elapsed >= pane._flashDuration) {
      // Flash complete — reset to default
      (pane.border.material as THREE.LineBasicNodeMaterial).color.copy(_defaultBorderColor);
      pane._flashColor = null;
    } else {
      // Lerp from flash color back to default
      const t = elapsed / pane._flashDuration;
      (pane.border.material as THREE.LineBasicNodeMaterial).color
        .copy(pane._flashColor)
        .lerp(_defaultBorderColor, t);
    }
  }
}

/** Flash a pane border to indicate agent action. */
function flashPane(taskId: string): void {
  const pane = taskPaneMap.get(taskId);
  if (pane) pane.flash(FLASH_COLOR, FLASH_DURATION);
}

function tick(time: number): void {
  // Update all pane textures
  for (const pane of panes) pane.update(time);

  // Tick active border flashes (agent-presence glow)
  tickFlashes();

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
  if (!ENABLE_ATMOSPHERE) return;

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

// --- Voice commands from LLM (tool use) ---

function handleCommand(cmd: { name: string; input: Record<string, unknown> }): void {
  const { name, input } = cmd;

  switch (name) {
    case 'create_pane': {
      const paneType = String(input.pane_type || 'task');
      const label = String(input.label || 'Pane');
      let resource: ResourceDescriptor | undefined;

      switch (paneType) {
        case 'pty':
          resource = { type: 'pty', uri: `pty://${PTY_WS_URL}` };
          break;
        case 'browser': {
          const url = String(input.url || '');
          resource = { type: 'browser', uri: `cdp://remote/tab/live${url ? '?' + encodeURIComponent(url) : ''}` };
          break;
        }
        case 'text':
          resource = {
            type: 'editor',
            uri: `content://${encodeURIComponent(String(input.content || ''))}`,
          };
          break;
        // 'task' — no resource, plain pane
      }

      const newTask = taskGraph.createTask(label, currentParentId ?? undefined, resource);
      flashPane(newTask.id);
      // Navigate browser pane to URL if provided
      if (paneType === 'browser' && input.url) {
        const bp = taskPaneMap.get(newTask.id);
        if (bp instanceof BrowserPane) {
          bp.browserTexture.navigate(String(input.url));
        }
      }
      console.log(`[cmd] create_pane: ${paneType} "${label}"`);
      break;
    }

    case 'remove_pane': {
      const label = String(input.label || '').toLowerCase();
      const tasks = currentParentId
        ? taskGraph.getChildren(currentParentId)
        : taskGraph.getRootTasks();
      const match = tasks.find(t => t.label.toLowerCase().includes(label));
      if (match) {
        taskGraph.completeAndDestroy(match.id);
        console.log(`[cmd] remove_pane: "${match.label}"`);
      } else {
        console.warn(`[cmd] remove_pane: no pane matching "${label}"`);
      }
      break;
    }

    case 'scroll_pane': {
      const label = String(input.label || '').toLowerCase();
      const direction = String(input.direction || 'down');
      const amount = String(input.amount || 'medium');

      // Find the text pane by label
      let targetPane: Pane | undefined;
      for (const [, pane] of taskPaneMap) {
        if (pane.label.toLowerCase().includes(label) && pane instanceof TextPane) {
          targetPane = pane;
          break;
        }
      }

      if (targetPane && targetPane instanceof TextPane) {
        const px = { small: 48, medium: 150, large: 300, top: -99999, bottom: 99999 }[amount] || 150;
        const dy = direction === 'up' ? -px : px;
        if (amount === 'top') targetPane.textTexture.scrollTo(0);
        else if (amount === 'bottom') targetPane.textTexture.scrollTo(targetPane.textTexture.maxScroll);
        else targetPane.scroll(dy);
        flashPane(targetPane.taskId);
        console.log(`[cmd] scroll_pane: "${targetPane.label}" ${direction} ${amount}`);
      } else {
        console.warn(`[cmd] scroll_pane: no text pane matching "${label}"`);
      }
      break;
    }

    case 'navigate_pane': {
      const label = String(input.label || '').toLowerCase();
      const url = String(input.url || '');
      for (const [, pane] of taskPaneMap) {
        if (pane.label.toLowerCase().includes(label) && pane instanceof BrowserPane) {
          pane.browserTexture.navigate(url);
          flashPane(pane.taskId);
          console.log(`[cmd] navigate_pane: "${pane.label}" → ${url}`);
          break;
        }
      }
      break;
    }

    case 'update_todo': {
      const content = String(input.content || '');
      // Find the Todo text pane and update it
      for (const [, pane] of taskPaneMap) {
        if (pane.label.toLowerCase().includes('todo') && pane instanceof TextPane) {
          pane.updateContent(content);
          flashPane(pane.taskId);
          console.log('[cmd] update_todo: refreshed pane');
          break;
        }
      }
      break;
    }

    default:
      console.warn(`[cmd] Unknown command: ${name}`);
  }
}

// --- Transcript ---

function appendTranscript(_line: string): void {
  // Transcript lives in the DOM overlay (transcriptEl), not a 3D pane.
  // The onTranscript/onResponse callbacks handle display.
}

// --- Browser demo ---

function runBrowserDemo(): void {
  const task = taskGraph.createTask('Browse', undefined, { type: 'browser', uri: 'cdp://remote/tab/live' });
  const bp = taskPaneMap.get(task.id);
  if (!(bp instanceof BrowserPane)) return;

  const sites = [
    'https://news.ycombinator.com',
    'https://en.wikipedia.org/wiki/WebGPU',
    'https://github.com/nicokoenig/threejs-blocks',
  ];

  // Navigate to first site once connected, then cycle
  let idx = 0;
  const next = () => {
    bp.browserTexture.navigate(sites[idx % sites.length]);
    flashPane(task.id);
    idx++;
  };

  // Wait for WS connection then start cycling
  setTimeout(next, 2000);
  setInterval(next, 8000);
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
    // Credentials come from server init message — set below in onInit
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
      if (isFinal && text) {
        appendTranscript(`You: ${text}`);
      }
    },
    onResponse(text) {
      console.log('[voice] Response:', text);
      if (text && transcriptEl) {
        transcriptEl.textContent = text;
        transcriptEl.style.opacity = '1';
        // Keep visible while speaking, fade handled by state change
      }
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
      handleCommand(cmd);
      appendTranscript(`  → ${cmd.name}`);
    },
    onInit(data) {
      // Apply voice credentials from server
      if (data.voiceCredentials) {
        voiceClient!.setCredentials(
          data.voiceCredentials.deepgramApiKey,
          data.voiceCredentials.elevenlabsApiKey,
        );
      }

      // Scene starts empty — panes created by agent via voice commands
    },
  });

  voiceClient.connect();

  // Don't auto-start — wait for user gesture (tap to start)
}

function updateVoiceStatusText(state: string): void {
  if (!statusEl) return;
  switch (state) {
    case 'idle':
      statusEl.style.opacity = '0';
      // Fade transcript after a pause
      if (transcriptEl) {
        setTimeout(() => {
          if (currentVoiceState === 'idle' && transcriptEl) transcriptEl.style.opacity = '0';
        }, 4000);
      }
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
