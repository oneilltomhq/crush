# SDF Text System — Clean-Room Specification

> This document specifies the SDF (Signed Distance Field) text rendering subsystem
> as observed from the public API surface of `@three-blocks/core`. It is written as a
> clean-room specification: it describes *what* the system does and *what contracts
> it exposes*, not how any particular implementation achieves them.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Concepts](#2-concepts)
3. [Module Map](#3-module-map)
4. [Text — Single-Instance SDF Text](#4-text--single-instance-sdf-text)
5. [BatchedText — High-Performance Multi-Instance Text](#5-batchedtext--high-performance-multi-instance-text)
6. [TSL Shader Nodes](#6-tsl-shader-nodes)
   - 6.1 [TextNode / text()](#61-textnode--text)
   - 6.2 [TextColorNode / textColor()](#62-textcolornode--textcolor)
   - 6.3 [BatchedTextNode / batchedText()](#63-batchedtextnode--batchedtext)
   - 6.4 [BatchedTextColorNode / batchedTextColor()](#64-batchedtextcolornode--batchedtextcolor)
   - 6.5 [textGlyphTransform()](#65-textglyphtransform)
   - 6.6 [TSL Accessor Nodes (TextNodes)](#66-tsl-accessor-nodes-textnodes)
7. [Text Infrastructure](#7-text-infrastructure)
   - 7.1 [TextBuilder / getTextRenderInfo()](#71-textbuilder--gettextrenderinfo)
   - 7.2 [FontManager](#72-fontmanager)
   - 7.3 [SDFGenerator](#73-sdfgenerator)
8. [3D SDF Volume Pipeline](#8-3d-sdf-volume-pipeline)
   - 8.1 [ComputeSDFGenerator](#81-computesdfgenerator)
   - 8.2 [ComputePointsSDFGenerator](#82-computepointsdfgenerator)
   - 8.3 [SDFSamplingFunctions (TSL)](#83-sdfsamplingfunctions-tsl)
   - 8.4 [SDFVolumeConstraint](#84-sdfvolumeconstraint)
   - 8.5 [SDF Visualization Materials](#85-sdf-visualization-materials)
   - 8.6 [SDFVolumeHelpers](#86-sdfvolumehelpers)
9. [GPU Culling & LOD (ComputeInstanceCulling)](#9-gpu-culling--lod-computeinstanceculling)
10. [Data Flow Diagrams](#10-data-flow-diagrams)
11. [Backend Compatibility Matrix](#11-backend-compatibility-matrix)

---

## 1. Overview

The system provides two tiers of SDF-based functionality:

| Tier | Purpose | Key Classes |
|------|---------|-------------|
| **SDF Text Rendering** | Render crisp vector text at any scale using 2D multi-channel SDF atlas textures | `Text`, `BatchedText`, TSL nodes |
| **SDF Volume Pipeline** | Generate, sample, visualize, and constrain against 3D SDF volumes from meshes/point clouds | `ComputeSDFGenerator`, `ComputePointsSDFGenerator`, `SDFVolumeConstraint`, visualization materials |

Both tiers are built on Three.js's TSL (Three Shading Language) node material system and
target WebGPU as the primary backend, with WebGL fallback for the text rendering tier.

---

## 2. Concepts

### 2.1 Signed Distance Field (SDF)

A scalar field where each texel stores the signed distance to the nearest edge of a
glyph path (2D text) or mesh surface (3D volume). Negative values are inside the
shape; positive values are outside. The boundary (distance = 0) defines the shape
contour.

### 2.2 SDF Atlas

A shared 2D texture that packs many individual glyph SDF tiles into a grid. Each tile
is `sdfGlyphSize × sdfGlyphSize` texels. The atlas is multi-channel (up to 4 glyphs
per texel via RGBA channels), allowing up to `4 × (textureWidth / sdfGlyphSize)²`
glyphs.

### 2.3 SDF Exponent Encoding

Distance values are encoded non-linearly using an exponent (`sdfExponent`, default 9).
Higher exponents allocate more precision to texels near the glyph contour at the
expense of far-field precision. This follows Valve's 2007 alpha-tested magnification
technique.

### 2.4 Sync Lifecycle

Text layout and SDF generation are asynchronous. A `sync()` call initiates:
1. Font loading and parsing
2. Glyph layout (typesetting)
3. SDF generation for new glyphs (GPU-accelerated when available)
4. Atlas packing
5. Geometry and buffer updates

Events `syncstart` and `synccomplete` bracket this process.

---

## 3. Module Map

```
@three-blocks/core
├── Text/
│   ├── Text                    # Single SDF text mesh
│   ├── BatchedText             # Batched multi-instance SDF text
│   ├── TextNode / text()       # Vertex shader node (single)
│   ├── TextColorNode / textColor()   # Fragment shader node (single)
│   ├── BatchedTextNode / batchedText()       # Vertex shader node (batched)
│   ├── BatchedTextColorNode / batchedTextColor()  # Fragment shader node (batched)
│   ├── TextGlyphTransformNode / textGlyphTransform()  # Shared glyph transform core
│   └── TextNodes               # TSL accessor varyings (letterId, drawId, UV, etc.)
├── extras/
│   ├── TextBuilder             # Async text layout + SDF atlas management
│   ├── FontManager             # Low-level canvas-based font atlas
│   └── SDFGenerator            # GPU/CPU SDF rasterizer bridge
├── Compute/
│   ├── ComputeSDFGenerator     # 3D SDF from mesh + BVH
│   ├── ComputePointsSDFGenerator  # 3D SDF from point cloud + PointsBVH
│   ├── ComputeInstanceCulling  # GPU frustum/LOD culling (used by BatchedText)
│   ├── SDFVolumeHelpers        # Debug visualization utilities
│   └── LODConstants            # LOD_MODE_DISABLED, LOD_MODE_RANGE, LOD_MODE_EXP
├── TSL/
│   └── SDFSamplingFunctions    # Trilinear sample, gradient, coord transforms
├── Materials/
│   ├── RayMarchSDFNodeMaterial      # Volumetric SDF sphere-tracing material
│   └── RenderSDFLayerNodeMaterial   # 2D slice visualization material
└── Simulation/
    └── SDFVolumeConstraint     # Particle boundary enforcement via SDF
```

---

## 4. Text — Single-Instance SDF Text

### Class: `Text` (extends `THREE.Mesh`)

A mesh that renders a string of text using an SDF atlas. It manages its own geometry
(a quad-per-glyph buffer) and material (a `NodeMaterial` configured with TSL nodes).

#### Construction

```ts
const text = new Text();
```

No constructor arguments. All configuration is via properties.

#### Text Content & Layout Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `text` | `string` | `""` | The text string to render. |
| `fontSize` | `number` | — | Font size in local units. |
| `fontWeight` | `string` | — | CSS-style font weight (e.g., `"bold"`). |
| `fontStyle` | `string` | — | CSS-style font style (e.g., `"italic"`). |
| `lang` | `any` | — | Language hint for shaping/BiDi. |
| `direction` | `string` | — | Text direction (`"ltr"`, `"rtl"`, `"auto"`). |
| `letterSpacing` | `number` | `0` | Extra spacing between glyphs. |
| `lineHeight` | `string` | — | Line height (CSS-style, e.g., `"normal"`, `"1.5"`). |
| `maxWidth` | `number` | — | Maximum line width before wrapping (local units). |
| `overflowWrap` | `string` | — | Word-break behavior (`"normal"`, `"break-word"`). |
| `textAlign` | `string` | — | Horizontal alignment (`"left"`, `"center"`, `"right"`, `"justify"`). |
| `textIndent` | `number` | `0` | First-line indent in local units. |
| `whiteSpace` | `string` | — | Whitespace handling (`"normal"`, `"nowrap"`, `"pre-wrap"`). |
| `anchorX` | `number` | — | Horizontal anchor position. Accepts `"left"`, `"center"`, `"right"`, or a numeric value. |
| `anchorY` | `number` | — | Vertical anchor position. Accepts `"top"`, `"middle"`, `"bottom"`, or a numeric value. |
| `unicodeFontsURL` | `any` | — | Custom URL for unicode-font-resolver data/fonts. |

#### Visual Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `color` | `any` | — | Fill color (hex, CSS string, or `THREE.Color`). |
| `fillOpacity` | `number` | — | Fill alpha (0–1). |
| `outlineWidth` | `number` | `0` | Outline thickness. Accepts number (local units) or `"N%"` (percentage of fontSize). |
| `outlineColor` | `number` | — | Outline color (hex). |
| `outlineOpacity` | `number` | — | Outline alpha (0–1). |
| `outlineBlur` | `number` | `0` | Outline blur radius. |
| `outlineOffsetX` | `number` | `0` | Outline horizontal offset. |
| `outlineOffsetY` | `number` | `0` | Outline vertical offset. |
| `colorRanges` | `any` | — | Per-character color overrides (Map or object keyed by character index). |
| `depthOffset` | `number` | — | Depth bias to prevent z-fighting. |
| `clipRect` | `any` | — | `[minX, minY, maxX, maxY]` clipping rectangle in local space. |
| `orientation` | `string` | — | Orientation mode. |

#### Rendering Modes

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `billboarding` | `boolean` | `false` | Y-axis billboarding (text faces camera while remaining upright). |
| `screenSpace` | `boolean` | `false` | Screen-space rendering via NDC coordinates. Position maps to viewport pixels. |

#### SDF Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `sdfGlyphSize` | `any` | — | Override per-instance glyph SDF resolution (power of 2). |
| `gpuAccelerateSDF` | `boolean` | — | Use GPU-accelerated SDF generation via WebGL canvas. |
| `glyphGeometryDetail` | `number` | — | Tessellation level (1–3) for glyph quads. |
| `debugSDF` | `boolean` | `false` | Render raw SDF values for debugging. |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `sync` | `(callback?: Function, renderer?: WebGPURenderer) => void` | Trigger async glyph layout and SDF atlas generation. Called automatically before render if properties changed. |
| `onBeforeRender` | `(renderer, scene, camera, geometry, material) => void` | Pre-render hook; ensures sync and material configuration. |
| `onAfterRender` | `(renderer, scene, camera, geometry, material) => void` | Post-render hook; restores material side. |
| `dispose` | `() => void` | Release geometry resources. |
| `localPositionToTextCoords` | `(position, target?) => any` | Convert local 3D position to text-block coordinates. |
| `worldPositionToTextCoords` | `(position, target?) => any` | Convert world 3D position to text-block coordinates. |
| `raycast` | `(raycaster, intersects) => void` | Standard Three.js raycast override. |
| `copy` | `(source) => this` | Copy properties from another Text. |
| `clone` | `() => Text` | Deep clone. |

#### Read-Only Properties

| Property | Type | Description |
|----------|------|-------------|
| `textRenderInfo` | `object \| null` | Computed layout and SDF atlas info after sync. See `ThreeBlocksTextRenderInfo`. |
| `sdfMap` | `any` | The SDF atlas texture currently in use. |
| `material` | `any` | The auto-configured `NodeMaterial`. |

#### Events

| Event | Description |
|-------|-------------|
| `syncstart` | Emitted when layout/atlas generation begins. |
| `synccomplete` | Emitted when geometry and material are ready. |

#### Uniforms (Internal)

The following uniforms are exposed on `text.uniforms` for advanced TSL usage:

- `uThreeBlocksSdfDebug` — Debug mode flag
- `uThreeBlocksSDFTextureSize` — Atlas texture dimensions (`vec2`)
- `uThreeBlocksSDFGlyphSize` — Glyph tile size (`float`)
- `uThreeBlocksSDFExponent` — SDF encoding exponent (`float`)
- `uThreeBlocksTotalBounds` — Text block bounds (`vec4`: minX, minY, maxX, maxY)
- `uThreeBlocksClipRect` — Clip rectangle (`vec4`)
- `uThreeBlocksDistanceOffset` — Outline distance offset (`float`)
- `uThreeBlocksOutlineOpacity` — Outline alpha (`float`)
- `uThreeBlocksFillOpacity` — Fill alpha (`float`)
- `uThreeBlocksBaseColor` — Fill color (`vec3`)
- `uThreeBlocksOutlineColor` — Outline color (`vec3`)
- `uThreeBlocksPositionOffset` — Position offset (`vec2`)
- `uThreeBlocksBlurRadius` — Blur radius (`float`)
- `uThreeBlocksOrient` — Orientation flag
- `uThreeBlocksBillboard` — Billboarding flag

---

## 5. BatchedText — High-Performance Multi-Instance Text

### Class: `BatchedText` (extends `Text`)

Renders thousands of `Text` instances in a single draw call using GPU instancing,
a shared SDF atlas, and optional GPU compute for culling, LOD, and transparency sorting.

#### Construction

```ts
const batch = new BatchedText(maxTextCount?: number, maxGlyphCount?: number, material?: Material);
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTextCount` | `number` | `Infinity` | Pre-allocated capacity for text instances. Enables dynamic `addText()`. |
| `maxGlyphCount` | `number` | `Infinity` | Pre-allocated total glyph capacity across all members. |
| `material` | `Material` | auto | Base material; a default `NodeMaterial` is created if omitted. |

#### Member Management

| Method | Signature | Description |
|--------|-----------|-------------|
| `addText` | `(text: Text) => number` | Register a Text as a batched member. Returns instance ID, or `-1` if capacity exceeded. |
| `removeText` | `(text: Text) => void` | Unregister a Text member. |
| `getTextAt` | `(instanceId: number) => Text \| null` | Retrieve the Text at a given instance ID. |
| `add` | `(...objs: Object3D[]) => this` | Overrides `Object3D.add`. Text instances are batched; non-Text objects added normally. |
| `remove` | `(...objs: Object3D[]) => this` | Overrides `Object3D.remove`. |

#### Transform & Style

| Method | Signature | Description |
|--------|-----------|-------------|
| `setMatrixAt` | `(id: number, matrix: Matrix4) => BatchedText` | Set instance local transform matrix. |
| `getMatrixAt` | `(id: number, matrix: Matrix4) => Matrix4` | Get instance local transform matrix. |
| `setColorAt` | `(id: number, color: Color\|number\|string) => BatchedText` | Set per-instance color. |
| `getColorAt` | `(id: number, color: Color) => Color` | Get per-instance color. |
| `setGlyphAt` | `(id: number, glyph: {atlasIndex?, bounds?, letterIndex?}) => this` | Fast glyph data update without full sync. |
| `getGlyphAt` | `(id: number, target?) => {atlasIndex, bounds, letterIndex} \| null` | Read glyph data for an instance. |
| `updateMemberMatrixWorld` | `(text: Text) => void` | Update a single member's matrix in the storage buffer. |

#### Sync

```ts
batch.sync(callback?: () => void, renderer: WebGPURenderer): void;
```

Synchronizes all member `Text` instances. Triggers repacking of instance attributes
when any member has changed. The `renderer` is **required on first call** to detect
the WebGPU/WebGL backend.

**Important:** `sync()` handles *content* changes only. Position/transform changes
require `setMatrixAt()`.

#### Culling & LOD (WebGPU Only)

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `perObjectFrustumCulled` | `boolean` | Enable/disable GPU frustum culling. Auto-disabled on WebGL. |
| `perTextBoundingBox` | `boolean` | Per-instance bounding spheres (more accurate culling) vs. shared max sphere (faster). Default `false`. |
| `staticMode` | `boolean` | Lock layout after initial pack for maximum performance. |
| `initCuller` | `(renderer) => ComputeInstanceCulling \| null` | Initialize GPU culler before first render. |
| `culler` | `ComputeInstanceCulling` | The GPU culler instance (available after init). |

#### Culling Options (`_cullOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sortObjects` | `boolean` | — | Enable back-to-front transparency sorting. |
| `useFrustum` | `boolean` | — | Enable frustum culling. |
| `lodNear` | `number` | — | Distance where LOD begins. |
| `lodFar` | `number` | — | Distance where range-mode LOD reaches full falloff. |
| `lodMode` | `number` | — | `LOD_MODE_DISABLED`, `LOD_MODE_RANGE`, or `LOD_MODE_EXP`. |
| `lodDensity` | `number` | — | Exponential density parameter for `LOD_MODE_EXP`. |
| `frustumPadXY` | `number` | — | XY padding for frustum tests. |
| `frustumPadZNear` | `number` | — | Near-plane padding. |
| `frustumPadZFar` | `number` | — | Far-plane padding. |

#### LOD Modes

| Constant | Value | Formula |
|----------|-------|---------|
| `LOD_MODE_DISABLED` | 0 | No LOD sampling. |
| `LOD_MODE_RANGE` | 1 | `pKeep = 1 - smoothstep(lodNear, lodFar, d)` |
| `LOD_MODE_EXP` | 2 | `pKeep = exp(-density² × (d - lodNear)²)` |

Instances are stochastically thinned: kept if `hash(instanceId) < pKeep`.

#### Read-Only Properties

| Property | Type | Description |
|----------|------|-------------|
| `count` | `number` | Number of batched members (read-only). |
| `isWebGL` | `boolean \| null` | `true` if WebGL backend, `null` if not yet detected. |
| `isCullingActive` | `boolean` | `true` if GPU culling is running. |

#### Bounding Volumes

| Method | Signature | Description |
|--------|-----------|-------------|
| `updateBounds` | `() => void` | Recompute aggregate bounding volumes from all members. |
| `getTextBoundingSphereAt` | `(id: number) => {center: Vector3, radius: number} \| null` | Get local-space bounding sphere for an instance. |

#### GPU Compute Pipeline (WebGPU)

The batched renderer's GPU pipeline performs the following per frame:

1. **Frustum Culling** — Test each member's bounding sphere against camera frustum planes.
2. **LOD Sampling** — Stochastically reject distant members based on LOD mode.
3. **Visibility Buffer** — Write per-member visibility flags to an SSBO.
4. **Glyph Packing** — Prefix-sum over visible members' glyph counts → scatter visible glyphs into a packed buffer preserving back-to-front order.
5. **Transparency Sorting** — Bitonic sort of glyph draw keys for correct z-ordering.
6. **Indirect Draw** — Write `instanceCount` to indirect draw args; no CPU readback.

#### GUI Integration

```ts
batch.attachGUI(folder: object): void;  // lil-gui / dat.gui compatible
batch.disposeGUI(): void;
```

---

## 6. TSL Shader Nodes

All shader nodes integrate with Three.js's TSL `NodeMaterial` system and participate
in the standard `setupVertex` / `setupDiffuseColor` extension points.

### 6.1 TextNode / `text()`

**Factory:** `text(textInstance: Text) => Fn<vec3>`

Vertex shader node for single `Text` instances. Reads glyph bounds and atlas indices
from buffer attributes, delegates to `textGlyphTransform()` with uniform-based
parameters, and outputs the transformed `positionLocal`.

**Material integration point:** `material.setupVertex`

### 6.2 TextColorNode / `textColor()`

**Factory:** `textColor(textInstance: Text, baseDiffuse?: Node<vec4>) => TextColorNode`

Fragment shader node for single `Text` instances. Samples the SDF atlas texture at
the current fragment's atlas UV, computes signed distance, and produces:

- **Fill color + alpha** from `baseColor` and `fillOpacity`
- **Outline color + alpha** from `outlineColor`, `outlineOpacity`, and `outlineWidth`
- **Composited RGBA** with anti-aliased alpha from the SDF gradient

**Material integration point:** `material.setupDiffuseColor` — override `diffuseColor`
with the SDF-computed result.

### 6.3 BatchedTextNode / `batchedText()`

**Factory:** `batchedText(batch: BatchedText, uBillboard: UniformNode) => Fn<vec3>`

Vertex shader node for `BatchedText`. Extends the single-text transform with:

1. Per-member parameter reads from `StorageBufferAttribute` SSBOs
2. Per-member matrix multiplication
3. Billboarding transform
4. Glyph packing indirection (when GPU culling is active)

### 6.4 BatchedTextColorNode / `batchedTextColor()`

**Factory:** `batchedTextColor(batch: BatchedText, baseDiffuse?: Node<vec4>) => BatchedTextColorNode`

Fragment shader node for `BatchedText`. Same SDF sampling logic as `TextColorNode`,
but reads per-member colors and style parameters from storage buffers and applies
visibility masking from the GPU culler's output SSBO.

### 6.5 `textGlyphTransform()`

**Signature:**
```ts
textGlyphTransform({
  glyphBounds:    ShaderNode,  // vec4(minX, minY, maxX, maxY)
  atlasIndex:     ShaderNode,  // float
  letterId:       ShaderNode,  // float
  wordId:         ShaderNode,  // float (0 for single Text, member index for batched)
  clipRect:       ShaderNode,  // vec4(minX, minY, maxX, maxY)
  posOffset:      ShaderNode,  // vec2(offsetX, offsetY)
  distanceOffset: ShaderNode,  // float (outline distance)
  blurRadius:     ShaderNode,  // float
  totalBounds:    ShaderNode,  // vec4(minX, minY, maxX, maxY)
  sdfTextureSize: ShaderNode,  // vec2(width, height)
  sdfGlyphSize:   ShaderNode,  // float
}) => Fn  // returns vec3 position
```

Core shared glyph transformation logic used by both `TextNode` and `BatchedTextNode`.
Computes:

1. **Clipped glyph position** in local space (applies `clipRect`)
2. **Atlas UV coordinates** for SDF texture lookup
3. **Glyph dimensions** and **texture channel** index

Sets up the following **varyings** for fragment shader consumption:

| Varying | Type | Contents |
|---------|------|----------|
| `vTextPacked0` | `vec4` | `(textUV.x, textUV.y, glyphUV.x, glyphUV.y)` |
| `vTextPacked1` | `vec4` | `(glyphWidth, glyphHeight, texChannel, letterId)` |
| `vTextTextureUVBounds` | `vec4` | `(atlasStartU, atlasStartV, atlasEndU, atlasEndV)` |
| `vTextWordId` | `float` | Member/word index |

### 6.6 TSL Accessor Nodes (TextNodes)

These are pre-built TSL node references that extract values from the varyings set up
by the vertex nodes. They work in both vertex and fragment stages.

| Export | Type | Description |
|--------|------|-------------|
| `textLetterId` | `Node<float>` | Normalized (0–1) letter position within the text. First letter = 0, last = 1. Per-member for BatchedText. |
| `textDrawId` | `Node<float>` | Member index within a batch (always 0 for single Text). |
| `textGlyphUV` | `Node<vec2>` | UV coordinates within the current glyph's bounding box (0–1). |
| `textGlyphDimensions` | `Node<vec2>` | Glyph width and height in local units. |
| `textUV` | `Node<vec2>` | UV coordinates across the entire text block (0–1). |
| `textNdc` | `Node<vec3>` | NDC position (screen-space mode only). Private. |
| `textTextureChannel` | `Node<float>` | RGBA channel index (0–3) for the current glyph in the atlas. Internal. |
| `textTextureUVBounds` | `Node<vec4>` | Atlas UV bounds for the current glyph. Internal. |

---

## 7. Text Infrastructure

### 7.1 TextBuilder / `getTextRenderInfo()`

The central async entry point for text layout and SDF atlas management.

#### `configureTextBuilder(config)`

Global one-time configuration. Must be called before any text processing.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultFontURL` | `string` | Google Fonts Roboto Regular | Default font URL. |
| `unicodeFontsURL` | `string` | CDN | Custom unicode-font-resolver location. |
| `sdfGlyphSize` | `number` | `64` | Default glyph SDF tile size (power of 2). |
| `sdfExponent` | `number` | `9` | SDF value encoding exponent. |
| `sdfMargin` | `number` | `1/16 × sdfGlyphSize` | SDF margin outside glyph path (percentage of SDF width). |
| `textureWidth` | `number` | `2048` | Atlas texture width (power of 2). At 64² glyphs × 4 channels = 4096 glyph capacity. |
| `useWorker` | `boolean` | `true` | Run typesetting in a Web Worker. |

#### `getTextRenderInfo(isWebGPU, args, callback)`

Asynchronous. Performs typesetting + SDF generation and returns a `ThreeBlocksTextRenderInfo`:

| Field | Type | Description |
|-------|------|-------------|
| `parameters` | `TypesetParams` | Normalized input arguments. |
| `sdfTexture` | `Texture` | The shared SDF atlas texture. |
| `sdfGlyphSize` | `number` | Glyph tile size. |
| `sdfExponent` | `number` | Encoding exponent. |
| `glyphBounds` | `Float32Array` | `[minX, minY, maxX, maxY]` per glyph. |
| `glyphAtlasIndices` | `Float32Array` | Atlas index per glyph. |
| `glyphColors` | `Uint8Array?` | `[r, g, b]` per glyph if `colorRanges` supplied. |
| `caretPositions` | `Float32Array?` | `[startX, endX, bottomY, topY]` per character. |
| `caretHeight` | `number?` | Uniform caret height. |
| `ascender` | `number` | Font ascender metric. |
| `descender` | `number` | Font descender metric. |
| `capHeight` | `number` | Capital letter height. |
| `xHeight` | `number` | Lowercase letter height. |
| `lineHeight` | `number` | Computed line height. |
| `topBaseline` | `number` | Y position of the first line's baseline. |
| `blockBounds` | `number[4]` | CSS-style block bounds `[minX, minY, maxX, maxY]`. |
| `visibleBounds` | `number[4]` | Tight bounds around visible glyphs. |
| `chunkedBounds` | `object[]` | Sub-ranges: `{start, end, rect}`. |
| `timings` | `object` | Performance timing breakdown. |

#### `preloadFont(options, callback)`

Pre-load a font and optionally pre-generate glyph SDFs to avoid first-render stalls.

```ts
preloadFont({
  font: string,            // Font URL (default font if omitted)
  characters: string | string[],  // Characters to pre-rasterize
  sdfGlyphSize: number     // SDF resolution for pre-rasterized glyphs
}, callback: Function): void;
```

#### `getAtlasesInfo()`

Returns lightweight atlas metrics for monitoring:

```ts
Array<{
  sdfGlyphSize: number,
  glyphCount: number,
  width: number,
  height: number,
  bytes: number
}>
```

#### `dumpSDFTextures()`

Debug utility to dump SDF atlas textures (heavy operation).

### 7.2 FontManager

Low-level class managing text layout and a canvas-based SDF font atlas. Wraps the
browser's `Canvas2D` text rendering API to extract glyph metrics and generate SDF
data.

```ts
class FontManager {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  fontSize: number;
  width: number;
  height: number;
  glyphs: Map<string, GlyphInfo>;
  texture: any;
  version: number;

  getGlyphInfo(char): {
    char, data: Uint8ClampedArray,
    width, height,
    glyphWidth, glyphHeight,
    glyphTop, glyphLeft,
    glyphAdvance
  };

  initCanvas(): void;           // Initialize rendering canvas
  update(chars): void;          // Update atlas with new characters
  getLayoutInfo(text?): {       // Compute text layout
    glyphs: any[],
    width: number,
    height: number
  };
}
```

### 7.3 SDFGenerator

Bridge to `webgl-sdf-generator` for GPU-accelerated SDF generation of individual
glyph paths.

```ts
generateSDF(
  width, height,        // Output SDF dimensions
  path,                 // Glyph outline path
  viewBox,              // Path viewBox
  distance,             // Max distance to encode
  exponent,             // Non-linear encoding exponent
  canvas,               // Target WebGL canvas
  x, y,                 // Position in atlas
  channel,              // RGBA channel (0-3)
  useWebGL?: boolean    // GPU acceleration flag
): any;

warmUpSDFCanvas(canvas): void;                 // Pre-initialize WebGL context
resizeWebGLCanvasWithoutClearing: any;         // Resize without clearing
```

---

## 8. 3D SDF Volume Pipeline

This subsystem generates 3D signed distance fields from geometry (not text-specific)
and provides utilities for sampling, visualizing, and using them in simulations.

### 8.1 ComputeSDFGenerator

GPU-accelerated 3D SDF generation from a mesh using a BVH (Bounding Volume Hierarchy)
for `O(log N)` closest-point queries. WebGPU only.

#### Construction

```ts
new ComputeSDFGenerator({
  resolution?: number,        // Default 64 — grid is resolution³ voxels
  margin?: number,            // Default 0.2 — extra padding around mesh bounds
  threshold?: number,         // Default 0.0 — distance bias
  bounds?: Box3,              // Custom bounds (auto-computed if omitted)
  workgroupSize?: Vector3     // Default (4,4,4) — compute workgroup dimensions
});
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `generate` | `(geometry, bvh, renderer) => Promise<Storage3DTexture>` | Full SDF generation. |
| `update` | `(geometry, bvh, renderer) => Promise<Storage3DTexture>` | Incremental update (reuses structure). |
| `dispose` | `() => void` | Free GPU resources. |

#### Read-Only Properties

| Property | Type | Description |
|----------|------|-------------|
| `sdfTexture` | `Storage3DTexture \| null` | The generated 3D SDF texture. |
| `boundsMatrix` | `Matrix4` | Local → world transform for the SDF volume. |
| `inverseBoundsMatrix` | `Matrix4` | World → local transform. |
| `bounds` | `Box3` | Bounding box including margin. |
| `geometryBounds` | `Box3` | Tight bounding box (no margin). |
| `meshMatrixWorld` | `Matrix4` | Source mesh's world matrix (for skinned meshes). |

### 8.2 ComputePointsSDFGenerator

Same interface as `ComputeSDFGenerator` but operates on point clouds using `PointsBVH`.
Defines surface as a shell of configurable radius around each point.

Additional construction option:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `shellRadius` | `number \| "auto"` | `"auto"` | Surface thickness around points. `"auto"` estimates from point density. |

The `shellRadius` property is gettable/settable after construction.

### 8.3 SDFSamplingFunctions (TSL)

Reusable TSL shader functions for working with 3D SDF textures:

| Function | Signature | Description |
|----------|-----------|-------------|
| `trilinearSample` | `(sdfTexture, sampler, uvw: vec3) => float` | Smooth interpolation across voxel boundaries. |
| `sdfGradient` | `(sdfTexture, sampler, uvw: vec3, texelSize: vec3) => vec3` | Surface normal via central differences. |
| `worldToSDFCoords` | `(worldPos: vec3, inverseBoundsMatrix: mat4) => vec3` | World → SDF texture coordinates. |
| `sdfCoordsToWorld` | `(uvw: vec3, boundsMatrix: mat4) => vec3` | SDF texture → world coordinates. |
| `isInsideSDF` | `(sdfValue: float, threshold: float) => bool` | `true` if `sdfValue < threshold`. |
| `sdfBoundaryResponse` | `(position, velocity, sdfValue, sdfNormal, stiffness, damping) => vec4` | Penalty-force collision response. |
| `blueNoise3D` | `(p: ivec3, level: int) => float` | Hilbert-curve + R1 blue noise in [0, 1]. |

### 8.4 SDFVolumeConstraint

Enforces SDF volume boundary constraints for particle simulations.

#### Functional API

```ts
createSDFBoundaryPass(
  positionsBuffer: StorageBufferAttribute,
  velocitiesBuffer: StorageBufferAttribute,
  sdfTexture: Storage3DTexture,
  inverseBoundsMatrix: Matrix4,
  boundsMatrix: Matrix4,
  options: {
    particleCount: number,
    stiffness?: number,      // Default 1000.0
    damping?: number,        // Default 0.5
    threshold?: number,      // Default 0.0
    texelSize?: Vector3      // Auto-computed from resolution if omitted
  }
) => ComputeNode;
```

#### Class API

```ts
class SDFVolumeConstraint {
  constructor(sdfGenerator: ComputeSDFGenerator, options?: {
    stiffness?: number,
    damping?: number,
    threshold?: number
  });

  apply(renderer, positionsBuffer, velocitiesBuffer, particleCount): Promise<void>;
  updateSDF(sdfGenerator: ComputeSDFGenerator): void;
}
```

### 8.5 SDF Visualization Materials

#### RayMarchSDFNodeMaterial

Renders a 3D SDF as a volumetric surface using sphere tracing (ray marching).

```ts
class RayMarchSDFNodeMaterial extends NodeMaterial {
  constructor(sdfTexture: Storage3DTexture);

  fragmentNode: {
    parameters: {
      surface: { value: number },              // Iso-surface level
      sdfTransformInverse: { value: Matrix4 }, // World → SDF
      sdfTransform: { value: Matrix4 }         // SDF → world
    }
  };
}
```

Features: adaptive step size, central-difference normals, directional lighting, configurable iso-level.

#### RenderSDFLayerNodeMaterial

Renders 2D slices of a 3D SDF for debugging.

```ts
class RenderSDFLayerNodeMaterial extends NodeMaterial {
  constructor(sdfTexture: Storage3DTexture);

  fragmentNode: {
    parameters: {
      layer: { value: number },      // Z-slice index
      grid_mode: { value: boolean }  // true = show all slices in a grid
    }
  };
}
```

Color encoding: red = inside (negative distance), green = outside (positive distance).

### 8.6 SDFVolumeHelpers

Debug visualization utilities:

| Function | Returns | Description |
|----------|---------|-------------|
| `createSDFBoundsHelper(sdfGen, color?)` | `Box3Helper` | Wireframe box showing SDF volume extent. |
| `updateSDFBoundsHelper(helper, sdfGen)` | `void` | Update helper after SDF regeneration. |
| `createSDFPointCloudHelper(sampler, options?)` | `Promise<Points>` | Point cloud of sampled positions. |
| `createSDFDebugGrid(sdfGen, options?)` | `Group` | Grid of colored spheres showing SDF values. |

---

## 9. GPU Culling & LOD (ComputeInstanceCulling)

Used internally by `BatchedText` but also available as a standalone component for
any `InstancedMesh`. WebGPU only.

### Construction

```ts
new ComputeInstanceCulling(
  mesh: InstancedMesh | Mesh | Options,
  renderer?: WebGPURenderer,
  options?: {
    enabled?: boolean,
    sortObjects?: boolean
  }
);
```

### Pipeline

1. **Init** — Allocate SSBOs: reference matrices, positions, normals, output IDs, visibility flags, indirect draw buffer.
2. **Clear** — Zero indirect args and visibility buffer.
3. **Cull + Pack** — Per-instance: test frustum planes → test LOD probability → write to compacted survivor buffer + atomically increment instance count.
4. **Sort** (optional) — Radix sort survivors by camera distance for transparency.
5. **Cap** — Clamp instance count to capacity.

### Uniforms / Parameters

Camera: `camPos`, `camView`, `camProj`, `isOrthographic`, `orthoScale`
LOD: `lodNear`, `lodFar`, `lodMode`, `lodDensity`
Frustum padding: `frustumPadXY`, `frustumPadZNear`, `frustumPadZFar`
Bounds: `boundingSphereCenter`, `boundingSphereRadius`, per-instance bounding spheres

### TSL Integration

```ts
import { instanceCulling } from '@three-blocks/core';
```

The `instanceCulling` TSL node patches `material.setupPosition()` to read from the
compacted survivor buffer instead of the raw instance matrix attribute.

---

## 10. Data Flow Diagrams

### 10.1 Single Text Rendering

```
User sets text.text, text.fontSize, etc.
       │
       ▼
   text.sync()
       │
       ├─► Web Worker (typesetting, glyph shaping)
       │       │
       │       ▼
       │   SDFGenerator.generateSDF() ──► SDF Atlas Texture
       │       │
       │       ▼
       │   ThreeBlocksTextRenderInfo
       │       │
       ▼       ▼
   Text.prepareMaterial()
       │
       ├─► TextNode (vertex)      ──► textGlyphTransform() ──► positionLocal
       │                                     │
       │                                     ▼
       │                              Varyings (UVs, IDs, bounds)
       │                                     │
       └─► TextColorNode (fragment) ◄────────┘
                   │
                   ├─► Sample SDF atlas at atlas UV
                   ├─► Compute signed distance
                   ├─► Derive fill alpha (smoothstep on distance)
                   ├─► Derive outline alpha (smoothstep on distance ± offset)
                   └─► Composite fill + outline ──► diffuseColor
```

### 10.2 BatchedText Rendering

```
User creates Text instances, calls batch.addText()
       │
       ▼
   batch.sync(cb, renderer)
       │
       ├─► Each member text.sync() in parallel
       │       │
       │       ▼
       │   Shared SDF Atlas (all members contribute glyphs)
       │
       ▼
   Repack instance buffers (matrices, style params → SSBOs)
       │
       ▼
   onBeforeRender (per frame)
       │
       ├─► _ensureCuller() ──► ComputeInstanceCulling
       │       │
       │       ├─► Frustum cull (GPU compute)
       │       ├─► LOD sample (GPU compute)
       │       └─► Write visibility SSBO
       │
       ├─► _ensureGlyphPackCompute()
       │       │
       │       ├─► Clear member glyph counts
       │       ├─► Count visible glyphs per member
       │       ├─► Prefix sum → glyph offsets
       │       ├─► Clear scatter heads
       │       ├─► Scatter visible glyphs (back-to-front order)
       │       └─► Update indirect draw args
       │
       ▼
   GPU Draw (single instanced draw call)
       │
       ├─► BatchedTextNode (vertex)
       │       ├─► Read packed glyph buffer (or source buffer if no culling)
       │       ├─► textGlyphTransform() ──► local position
       │       ├─► Per-member matrix transform
       │       └─► Billboarding (optional)
       │
       └─► BatchedTextColorNode (fragment)
               ├─► Read per-member color from SSBO
               ├─► Visibility mask check
               └─► SDF sample + composite (same as TextColorNode)
```

---

## 11. Backend Compatibility Matrix

| Feature | WebGPU | WebGL |
|---------|--------|-------|
| Single `Text` rendering | ✅ | ✅ |
| `BatchedText` batched draw | ✅ | ✅ |
| GPU SDF generation (`gpuAccelerateSDF`) | ✅ | ✅ (via WebGL canvas) |
| GPU frustum culling | ✅ | ❌ (auto-disabled) |
| GPU LOD sampling | ✅ | ❌ |
| Transparency sorting (bitonic) | ✅ | ❌ |
| Glyph packing compute | ✅ | ❌ |
| Indirect draw | ✅ | ❌ |
| `ComputeSDFGenerator` (3D volumes) | ✅ | ❌ |
| `ComputePointsSDFGenerator` | ✅ | ❌ |
| `SDFVolumeConstraint` | ✅ | ❌ |
| `RayMarchSDFNodeMaterial` | ✅ | ❌ |
| `RenderSDFLayerNodeMaterial` | ✅ | ❌ |
| TSL accessor nodes (`textLetterId`, etc.) | ✅ | ✅ |
| Billboarding | ✅ | ✅ |
| Screen-space mode | ✅ | ✅ |
| `positionNode` / `colorNode` hooks | ✅ | ✅ |

---

*End of specification.*
