/**
 * Type augmentation for VrmAvatarController methods being added by
 * the parallel agent (expression/gesture APIs). This declaration file
 * allows consuming code to compile before those methods are merged.
 *
 * Remove this file once the controller methods are fully merged.
 */
import { VrmAvatarController } from './VrmAvatarController';
import type { GestureDefinition } from './gestures';

declare module './VrmAvatarController' {
  interface VrmAvatarController {
    setExpression(emotion: string, fadeMs?: number, holdMs?: number): void;
    playGesture(name: string): Promise<void>;
    playGestureDef(def: GestureDefinition): Promise<void>;
    resetToIdle(): void;
    getAvailableExpressions(): string[];
    getAvailableGestures(): string[];
  }
}
