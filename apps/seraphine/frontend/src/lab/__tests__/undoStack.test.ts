import { describe, it, expect } from 'vitest';
import { UndoStack, type Command } from '../undoStack';

describe('UndoStack', () => {
  it('records, undoes, and redoes in order', () => {
    const log: string[] = [];
    const stack = new UndoStack();
    stack.record({
      label: 'a',
      apply: () => log.push('apply a'),
      revert: () => log.push('revert a'),
    });
    stack.record({
      label: 'b',
      apply: () => log.push('apply b'),
      revert: () => log.push('revert b'),
    });
    expect(log).toEqual(['apply a', 'apply b']);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);

    stack.undo();
    expect(log).toEqual(['apply a', 'apply b', 'revert b']);
    expect(stack.canRedo()).toBe(true);

    stack.redo();
    expect(log).toEqual(['apply a', 'apply b', 'revert b', 'apply b']);
  });

  it('clears redo stack on new record', () => {
    const stack = new UndoStack();
    stack.record({ label: 'a', apply: () => {}, revert: () => {} });
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    stack.record({ label: 'b', apply: () => {}, revert: () => {} });
    expect(stack.canRedo()).toBe(false);
  });

  it('honors limit by dropping oldest', () => {
    const stack = new UndoStack(3);
    for (let i = 0; i < 5; i++) {
      stack.record({ label: `${i}`, apply: () => {}, revert: () => {} });
    }
    // After 5 records with limit 3, only the last 3 should remain.
    // Undo 3 times should work; a 4th should return null.
    expect(stack.undo()?.label).toBe('4');
    expect(stack.undo()?.label).toBe('3');
    expect(stack.undo()?.label).toBe('2');
    expect(stack.undo()).toBeNull();
  });

  it('merges into prev so a single undo reverts the whole drag group', () => {
    // Simulates a slider drag: one Command per intermediate value. The
    // FIRST command in the drag declares `mergeWith` so subsequent ones
    // get absorbed into it. Its `revert` always restores the pre-drag
    // snapshot (value=0), so a single undo restores the whole group.
    const log: string[] = [];
    const stack = new UndoStack();

    let value = 0;
    const makeStep = (n: number) => {
      const cmd: Command = {
        label: `slider ${n}`,
        apply: () => { value = n; log.push(`apply ${n}`); },
        revert: () => { value = 0; log.push('revert to 0'); },
        // Subsequent steps in the drag should fold into me.
        mergeWith: (_cmd: Command) => true,
      };
      return cmd;
    };

    stack.record(makeStep(1));   // first: nothing on stack, pushed
    stack.record(makeStep(2));   // prev=step1, prev.mergeWith→true: applied, not pushed
    stack.record(makeStep(3));   // prev=step1, prev.mergeWith→true: applied, not pushed

    expect(value).toBe(3);
    expect(log).toEqual(['apply 1', 'apply 2', 'apply 3']);

    // Single undo must revert all the way back to 0 — that's the whole
    // point of merging a drag into one undoable group.
    stack.undo();
    expect(value).toBe(0);
    expect(stack.canUndo()).toBe(false);
  });

  it('does not merge when prev has no mergeWith — both stay undoable', () => {
    let value = 0;
    const stack = new UndoStack();
    stack.record({
      label: 'a',
      apply: () => { value = 1; },
      revert: () => { value = 0; },
    });
    stack.record({
      label: 'b',
      apply: () => { value = 2; },
      revert: () => { value = 1; },
    });
    expect(value).toBe(2);
    stack.undo();
    expect(value).toBe(1);
    stack.undo();
    expect(value).toBe(0);
  });

  it('notifies subscribers', () => {
    const stack = new UndoStack();
    let n = 0;
    const unsub = stack.subscribe(() => { n++; });
    stack.record({ label: 'a', apply: () => {}, revert: () => {} });
    stack.undo();
    stack.redo();
    expect(n).toBeGreaterThanOrEqual(3);
    unsub();
    stack.record({ label: 'b', apply: () => {}, revert: () => {} });
    // Count must not increment after unsubscribe.
    expect(n).toBeLessThan(5);
  });
});
