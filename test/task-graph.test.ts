import { describe, it, expect, vi } from 'vitest';
import { TaskGraph, TaskEvent } from '../src/task-graph';

describe('TaskGraph', () => {
  describe('createTask', () => {
    it('creates a root task with pending status', () => {
      const g = new TaskGraph();
      const t = g.createTask('Do stuff');
      expect(t.label).toBe('Do stuff');
      expect(t.status).toBe('pending');
      expect(t.parentId).toBeNull();
      expect(t.childIds).toEqual([]);
      expect(t.id).toBeTruthy();
    });

    it('creates multiple root tasks with unique IDs', () => {
      const g = new TaskGraph();
      const a = g.createTask('A');
      const b = g.createTask('B');
      expect(a.id).not.toBe(b.id);
    });

    it('creates a child task linked to parent', () => {
      const g = new TaskGraph();
      const parent = g.createTask('Parent');
      const child = g.createTask('Child', parent.id);
      expect(child.parentId).toBe(parent.id);

      const updatedParent = g.getTask(parent.id)!;
      expect(updatedParent.childIds).toContain(child.id);
    });

    it('throws when creating child with non-existent parent', () => {
      const g = new TaskGraph();
      expect(() => g.createTask('Orphan', 'fake-id')).toThrow('Parent task not found');
    });
  });

  describe('getTask', () => {
    it('returns undefined for non-existent ID', () => {
      const g = new TaskGraph();
      expect(g.getTask('nope')).toBeUndefined();
    });

    it('returns a copy (not the internal reference)', () => {
      const g = new TaskGraph();
      const t = g.createTask('X');
      const fetched = g.getTask(t.id)!;
      fetched.label = 'mutated';
      expect(g.getTask(t.id)!.label).toBe('X');
    });
  });

  describe('getRootTasks', () => {
    it('returns only tasks with no parent', () => {
      const g = new TaskGraph();
      const r1 = g.createTask('Root1');
      const r2 = g.createTask('Root2');
      g.createTask('Child', r1.id);

      const roots = g.getRootTasks();
      const rootIds = roots.map((t) => t.id);
      expect(rootIds).toContain(r1.id);
      expect(rootIds).toContain(r2.id);
      expect(roots).toHaveLength(2);
    });
  });

  describe('getChildren', () => {
    it('returns children of a task', () => {
      const g = new TaskGraph();
      const p = g.createTask('Parent');
      const c1 = g.createTask('C1', p.id);
      const c2 = g.createTask('C2', p.id);

      const children = g.getChildren(p.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toEqual([c1.id, c2.id]);
    });

    it('returns empty array for non-existent task', () => {
      const g = new TaskGraph();
      expect(g.getChildren('nope')).toEqual([]);
    });

    it('returns empty array for leaf task', () => {
      const g = new TaskGraph();
      const t = g.createTask('Leaf');
      expect(g.getChildren(t.id)).toEqual([]);
    });
  });

  describe('getVisibleTasks', () => {
    it('returns root-level tasks', () => {
      const g = new TaskGraph();
      const r = g.createTask('Root');
      g.createTask('Child', r.id);

      const visible = g.getVisibleTasks();
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe(r.id);
    });
  });

  describe('decompose', () => {
    it('creates subtasks under a parent', () => {
      const g = new TaskGraph();
      const p = g.createTask('Build app');
      const children = g.decompose(p.id, ['Design', 'Code', 'Test']);

      expect(children).toHaveLength(3);
      expect(children.map((c) => c.label)).toEqual(['Design', 'Code', 'Test']);
      children.forEach((c) => {
        expect(c.parentId).toBe(p.id);
        expect(c.status).toBe('pending');
      });

      const updatedParent = g.getTask(p.id)!;
      expect(updatedParent.childIds).toHaveLength(3);
    });

    it('throws when decomposing non-existent task', () => {
      const g = new TaskGraph();
      expect(() => g.decompose('nope', ['A'])).toThrow('Task not found');
    });

    it('handles zero children (no-op)', () => {
      const g = new TaskGraph();
      const p = g.createTask('Empty');
      const children = g.decompose(p.id, []);
      expect(children).toEqual([]);
      expect(g.getTask(p.id)!.childIds).toEqual([]);
    });
  });

  describe('complete', () => {
    it('marks a task complete', () => {
      const g = new TaskGraph();
      const t = g.createTask('Do it');
      g.complete(t.id);
      expect(g.getTask(t.id)!.status).toBe('complete');
    });

    it('is a no-op if already complete (no duplicate event)', () => {
      const g = new TaskGraph();
      const t = g.createTask('Done');
      g.complete(t.id);

      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));
      g.complete(t.id); // second time
      expect(events).toHaveLength(0);
    });

    it('throws for non-existent task', () => {
      const g = new TaskGraph();
      expect(() => g.complete('nope')).toThrow('Task not found');
    });
  });

  describe('activate', () => {
    it('marks a task active', () => {
      const g = new TaskGraph();
      const t = g.createTask('Work');
      g.activate(t.id);
      expect(g.getTask(t.id)!.status).toBe('active');
    });

    it('throws for non-existent task', () => {
      const g = new TaskGraph();
      expect(() => g.activate('nope')).toThrow('Task not found');
    });
  });

  describe('destroy', () => {
    it('removes a task from the graph', () => {
      const g = new TaskGraph();
      const t = g.createTask('Gone');
      g.destroy(t.id);
      expect(g.getTask(t.id)).toBeUndefined();
    });

    it('recursively removes children', () => {
      const g = new TaskGraph();
      const p = g.createTask('Parent');
      const c1 = g.createTask('C1', p.id);
      const gc = g.createTask('GC', c1.id);
      g.createTask('C2', p.id);

      g.destroy(p.id);
      expect(g.getTask(p.id)).toBeUndefined();
      expect(g.getTask(c1.id)).toBeUndefined();
      expect(g.getTask(gc.id)).toBeUndefined();
      expect(g.getRootTasks()).toEqual([]);
    });

    it('removes child from parent childIds when destroying a child', () => {
      const g = new TaskGraph();
      const p = g.createTask('Parent');
      const c = g.createTask('Child', p.id);
      g.destroy(c.id);
      expect(g.getTask(p.id)!.childIds).toEqual([]);
    });

    it('is a no-op for non-existent task', () => {
      const g = new TaskGraph();
      expect(() => g.destroy('nope')).not.toThrow();
    });
  });

  describe('completeAndDestroy', () => {
    it('marks complete then removes the task and children', () => {
      const g = new TaskGraph();
      const p = g.createTask('Parent');
      g.createTask('C1', p.id);

      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));

      g.completeAndDestroy(p.id);

      expect(g.getTask(p.id)).toBeUndefined();
      expect(g.getRootTasks()).toEqual([]);

      // Should have completed event then destroyed events
      const types = events.map((e) => e.type);
      expect(types[0]).toBe('completed');
      expect(types).toContain('destroyed');
    });

    it('throws for non-existent task', () => {
      const g = new TaskGraph();
      expect(() => g.completeAndDestroy('nope')).toThrow('Task not found');
    });
  });

  describe('events', () => {
    it('emits created event on createTask', () => {
      const g = new TaskGraph();
      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));

      const t = g.createTask('Hi');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'created', taskId: t.id });
    });

    it('emits decomposed event with childIds', () => {
      const g = new TaskGraph();
      const p = g.createTask('P');

      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));

      const children = g.decompose(p.id, ['A', 'B']);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('decomposed');
      expect(events[0].taskId).toBe(p.id);
      expect(events[0].childIds).toEqual(children.map((c) => c.id));
    });

    it('emits completed event', () => {
      const g = new TaskGraph();
      const t = g.createTask('T');
      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));

      g.complete(t.id);
      expect(events).toEqual([{ type: 'completed', taskId: t.id }]);
    });

    it('emits activated event', () => {
      const g = new TaskGraph();
      const t = g.createTask('T');
      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));

      g.activate(t.id);
      expect(events).toEqual([{ type: 'activated', taskId: t.id }]);
    });

    it('emits destroyed events for task and children', () => {
      const g = new TaskGraph();
      const p = g.createTask('P');
      const c = g.createTask('C', p.id);

      const events: TaskEvent[] = [];
      g.onChange((e) => events.push(e));

      g.destroy(p.id);
      const destroyed = events.filter((e) => e.type === 'destroyed');
      expect(destroyed).toHaveLength(2);
      // Children destroyed before parent
      expect(destroyed[0].taskId).toBe(c.id);
      expect(destroyed[1].taskId).toBe(p.id);
    });

    it('unsubscribe stops events', () => {
      const g = new TaskGraph();
      const events: TaskEvent[] = [];
      const unsub = g.onChange((e) => events.push(e));

      g.createTask('A');
      expect(events).toHaveLength(1);

      unsub();
      g.createTask('B');
      expect(events).toHaveLength(1);
    });
  });

  describe('serialization', () => {
    it('round-trips toJSON → fromJSON', () => {
      const g = new TaskGraph();
      const r = g.createTask('Root');
      g.createTask('Child', r.id);
      g.activate(r.id);

      const json = g.toJSON();
      const g2 = TaskGraph.fromJSON(json);

      const roots = g2.getRootTasks();
      expect(roots).toHaveLength(1);
      expect(roots[0].label).toBe('Root');
      expect(roots[0].status).toBe('active');

      const children = g2.getChildren(roots[0].id);
      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('Child');
    });

    it('preserves ID counter so new tasks get unique IDs', () => {
      const g = new TaskGraph();
      g.createTask('A');
      g.createTask('B');

      const g2 = TaskGraph.fromJSON(g.toJSON());
      const c = g2.createTask('C');
      // New ID should not collide with A or B
      const allIds = g2.getRootTasks().map((t) => t.id);
      expect(new Set(allIds).size).toBe(allIds.length);
      expect(c.id).not.toBe(g2.getRootTasks()[0].id);
    });

    it('fromJSON creates independent copy', () => {
      const g = new TaskGraph();
      g.createTask('Original');

      const json = g.toJSON();
      const g2 = TaskGraph.fromJSON(json);
      g2.createTask('Extra');

      expect(g.getRootTasks()).toHaveLength(1);
      expect(g2.getRootTasks()).toHaveLength(2);
    });
  });
});
