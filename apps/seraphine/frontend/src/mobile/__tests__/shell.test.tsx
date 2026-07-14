import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TabBar } from '../TabBar';

describe('TabBar', () => {
  it('renders 5 tabs with central chat orb and marks active', () => {
    const { container, getByText } = render(<TabBar tab="hoje" onTab={() => {}} />);
    expect(container.querySelectorAll('.mtab').length).toBe(5);
    expect(container.querySelector('.mtab--chat .morb')).toBeTruthy();
    expect(getByText('Hoje').closest('.mtab')?.className).toContain('mtab--active');
  });
  it('fires onTab', () => {
    let picked = '';
    const { getByText } = render(<TabBar tab="hoje" onTab={(t) => { picked = t; }} />);
    fireEvent.click(getByText('Trilhas'));
    expect(picked).toBe('trilhas');
  });
});
