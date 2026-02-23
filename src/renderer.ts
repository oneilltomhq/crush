import * as THREE from 'three/webgpu';
import { BatchedText, Text } from './sdf-text';
import { Ghostty } from 'ghostty-web';
import type { GhosttyTerminal } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';

const COLS = 80;
const ROWS = 24;
const CELL_WIDTH = 0.6;
const CELL_HEIGHT = 1.0;

let renderer: THREE.WebGPURenderer;
let scene: THREE.Scene;
let camera: THREE.OrthographicCamera;
let batchedText: any = null;
let ghosttyInstance: Ghostty | null = null;
let ghosttyTerm: GhosttyTerminal | null = null;
let textInstances: any[] = [];
let instanceIds: number[] = [];
const _cellColor = new THREE.Color();

// Cursor state
let cursorMesh: THREE.Mesh | null = null;
let cursorVisible = true;
let cursorBlinkTime = 0;
const CURSOR_BLINK_RATE = 530; // ms

export interface TerminalRendererHandle {
  ghostty: Ghostty;
  term: GhosttyTerminal;
  container: HTMLElement;
}

export async function initTerminalRenderer(container: HTMLElement): Promise<TerminalRendererHandle> {
  // --- Ghostty WASM ---
  ghosttyInstance = await Ghostty.load(ghosttyWasmUrl);
  ghosttyTerm = ghosttyInstance.createTerminal(COLS, ROWS);

  // --- Three.js WebGPU renderer ---
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();

  // Orthographic camera — fit terminal grid into container
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10);
  fitCameraToGrid(container);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);

  // --- Cursor (simple block behind text) ---
  const cursorGeo = new THREE.PlaneGeometry(CELL_WIDTH, CELL_HEIGHT);
  const cursorMat = new THREE.MeshBasicNodeMaterial({
    color: 0xcccccc,
    transparent: true,
    opacity: 0.7,
  });
  cursorMesh = new THREE.Mesh(cursorGeo, cursorMat);
  cursorMesh.position.set(0, 0, 1); // z=1 behind text at z=0 (both in front of camera)
  scene.add(cursorMesh);

  // --- BatchedText for SDF glyph rendering ---
  const totalCells = COLS * ROWS;
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  batchedText = new BatchedText(totalCells, totalCells * 6, material);
  batchedText.matrixAutoUpdate = false;

  // Pre-create Text instances for every cell
  textInstances = new Array(totalCells);
  instanceIds = new Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const t = new Text();
    t.text = ' ';
    t.fontSize = 0.8;
    (t as any).position.set(col * CELL_WIDTH, -(row * CELL_HEIGHT), 0);
    (t as any).updateMatrixWorld();
    textInstances[i] = t;
    instanceIds[i] = batchedText.addText(t);
  }

  scene.add(batchedText);

  await new Promise<void>((resolve) => {
    batchedText.sync(() => resolve(), renderer);
  });

  // Animation loop — update terminal state + render every frame
  renderer.setAnimationLoop((time: number) => {
    updateFromGhostty();
    updateCursor(time);
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    fitCameraToGrid(container);
  });

  return { ghostty: ghosttyInstance, term: ghosttyTerm, container };
}

function fitCameraToGrid(container: HTMLElement): void {
  // Cells are centered on their position, so the grid extends half a cell
  // beyond the first/last column and row.
  const gridL = -CELL_WIDTH / 2;
  const gridR = COLS * CELL_WIDTH - CELL_WIDTH / 2;
  const gridT = CELL_HEIGHT / 2;
  const gridB = -(ROWS * CELL_HEIGHT - CELL_HEIGHT / 2);
  const gridW = gridR - gridL;
  const gridH = gridT - gridB;
  const aspect = container.clientWidth / container.clientHeight;
  const gridAspect = gridW / gridH;

  if (aspect > gridAspect) {
    // Container is wider than grid — fit height, expand width
    camera.top = gridT;
    camera.bottom = gridB;
    const extra = gridH * aspect - gridW;
    camera.left = gridL - extra / 2;
    camera.right = gridR + extra / 2;
  } else {
    // Container is taller than grid — fit width, expand height
    camera.left = gridL;
    camera.right = gridR;
    const extra = gridW / aspect - gridH;
    camera.top = gridT + extra / 2;
    camera.bottom = gridB - extra / 2;
  }
  camera.updateProjectionMatrix();
}

function updateFromGhostty(): void {
  if (!ghosttyTerm || !batchedText) return;

  const dirty = ghosttyTerm.update();
  if (dirty === 0 /* DirtyState.NONE */) return;

  const cells = ghosttyTerm.getViewport();

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const textInst = textInstances[i];
    if (!textInst) continue;

    const cp = cell.codepoint;
    const ch = cp > 0x20 ? String.fromCodePoint(cp) : ' ';

    textInst.text = ch;
    _cellColor.setRGB(cell.fg_r / 255, cell.fg_g / 255, cell.fg_b / 255);
    batchedText.setColorAt(instanceIds[i], _cellColor);
  }

  batchedText.sync(undefined, renderer);
  ghosttyTerm.markClean();
}

function updateCursor(time: number): void {
  if (!ghosttyTerm || !cursorMesh) return;

  const cursor = ghosttyTerm.getCursor();

  // Blink
  if (cursor.visible) {
    const blinkPhase = Math.floor(time / CURSOR_BLINK_RATE) % 2;
    cursorVisible = blinkPhase === 0;
  } else {
    cursorVisible = false;
  }

  cursorMesh.visible = cursorVisible;

  if (cursorVisible) {
    // Position cursor block: center of the cell
    cursorMesh.position.set(
      cursor.x * CELL_WIDTH + CELL_WIDTH / 2,
      -(cursor.y * CELL_HEIGHT) - CELL_HEIGHT / 2,
      1,
    );
  }
}
