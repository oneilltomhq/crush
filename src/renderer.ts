import * as THREE from 'three/webgpu';
import { BatchedText, Text } from '@three-blocks/core';
import { Ghostty, DirtyState } from './ghostty/ghostty';
import type { GhosttyCell } from './ghostty/types';
import type { GhosttyTerminal } from './ghostty/ghostty';
import ghosttyWasmUrl from '../vendor/ghostty-web/ghostty-vt.wasm?url';

const COLS = 80;
const ROWS = 24;
const CELL_WIDTH = 0.6;
const CELL_HEIGHT = 1.0;

let renderer: THREE.WebGPURenderer;
let scene: THREE.Scene;
let camera: THREE.OrthographicCamera;
let batchedText: any = null;
let ghosttyTerm: GhosttyTerminal | null = null;
let textInstances: any[] = [];
let instanceIds: number[] = [];
const _cellColor = new THREE.Color();

export async function initTerminalRenderer(container: HTMLElement): Promise<void> {
  // --- Ghostty WASM ---
  const ghostty = await Ghostty.load(ghosttyWasmUrl);
  ghosttyTerm = ghostty.createTerminal(COLS, ROWS);

  // Write some test content
  ghosttyTerm.write('Welcome to \x1b[1;36mCrush\x1b[0m terminal\r\n');
  ghosttyTerm.write('Ghostty WASM + Three.js Blocks SDF rendering\r\n');
  ghosttyTerm.write('\r\n');
  ghosttyTerm.write('\x1b[32m$\x1b[0m echo "hello world"\r\n');
  ghosttyTerm.write('hello world\r\n');
  ghosttyTerm.write('\r\n');
  // Color test
  for (let i = 0; i < 8; i++) {
    ghosttyTerm.write(`\x1b[3${i}m█\x1b[0m`);
  }
  ghosttyTerm.write('\r\n');
  for (let i = 0; i < 8; i++) {
    ghosttyTerm.write(`\x1b[1;3${i}m█\x1b[0m`);
  }
  ghosttyTerm.write('\r\n');

  // --- Three.js WebGPU renderer ---
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();

  // Orthographic camera sized to terminal grid
  const gridW = COLS * CELL_WIDTH;
  const gridH = ROWS * CELL_HEIGHT;
  camera = new THREE.OrthographicCamera(0, gridW, 0, -gridH, 0.1, 100);
  camera.position.set(0, 0, 10);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);

  // --- BatchedText for SDF glyph rendering ---
  const totalCells = COLS * ROWS;
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  // Each cell is one Text instance with a single character
  // maxGlyphCount: 6 vertices per char × 1 char × totalCells
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

  // Initial render from WASM state
  updateFromGhostty();

  // Animation loop
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    const gridW = COLS * CELL_WIDTH;
    const gridH = ROWS * CELL_HEIGHT;
    camera.left = 0;
    camera.right = gridW;
    camera.top = 0;
    camera.bottom = -gridH;
    camera.updateProjectionMatrix();
  });
}

function updateFromGhostty(): void {
  if (!ghosttyTerm || !batchedText) return;

  const dirty = ghosttyTerm.update();
  if (dirty === DirtyState.NONE) return;

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
