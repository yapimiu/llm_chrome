// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorOverlay } from '@/lib/dom/cursor';

describe('CursorOverlay.follow — курсор повторяет настоящую мышь', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body></body>';
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('первое событие создаёт курсор в странице, следующие его только двигают', () => {
    const cursor = new CursorOverlay(document);
    cursor.follow(100, 80);
    const hosts = document.querySelectorAll('llm-agent-cursor');
    expect(hosts).toHaveLength(1);
    expect(cursor.isOwn(hosts[0]!)).toBe(true);
    cursor.follow(140, 90);
    cursor.follow(180, 95);
    expect(document.querySelectorAll('llm-agent-cursor')).toHaveLength(1);
  });

  it('исчезает через несколько секунд после последнего движения, пока двигается — остаётся', () => {
    const cursor = new CursorOverlay(document);
    cursor.follow(10, 10);
    vi.advanceTimersByTime(3000);
    cursor.follow(20, 20);
    vi.advanceTimersByTime(3000);
    expect(document.querySelectorAll('llm-agent-cursor')).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(document.querySelectorAll('llm-agent-cursor')).toHaveLength(0);
  });
});
