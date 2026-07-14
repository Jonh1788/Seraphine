import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Orb } from '../Orb';

describe('Orb', () => {
  it('renders at the given size', () => {
    const { container } = render(<Orb size={56} />);
    const el = container.querySelector('.morb') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.width).toBe('56px');
  });
  it('adds float/halo modifiers', () => {
    const { container } = render(<Orb size={38} float halo />);
    expect(container.querySelector('.morb--float')).toBeTruthy();
    expect(container.querySelector('.morb__halo')).toBeTruthy();
  });
});
