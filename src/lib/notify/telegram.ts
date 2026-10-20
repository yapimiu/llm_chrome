/**
 * Telegram-бот: уведомления и ответы человека из чата — подтвердить рискованное действие кнопкой,
 * ответить на вопрос агента. Обновления читаются long-poll'ом getUpdates только пока чего-то ждём;
 * всё, что пришло не из чата из настроек, игнорируется — бот может написать кто угодно.
 */

export type FetchFn = typeof fetch;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface InlineButton {
  text: string;
  data: string;
}

/** То, что нам нужно из Update Telegram Bot API. */
export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

const API = 'https://api.telegram.org';
/** Telegram ограничивает сообщение 4096 символами. */
const MAX_TEXT = 4000;
/** Сколько секунд сервер держит getUpdates, если обновлений нет. */
export const POLL_TIMEOUT_SEC = 25;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export const isConfigured = (c: TelegramConfig): boolean => /^\d+:[\w-]{20,}$/.test(c.botToken.trim()) && /^-?\d+$/.test(c.chatId.trim());

export class TelegramClient {
  constructor(
    private readonly cfg: TelegramConfig,
    private readonly fetchImpl: FetchFn = (...a) => fetch(...a),
  ) {}

  get chatId(): string {
    return this.cfg.chatId.trim();
  }

  async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${API}/bot${this.cfg.botToken.trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!json?.ok) {
      const why = json?.description ?? `HTTP ${res.status}`;
      throw new TelegramError(res.status === 401 ? 'Неверный токен бота.' : res.status === 400 && /chat not found/i.test(why) ? 'Чат не найден: сначала напишите боту /start.' : `Telegram: ${why}`, res.status);
    }
    return json.result as T;
  }

  /** Отправить сообщение; buttons — ряды inline-кнопок. Возвращает message_id. */
  async send(text: string, buttons?: InlineButton[][], forceReply = false): Promise<number> {
    const body: Record<string, unknown> = { chat_id: this.cfg.chatId.trim(), text: text.slice(0, MAX_TEXT), disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
    else if (forceReply) body.reply_markup = { force_reply: true, input_field_placeholder: 'Ответ агенту' };
    const msg = await this.call<{ message_id: number }>('sendMessage', body);
    return msg.message_id;
  }

  /** Заменить текст сообщения и убрать кнопки (на вопрос уже ответили). */
  async edit(messageId: number, text: string): Promise<void> {
    await this.call('editMessageText', { chat_id: this.cfg.chatId.trim(), message_id: messageId, text: text.slice(0, MAX_TEXT) });
  }

  async answerCallback(id: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  async updates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, signal);
  }
}

/** Чат последнего написавшего боту — чтобы не искать chat id вручную. */
export async function discoverChatId(client: TelegramClient): Promise<string | null> {
  const ups = await client.updates(undefined, 0);
  for (const u of [...ups].reverse()) {
    const id = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
    if (id !== undefined) return String(id);
  }
  return null;
}

// ——— ожидание ответов ———

export type Reply = { kind: 'approval'; approved: boolean } | { kind: 'answer'; text: string };

interface Pending {
  key: string;
  kind: 'approval' | 'question';
  messageId: number;
  text: string;
  resolve: (r: Reply) => void;
}

/**
 * Ждёт ответов человека в Telegram: кнопки под запросом подтверждения и ответы (reply) на вопросы.
 * Опрашивает getUpdates, пока есть хоть один ожидающий запрос.
 */
export class TelegramBridge {
  private readonly pending = new Map<string, Pending>();
  private offset: number | undefined;
  private polling: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly client: TelegramClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get waiting(): number {
    return this.pending.size;
  }

  async notify(text: string): Promise<void> {
    await this.client.send(text);
  }

  /** Запрос подтверждения с кнопками; onReply вызывается один раз. */
  async askApproval(key: string, text: string, onReply: (approved: boolean) => void): Promise<void> {
    if (this.pending.has(key)) return;
    const messageId = await this.client.send(text, [
      [
        { text: '✅ Выполнить', data: `ok:${key}` },
        { text: '❌ Отклонить', data: `no:${key}` },
      ],
    ]);
    this.add({ key, kind: 'approval', messageId, text, resolve: (r) => r.kind === 'approval' && onReply(r.approved) });
  }

  /** Вопрос агента: человек отвечает реплаем на сообщение (или просто пишет, если вопрос один). */
  async askQuestion(key: string, text: string, onReply: (answer: string) => void): Promise<void> {
    if (this.pending.has(key)) return;
    const messageId = await this.client.send(`${text}\n\n↩️ Ответьте на это сообщение.`, undefined, true);
    this.add({ key, kind: 'question', messageId, text, resolve: (r) => r.kind === 'answer' && onReply(r.text) });
  }

  /** Ответили в браузере (или запуск остановлен) — помечаем сообщение и перестаём ждать. */
  async cancel(key: string, note: string): Promise<void> {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (this.pending.size === 0) this.abort?.abort();
    await this.client.edit(p.messageId, `${p.text}\n\n${note}`).catch(() => {});
  }

  stop(): void {
    this.pending.clear();
    this.abort?.abort();
  }

  private add(p: Pending): void {
    this.pending.set(p.key, p);
    this.polling ??= this.poll().finally(() => (this.polling = null));
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (this.pending.size > 0) {
      this.abort = new AbortController();
      try {
        const ups = await this.client.updates(this.offset, POLL_TIMEOUT_SEC, this.abort.signal);
        failures = 0;
        for (const u of ups) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((err: unknown) => console.warn('telegram update failed', err));
        }
      } catch (err) {
        if (this.abort.signal.aborted) continue;
        // Сеть моргнула или бот занят другим getUpdates — подождём и попробуем снова.
        await this.sleep(Math.min(2000 * 2 ** failures++, 60_000));
      }
    }
  }

  private fromOurChat(chatId: number | undefined): boolean {
    return chatId !== undefined && String(chatId) === this.client.chatId;
  }

  async handle(u: TgUpdate): Promise<void> {
    const cb = u.callback_query;
    if (cb) {
      if (!this.fromOurChat(cb.message?.chat.id)) return;
      const m = /^(ok|no):(.+)$/.exec(cb.data ?? '');
      const p = m ? this.pending.get(m[2]!) : undefined;
      if (!m || !p || p.kind !== 'approval') {
        await this.client.answerCallback(cb.id, 'Этот запрос уже неактуален.');
        return;
      }
      const approved = m[1] === 'ok';
      this.pending.delete(p.key);
      await this.client.answerCallback(cb.id, approved ? 'Выполняю' : 'Отклонено');
      await this.client.edit(p.messageId, `${p.text}\n\n${approved ? '✅ Подтверждено в Telegram' : '❌ Отклонено в Telegram'}`).catch(() => {});
      p.resolve({ kind: 'approval', approved });
      return;
    }
    const msg = u.message;
    if (!msg?.text || !this.fromOurChat(msg.chat.id)) return;
    const questions = [...this.pending.values()].filter((p) => p.kind === 'question');
    const p = questions.find((q) => q.messageId === msg.reply_to_message?.message_id) ?? (questions.length === 1 ? questions[0] : undefined);
    if (!p) return;
    this.pending.delete(p.key);
    await this.client.edit(p.messageId, `${p.text}\n\n💬 Ответ: ${msg.text}`).catch(() => {});
    p.resolve({ kind: 'answer', text: msg.text });
  }
}
