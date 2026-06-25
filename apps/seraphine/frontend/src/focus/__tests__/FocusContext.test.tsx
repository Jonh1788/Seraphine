import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FocusProvider, useFocus } from '../FocusContext';

// Avoid backend calls / notifications during the test.
vi.mock('../api', () => ({ logFocusSession: vi.fn(), setFocusActive: vi.fn() }));
vi.mock('../../utils/notify', () => ({ notify: vi.fn() }));

function Remaining() {
  const [state] = useFocus();
  return <span data-testid="phase">{state.phase}</span>;
}

describe('FocusContext', () => {
  beforeEach(() => localStorage.clear());

  it('provides focus state to consumers under the provider', () => {
    render(
      <FocusProvider>
        <Remaining />
      </FocusProvider>,
    );
    expect(screen.getByTestId('phase').textContent).toBe('idle');
  });

  it('throws if useFocus is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Remaining />)).toThrow();
    spy.mockRestore();
  });
});
