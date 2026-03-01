/**
 * Pane class hierarchy — each pane is a rectangular surface in the 3D scene
 * backed by a texture (terminal, browser, text, etc.).
 */

import * as THREE from 'three/webgpu';
import { PtyTexture } from './pty-texture';
import { BrowserTexture } from './browser-texture';
import { TextTexture } from './text-texture';
import { TerminalTexture } from './terminal-texture';
import type { Ghostty } from 'ghostty-web';

export const PANE_W = 48;
export const PANE_H = 24;

export const DEFAULT_BORDER_COLOR = 0x333355;

function makeBorder(): THREE.LineSegments {
  const hw = PANE_W / 2, hh = PANE_H / 2;
  const pts = [
    new THREE.Vector3(-hw, -hh, 0.05), new THREE.Vector3(hw, -hh, 0.05),
    new THREE.Vector3(hw, -hh, 0.05), new THREE.Vector3(hw, hh, 0.05),
    new THREE.Vector3(hw, hh, 0.05), new THREE.Vector3(-hw, hh, 0.05),
    new THREE.Vector3(-hw, hh, 0.05), new THREE.Vector3(-hw, -hh, 0.05),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicNodeMaterial({ color: DEFAULT_BORDER_COLOR });
  return new THREE.LineSegments(geo, mat);
}

// ---------------------------------------------------------------------------
// Abstract base
// ---------------------------------------------------------------------------

export abstract class Pane {
  readonly taskId: string;
  readonly label: string;
  readonly mesh: THREE.Mesh;
  readonly border: THREE.LineSegments;

  // Flash state for agent-presence border glow
  _flashColor: THREE.Color | null = null;
  _flashStart = 0;
  _flashDuration = 0;

  constructor(taskId: string, label: string, material: THREE.MeshBasicNodeMaterial) {
    this.taskId = taskId;
    this.label = label;

    const geo = new THREE.PlaneGeometry(PANE_W, PANE_H);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.userData.taskId = taskId;

    this.border = makeBorder();
  }

  /** Called every frame by the render loop. */
  abstract update(time: number): void;

  /** Clean up GPU resources. */
  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.border.geometry.dispose();
    (this.border.material as THREE.Material).dispose();
  }

  /** Set border color (focus, active, complete effects). */
  setBorderColor(color: number): void {
    (this.border.material as THREE.LineBasicNodeMaterial).color.set(color);
  }

  /**
   * Flash the border with a color that lerps back to DEFAULT_BORDER_COLOR.
   * Used as an agent-presence indicator when the LLM acts on a pane.
   */
  flash(color: number, durationMs: number): void {
    this._flashColor = new THREE.Color(color);
    this._flashStart = performance.now();
    this._flashDuration = durationMs;
    // Immediately set to flash color
    (this.border.material as THREE.LineBasicNodeMaterial).color.set(color);
  }

  /** Set opacity for focus dimming (0–1). */
  setOpacity(opacity: number): void {
    const mat = this.mesh.material as THREE.MeshBasicNodeMaterial;
    mat.transparent = opacity < 1;
    mat.opacity = opacity;
  }

  /** Position in world space (sets both mesh and border). */
  setPosition(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y, z);
    this.border.position.set(x, y, z);
  }
}

// ---------------------------------------------------------------------------
// PtyPane — remote shell via WebSocket
// ---------------------------------------------------------------------------

export class PtyPane extends Pane {
  readonly ptyTexture: PtyTexture;

  constructor(taskId: string, label: string, ghostty: Ghostty, wsUrl: string) {
    const tex = new PtyTexture(ghostty, wsUrl);
    super(taskId, label, new THREE.MeshBasicNodeMaterial({ map: tex.texture }));
    this.ptyTexture = tex;
  }

  update(time: number): void {
    this.ptyTexture.update(time);
  }

  dispose(): void {
    this.ptyTexture.dispose();
    super.dispose();
  }

  feed(data: string): void {
    this.ptyTexture.feed(data);
  }
}

// ---------------------------------------------------------------------------
// BrowserPane — live browser tab via CDP relay
// ---------------------------------------------------------------------------

export class BrowserPane extends Pane {
  readonly browserTexture: BrowserTexture;

  constructor(taskId: string, label: string, wsUrl: string) {
    const tex = new BrowserTexture({ wsUrl });
    super(taskId, label, new THREE.MeshBasicNodeMaterial({ map: tex.texture }));
    this.browserTexture = tex;
  }

  update(time: number): void {
    this.browserTexture.update(time);
  }

  dispose(): void {
    this.browserTexture.dispose();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// TextPane — scrollable text / markdown content
// ---------------------------------------------------------------------------

export class TextPane extends Pane {
  readonly textTexture: TextTexture;

  constructor(taskId: string, label: string, content: string) {
    const tex = new TextTexture({ content, title: label });
    super(taskId, label, new THREE.MeshBasicNodeMaterial({ map: tex.texture }));
    this.textTexture = tex;
  }

  update(time: number): void {
    this.textTexture.update(time);
  }

  dispose(): void {
    this.textTexture.dispose();
    super.dispose();
  }

  scroll(dy: number): void {
    this.textTexture.scroll(dy);
  }

  updateContent(content: string, autoScrollToBottom = false): void {
    this.textTexture.updateContent(content, autoScrollToBottom);
  }
}

// ---------------------------------------------------------------------------
// TerminalPane — local shell via Ghostty WASM
// ---------------------------------------------------------------------------

export class TerminalPane extends Pane {
  readonly terminalTexture: TerminalTexture;

  constructor(taskId: string, label: string, ghostty: Ghostty) {
    const tex = new TerminalTexture(ghostty);
    super(taskId, label, new THREE.MeshBasicNodeMaterial({ map: tex.texture }));
    this.terminalTexture = tex;
  }

  update(time: number): void {
    this.terminalTexture.update(time);
  }

  dispose(): void {
    this.terminalTexture.dispose();
    super.dispose();
  }

  feed(data: string): void {
    this.terminalTexture.feed(data);
  }
}

// ---------------------------------------------------------------------------
// PlainPane — solid color, no backing texture
// ---------------------------------------------------------------------------

export class PlainPane extends Pane {
  constructor(taskId: string, label: string, color: number = 0x1a1a2e) {
    super(taskId, label, new THREE.MeshBasicNodeMaterial({ color }));
  }

  update(_time: number): void { /* static */ }
}
