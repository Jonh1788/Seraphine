/**
 * Minimal command-pattern undo/redo stack for Animation Lab mutations.
 *
 * Each command captures the state needed to apply and revert itself.
 * The stack caps at `limit` entries (oldest dropped when exceeded).
 *
 * Callers wrap setState-like mutations into Commands and push them via
 * `record(cmd)`. `undo()` and `redo()` walk the stack. The lab uses a
 * single shared stack instance per editor session.
 */

export interface Command {
  /** Short label for debug / feedback toast. */
  label: string;
  /** Apply the forward mutation. */
  apply(): void;
  /** Revert the mutation. */
  revert(): void;
  /**
   * Optional: if the previous command on the stack should be replaced by
   * this one (e.g. continuous slider drag collapsing into a single undo),
   * return true. Receives the previous command for inspection.
   */
  mergeWith?(prev: Command): boolean;
}

export class UndoStack {
  private past: Command[] = [];
  private future: Command[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly limit = 100) {}

  /**
   * Execute the command's forward mutation and push it to the past stack.
   * If `prev.mergeWith(cmd)` returns true, `prev` has absorbed `cmd` into
   * itself (e.g. a slider drag updating its "after" state). We then apply
   * `cmd` so the user sees its effect, but we do NOT push it — the stack
   * tail stays as `prev`, which now reverts back to the pre-prev state.
   *
   * Order matters: previous versions called `cmd.apply()` BEFORE the
   * merge check and then replaced the tail with `cmd`. That left `prev`'s
   * forward effect un-undoable, since `cmd.revert()` only undoes `cmd`'s
   * own delta. The correct invariant is "the stack tail is the only
   * command needed to revert the current state to the snapshot taken
   * before the most recent merge group started" — which is `prev`'s job,
   * not `cmd`'s.
   */
  record(cmd: Command): void {
    const prev = this.past[this.past.length - 1];
    if (prev && prev.mergeWith?.(cmd)) {
      // prev already applied earlier when it was recorded; now apply only
      // the new delta represented by cmd so the on-screen state advances.
      cmd.apply();
    } else {
      cmd.apply();
      this.past.push(cmd);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future.length = 0;
    this.notify();
  }

  /**
   * Execute a mutation without going through Command (for one-off actions
   * that don't need to be undoable). Kept for symmetry and rare use.
   */
  pushSideEffect(): void { /* noop hook */ }

  undo(): Command | null {
    const cmd = this.past.pop();
    if (!cmd) return null;
    cmd.revert();
    this.future.push(cmd);
    this.notify();
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.future.pop();
    if (!cmd) return null;
    cmd.apply();
    this.past.push(cmd);
    this.notify();
    return cmd;
  }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.notify();
  }

  /** Subscribe to stack changes. Returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
