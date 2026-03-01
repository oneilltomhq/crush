export interface TaskNode {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'complete';
  parentId: string | null;
  childIds: string[];
}

export type TaskEventType = 'created' | 'completed' | 'destroyed' | 'decomposed' | 'activated';

export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  childIds?: string[];
}

type Listener = (event: TaskEvent) => void;

export class TaskGraph {
  private nodes: Map<string, TaskNode> = new Map();
  private nextId = 1;
  private listeners: Set<Listener> = new Set();

  private genId(): string {
    return `task-${this.nextId++}`;
  }

  private emit(event: TaskEvent): void {
    for (const fn of this.listeners) {
      fn(event);
    }
  }

  createTask(label: string, parentId?: string): TaskNode {
    const id = this.genId();
    const node: TaskNode = {
      id,
      label,
      status: 'pending',
      parentId: parentId ?? null,
      childIds: [],
    };

    if (parentId != null) {
      const parent = this.nodes.get(parentId);
      if (!parent) {
        throw new Error(`Parent task not found: ${parentId}`);
      }
      parent.childIds.push(id);
    }

    this.nodes.set(id, node);
    this.emit({ type: 'created', taskId: id });
    return { ...node, childIds: [...node.childIds] };
  }

  getTask(id: string): TaskNode | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    return { ...node, childIds: [...node.childIds] };
  }

  getRootTasks(): TaskNode[] {
    const roots: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === null) {
        roots.push({ ...node, childIds: [...node.childIds] });
      }
    }
    return roots;
  }

  getChildren(id: string): TaskNode[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.childIds
      .map((cid) => this.nodes.get(cid))
      .filter((n): n is TaskNode => n != null)
      .map((n) => ({ ...n, childIds: [...n.childIds] }));
  }

  getVisibleTasks(): TaskNode[] {
    return this.getRootTasks();
  }

  decompose(id: string, childLabels: string[]): TaskNode[] {
    const parent = this.nodes.get(id);
    if (!parent) {
      throw new Error(`Task not found: ${id}`);
    }

    const children: TaskNode[] = [];
    for (const label of childLabels) {
      const childId = this.genId();
      const child: TaskNode = {
        id: childId,
        label,
        status: 'pending',
        parentId: id,
        childIds: [],
      };
      this.nodes.set(childId, child);
      parent.childIds.push(childId);
      children.push({ ...child });
    }

    const childIds = children.map((c) => c.id);
    this.emit({ type: 'decomposed', taskId: id, childIds });
    return children;
  }

  complete(id: string): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Task not found: ${id}`);
    }
    if (node.status === 'complete') return;
    node.status = 'complete';
    this.emit({ type: 'completed', taskId: id });
  }

  completeAndDestroy(id: string): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Task not found: ${id}`);
    }
    node.status = 'complete';
    this.emit({ type: 'completed', taskId: id });
    this.destroyInternal(id);
  }

  activate(id: string): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Task not found: ${id}`);
    }
    node.status = 'active';
    this.emit({ type: 'activated', taskId: id });
  }

  destroy(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return; // no-op for non-existent tasks
    this.destroyInternal(id);
  }

  private destroyInternal(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Recursively destroy children first
    for (const childId of [...node.childIds]) {
      this.destroyInternal(childId);
    }

    // Remove from parent's childIds
    if (node.parentId != null) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter((cid) => cid !== id);
      }
    }

    this.nodes.delete(id);
    this.emit({ type: 'destroyed', taskId: id });
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  toJSON(): object {
    const nodes: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      nodes.push({ ...node, childIds: [...node.childIds] });
    }
    return { nodes, nextId: this.nextId };
  }

  static fromJSON(data: unknown): TaskGraph {
    const obj = data as { nodes: TaskNode[]; nextId: number };
    const graph = new TaskGraph();
    graph.nextId = obj.nextId;
    for (const node of obj.nodes) {
      graph.nodes.set(node.id, { ...node, childIds: [...node.childIds] });
    }
    return graph;
  }
}
