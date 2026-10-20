import { describe, expect, it } from 'vitest';
import { discoverChatId, isConfigured, TelegramBridge, TelegramClient, type TgUpdate } from '@/lib/notify/telegram';

const TOKEN = '123456:ABCdefGhIJKlmnoPQRstuVWxyz_0123';

/** Поддельный Bot API: запоминает вызовы, getUpdates отдаёт очередь обновлений. */
function fakeApi(queue: TgUpdate[][] = []) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextId = 100;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    let result: unknown = true;
    if (method === 'sendMessage') result = { message_id: nextId++ };
    if (method === 'getUpdates') {
      const batch = queue.shift();
      if (!batch) {
        await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      result = batch;
    }
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof fetch;
  return { calls, client: new TelegramClient({ botToken: TOKEN, chatId: '42' }, fetchImpl) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Telegram', () => {
  it('проверка настроек: токен и числовой chat id', () => {
    expect(isConfigured({ botToken: TOKEN, chatId: '42' })).toBe(true);
    expect(isConfigured({ botToken: TOKEN, chatId: '-100123' })).toBe(true);
    expect(isConfigured({ botToken: 'abc', chatId: '42' })).toBe(false);
    expect(isConfigured({ botToken: TOKEN, chatId: '@me' })).toBe(false);
  });

  it('кнопка «Выполнить» из нашего чата подтверждает, сообщение помечается', async () => {
    const { calls, client } = fakeApi([[{ update_id: 7, callback_query: { id: 'cb', data: 'ok:run1:3', message: { message_id: 100, chat: { id: 42 } } } }]]);
    const bridge = new TelegramBridge(client, async () => {});
    const answers: boolean[] = [];
    await bridge.askApproval('run1:3', 'Оплатить?', (ok) => answers.push(ok));
    for (let i = 0; i < 5 && answers.length === 0; i++) await tick();
    expect(answers).toEqual([true]);
    expect(calls[0]!.body.reply_markup).toMatchObject({ inline_keyboard: [[{ callback_data: 'ok:run1:3' }, { callback_data: 'no:run1:3' }]] });
    expect(calls.find((c) => c.method === 'editMessageText')?.body.text).toMatch(/Подтверждено в Telegram/);
    expect(bridge.waiting).toBe(0);
  });

  it('нажатия из чужого чата игнорируются', async () => {
    const { client } = fakeApi();
    const bridge = new TelegramBridge(client, async () => {});
    const answers: boolean[] = [];
    await bridge.askApproval('k', 'Удалить?', (ok) => answers.push(ok));
    await bridge.handle({ update_id: 1, callback_query: { id: 'x', data: 'ok:k', message: { message_id: 100, chat: { id: 666 } } } });
    expect(answers).toEqual([]);
    expect(bridge.waiting).toBe(1);
    bridge.stop();
  });

  it('ответ на вопрос — реплаем или единственным сообщением', async () => {
    const { calls, client } = fakeApi();
    const bridge = new TelegramBridge(client, async () => {});
    const got: string[] = [];
    await bridge.askQuestion('q1', 'Какой город?', (t) => got.push(t));
    expect(calls[0]!.body.reply_markup).toMatchObject({ force_reply: true });
    await bridge.handle({ update_id: 2, message: { message_id: 5, chat: { id: 42 }, text: 'Казань' } });
    expect(got).toEqual(['Казань']);
    bridge.stop();
  });

  it('cancel: ответили в браузере — сообщение помечено, опрос остановлен', async () => {
    const { calls, client } = fakeApi();
    const bridge = new TelegramBridge(client, async () => {});
    await bridge.askApproval('k', 'Отправить?', () => {});
    await bridge.cancel('k', 'Отвечено в браузере');
    expect(bridge.waiting).toBe(0);
    expect(calls.find((c) => c.method === 'editMessageText')?.body.text).toMatch(/Отвечено в браузере/);
  });

  it('chat id находится по последнему сообщению боту', async () => {
    const { client } = fakeApi([[{ update_id: 1, message: { message_id: 1, chat: { id: 555 }, text: '/start' } }]]);
    expect(await discoverChatId(client)).toBe('555');
  });

  it('ошибки API — понятным текстом', async () => {
    const client = new TelegramClient({ botToken: TOKEN, chatId: '1' }, (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as typeof fetch);
    await expect(client.send('x')).rejects.toThrow('Неверный токен бота.');
  });
});
