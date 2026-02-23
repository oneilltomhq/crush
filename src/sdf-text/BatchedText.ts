import * as THREE from 'three/webgpu';
import {
  texture,
  uv,
  smoothstep,
  attribute,
  Fn,
  vec4,
  float,
  select,
} from 'three/tsl';
import { FontAtlas } from './FontAtlas';
import type { Text } from './Text';

/**
 * Drop-in replacement for @three-blocks/core BatchedText.
 *
 * Renders many single-character Text instances via GPU instancing
 * with an SDF font atlas.
 */
export class BatchedText extends THREE.InstancedMesh {
  private atlas: FontAtlas;
  private texts: (Text | null)[];
  private count_: number;

  // Per-instance buffers: glyph UV rect (vec4) and color (vec3)
  private glyphUVArray: Float32Array;
  private colorArray: Float32Array;
  private glyphUVAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;

  constructor(maxCount: number, _maxChars: number, _baseMaterial?: THREE.Material) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    super(plane, material, maxCount);

    this.atlas = new FontAtlas();
    this.texts = new Array(maxCount).fill(null);
    this.count_ = 0;

    // Allocate instance attribute arrays
    this.glyphUVArray = new Float32Array(maxCount * 4); // u, v, w, h per instance
    this.colorArray = new Float32Array(maxCount * 3);   // r, g, b per instance

    this.glyphUVAttr = new THREE.InstancedBufferAttribute(this.glyphUVArray, 4);
    this.glyphUVAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aGlyphUV', this.glyphUVAttr);

    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArray, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aColor', this.colorAttr);

    this.buildMaterial(material);
  }

  private buildMaterial(material: THREE.NodeMaterial): void {
    const sdfTex = texture(this.atlas.texture);
    const aGlyphUV = attribute('aGlyphUV', 'vec4');
    const aColor = attribute('aColor', 'vec3');

    // Map quad UV [0,1] into atlas UV for this glyph.
    // Flip V: canvas rasterizes top-to-bottom (row 0 = top) but
    // PlaneGeometry UV v=0 is bottom, so invert Y to match.
    const quadUV = uv();
    const atlasUV = vec4(
      aGlyphUV.x.add(quadUV.x.mul(aGlyphUV.z)),
      aGlyphUV.y.add(float(1).sub(quadUV.y).mul(aGlyphUV.w)),
      0,
      0,
    );

    const sdfValue = sdfTex.sample(atlasUV.xy).r;

    // Smoothstep anti-aliased edge
    const edge = float(0.5);
    const edgeWidth = float(0.1);
    const sdfAlpha = smoothstep(edge.sub(edgeWidth), edge.add(edgeWidth), sdfValue);

    // Zero-size UV rect means blank/space — force alpha to 0 so it doesn't
    // accidentally sample the glyph at atlas position (0,0).
    const isBlank = aGlyphUV.z.equal(float(0));
    const alpha = select(isBlank, float(0), sdfAlpha);

    material.colorNode = Fn(() => {
      return vec4(aColor, alpha);
    })();
  }

  addText(text: Text): number {
    const id = this.count_++;
    this.texts[id] = text;
    this.count = this.count_;

    // Set identity-ish instance matrix from Text's world matrix
    this.setMatrixAt(id, text.matrixWorld);

    // Set initial color
    const c = text.color;
    this.colorArray[id * 3] = c.r;
    this.colorArray[id * 3 + 1] = c.g;
    this.colorArray[id * 3 + 2] = c.b;

    return id;
  }

  setColorAt(id: number, color: THREE.Color): void {
    this.colorArray[id * 3] = color.r;
    this.colorArray[id * 3 + 1] = color.g;
    this.colorArray[id * 3 + 2] = color.b;
    this.colorAttr.needsUpdate = true;
  }

  sync(callback?: Function, _renderer?: THREE.WebGPURenderer): void {
    // Collect all unique characters and ensure they're in the atlas
    const chars = new Set<string>();
    for (let i = 0; i < this.count_; i++) {
      const t = this.texts[i];
      if (t && t.text && t.text !== ' ') {
        chars.add(t.text);
      }
    }
    this.atlas.ensureGlyphs(chars);

    // Update per-instance glyph UV and matrices
    for (let i = 0; i < this.count_; i++) {
      const t = this.texts[i];
      if (!t) continue;

      // Update matrix from Text position
      this.setMatrixAt(i, t.matrixWorld);

      // Update glyph UV
      if (t.text && t.text !== ' ') {
        const m = this.atlas.getGlyph(t.text);
        this.glyphUVArray[i * 4] = m.u;
        this.glyphUVArray[i * 4 + 1] = m.v;
        this.glyphUVArray[i * 4 + 2] = m.w;
        this.glyphUVArray[i * 4 + 3] = m.h;
      } else {
        // Blank — zero alpha via zero-size UV rect
        this.glyphUVArray[i * 4] = 0;
        this.glyphUVArray[i * 4 + 1] = 0;
        this.glyphUVArray[i * 4 + 2] = 0;
        this.glyphUVArray[i * 4 + 3] = 0;
      }
    }

    this.glyphUVAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    if (this.instanceMatrix) this.instanceMatrix.needsUpdate = true;

    if (callback) callback();
  }
}
