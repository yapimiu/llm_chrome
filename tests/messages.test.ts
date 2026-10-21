import { browser } from '#imports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToBackground } from '@/lib/messages';

afterEach(() => vi.restoreAllMocks());

describe('sendToBackground', () => {
  it('нормальный ответ возвращается как есть', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: true, value: 1 } as never);
    expect(await sendToBackground({ type: 'bg:run-get' })).toEqual({ ok: true, value: 1 });
  });

  it.each([null, undefined, 'x', {}])('пустой или чужой ответ (%s) — ошибка, а не падение на res.ok', async (bad) => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(bad as never);
    const res = await sendToBackground({ type: 'bg:run-get' });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/did not respond/) });
  });

  it('исключение отправки превращается в ошибку', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('Extension context invalidated.'));
    expect(await sendToBackground({ type: 'bg:run-get' })).toEqual({ ok: false, error: 'Extension context invalidated.' });
  });
});
