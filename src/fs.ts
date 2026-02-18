/**
 * WorkspaceFS — virtual filesystem interface for agent tools.
 *
 * Implementations:
 *   - OpfsWorkspaceFS: backed by Origin Private File System (browser sandbox)
 *   - MemoryWorkspaceFS: in-memory (testing, ephemeral sessions)
 *
 * All paths are relative (no leading slash). Directory separator is '/'.
 * Implementations normalise and reject traversal attempts ('..').
 */

/** Directory entry returned by list() */
export interface DirEntry {
  name: string;
  kind: 'file' | 'directory';
}

/** Abstract filesystem for workspace files */
export interface WorkspaceFS {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalisePath(raw: string): string {
  // Strip leading/trailing slashes, collapse runs
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new Error(`Path traversal not allowed: ${raw}`);
  }
  return parts.join('/');
}

function splitPath(normalised: string): string[] {
  if (normalised === '') return [];
  return normalised.split('/');
}

// ---------------------------------------------------------------------------
// OpfsWorkspaceFS
// ---------------------------------------------------------------------------

/**
 * OPFS-backed workspace filesystem.
 *
 * Each workspace is stored under a root prefix inside OPFS, e.g.
 * `crush/workspaces/<id>/`. The prefix is configured at construction time.
 */
export class OpfsWorkspaceFS implements WorkspaceFS {
  private rootPrefix: string[];

  /**
   * @param prefix  Path segments under OPFS root, e.g. ['crush', 'workspaces', 'default']
   */
  constructor(prefix: string[] = ['crush', 'workspaces', 'default']) {
    this.rootPrefix = prefix;
  }

  /** Resolve the OPFS directory handle for the workspace root, creating dirs as needed */
  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    let dir = await navigator.storage.getDirectory();
    for (const seg of this.rootPrefix) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    return dir;
  }

  /** Walk to the parent directory of a path, creating intermediates */
  private async resolveParent(
    root: FileSystemDirectoryHandle,
    segments: string[],
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    if (segments.length === 0) throw new Error('Empty path');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create: true });
    }
    return { parent: dir, name: segments[segments.length - 1] };
  }

  /** Walk to a directory handle (no create) */
  private async resolveDir(
    root: FileSystemDirectoryHandle,
    segments: string[],
  ): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg);
    }
    return dir;
  }

  async readText(path: string): Promise<string> {
    const segs = splitPath(normalisePath(path));
    const root = await this.getRoot();
    const { parent, name } = await this.resolveParent(root, segs);
    const fh = await parent.getFileHandle(name);
    const file = await fh.getFile();
    return file.text();
  }

  async writeText(path: string, content: string): Promise<void> {
    const segs = splitPath(normalisePath(path));
    const root = await this.getRoot();
    const { parent, name } = await this.resolveParent(root, segs);
    const fh = await parent.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async list(path: string): Promise<DirEntry[]> {
    const segs = splitPath(normalisePath(path));
    const root = await this.getRoot();
    const dir = segs.length > 0 ? await this.resolveDir(root, segs) : root;
    const entries: DirEntry[] = [];
    for await (const [name, handle] of (dir as any).entries()) {
      entries.push({ name, kind: handle.kind as 'file' | 'directory' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) return true; // root always exists
    const root = await this.getRoot();
    try {
      const { parent, name } = await this.resolveParent(root, segs);
      try {
        await parent.getFileHandle(name);
        return true;
      } catch {
        await parent.getDirectoryHandle(name);
        return true;
      }
    } catch {
      return false;
    }
  }

  async mkdirp(path: string): Promise<void> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) return;
    const root = await this.getRoot();
    let dir = root;
    for (const seg of segs) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
  }

  async remove(path: string): Promise<void> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) throw new Error('Cannot remove workspace root');
    const root = await this.getRoot();
    const { parent, name } = await this.resolveParent(root, segs);
    await parent.removeEntry(name, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// MemoryWorkspaceFS
// ---------------------------------------------------------------------------

type FsNode = { kind: 'file'; content: string } | { kind: 'directory'; children: Map<string, FsNode> };

function mkDir(): FsNode {
  return { kind: 'directory', children: new Map() };
}

/**
 * In-memory WorkspaceFS implementation for testing and ephemeral sessions.
 */
export class MemoryWorkspaceFS implements WorkspaceFS {
  private root: FsNode = mkDir();

  private resolve(segments: string[]): FsNode | undefined {
    let node: FsNode = this.root;
    for (const seg of segments) {
      if (node.kind !== 'directory') return undefined;
      const child = node.children.get(seg);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  private resolveParentAndName(segments: string[]): { parent: FsNode; name: string } | undefined {
    if (segments.length === 0) return undefined;
    const parentSegs = segments.slice(0, -1);
    const parent = this.resolve(parentSegs);
    if (!parent || parent.kind !== 'directory') return undefined;
    return { parent, name: segments[segments.length - 1] };
  }

  private ensureDir(segments: string[]): FsNode {
    let node: FsNode = this.root;
    for (const seg of segments) {
      if (node.kind !== 'directory') throw new Error(`Not a directory`);
      let child = node.children.get(seg);
      if (!child) {
        child = mkDir();
        node.children.set(seg, child);
      }
      node = child;
    }
    return node;
  }

  async readText(path: string): Promise<string> {
    const segs = splitPath(normalisePath(path));
    const node = this.resolve(segs);
    if (!node || node.kind !== 'file') throw new Error(`File not found: ${path}`);
    return node.content;
  }

  async writeText(path: string, content: string): Promise<void> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) throw new Error('Cannot write to root');
    // ensure parent dirs
    this.ensureDir(segs.slice(0, -1));
    const parent = this.resolve(segs.slice(0, -1))!;
    if (parent.kind !== 'directory') throw new Error('Parent is not a directory');
    parent.children.set(segs[segs.length - 1], { kind: 'file', content });
  }

  async list(path: string): Promise<DirEntry[]> {
    const segs = splitPath(normalisePath(path));
    const node = segs.length > 0 ? this.resolve(segs) : this.root;
    if (!node || node.kind !== 'directory') throw new Error(`Not a directory: ${path}`);
    const entries: DirEntry[] = [];
    for (const [name, child] of node.children) {
      entries.push({ name, kind: child.kind });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) return true;
    return this.resolve(segs) !== undefined;
  }

  async mkdirp(path: string): Promise<void> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) return;
    this.ensureDir(segs);
  }

  async remove(path: string): Promise<void> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) throw new Error('Cannot remove root');
    const r = this.resolveParentAndName(segs);
    if (!r) throw new Error(`Not found: ${path}`);
    const { parent, name } = r;
    if (parent.kind !== 'directory') throw new Error('Parent is not a directory');
    if (!parent.children.has(name)) throw new Error(`Not found: ${path}`);
    parent.children.delete(name);
  }
}
