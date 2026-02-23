import * as THREE from 'three/webgpu';

/**
 * Minimal Text data holder — API-compatible with the subset of
 * @three-blocks/core Text used by renderer.ts.
 */
export class Text extends THREE.Object3D {
  text = '';
  fontSize = 1;
  color: THREE.Color = new THREE.Color(0xffffff);
}
