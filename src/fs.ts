/**
 * WorkspaceFS — virtual filesystem interface for agent tools.
 */

/** Directory entry returned by list() */
export interface DirEntry {
  name: string;
  kind: 'file' | 'directory';
}

/** Stat result */
export interface FsStat {
  kind: 'file' | 'directory';
}

/** Abstract filesystem for workspace files */
export interface WorkspaceFS {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FsStat | null>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalisePath(raw: string): string {
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

export class OpfsWorkspaceFS implements WorkspaceFS {
  private rootPrefix: string[];
  constructor(prefix: string[] = ['crush', 'workspaces', 'default']) {
    this.rootPrefix = prefix;
  }

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    let dir = await navigator.storage.getDirectory();
    for (const seg of this.rootPrefix) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    return dir;
  }

  private async resolveParent(root: FileSystemDirectoryHandle, segments: string[]): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    if (segments.length === 0) throw new Error('Empty path');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create: true });
    }
    return { parent: dir, name: segments[segments.length - 1] };
  }

  private async resolveDir(root: FileSystemDirectoryHandle, segments: string[]): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg);
    }
    return dir;
  }
  
  async stat(path: string): Promise<FsStat | null> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) return { kind: 'directory' }; // Root
    const root = await this.getRoot();
    try {
      const { parent, name } = await this.resolveParent(root, segs);
      try {
        await parent.getFileHandle(name);
        return { kind: 'file' };
      } catch {
        await parent.getDirectoryHandle(name);
        return { kind: 'directory' };
      }
    } catch {
      return null;
    }
  }
  
  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
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

  async stat(path: string): Promise<FsStat | null> {
    const segs = splitPath(normalisePath(path));
    if (segs.length === 0) return { kind: 'directory' }; // Root
    const node = this.resolve(segs);
    if (!node) return null;
    return { kind: node.kind };
  }
  
  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
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
