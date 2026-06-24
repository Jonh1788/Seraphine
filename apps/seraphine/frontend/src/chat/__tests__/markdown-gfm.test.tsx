import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

describe('chat markdown GFM', () => {
  it('renders a pipe table as a real <table> (not raw pipes)', () => {
    const md = '| Aspecto | A | B |\n|---|---|---|\n| Local | s | n |';
    const { container } = render(<Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown>);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th').length).toBe(3);
    expect(container.querySelectorAll('td').length).toBe(3);
    expect(container.textContent).not.toContain('|');
  });

  it('WITHOUT remark-gfm the same table stays raw pipes (regression guard)', () => {
    const md = '| Aspecto | A |\n|---|---|\n| Local | s |';
    const { container } = render(<Markdown>{md}</Markdown>);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('|');
  });
});
