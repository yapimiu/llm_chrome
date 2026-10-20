import { browser } from '#imports';
import { CdpDriver } from './cdp';

const PROTOCOL_VERSION = '1.3';

/**
 * Подключения chrome.debugger к вкладкам на время одного запуска агента.
 * Если пользователь закрыл жёлтую плашку «расширение отлаживает браузер» (canceled_by_user),
 * больше не подключаемся до конца запуска — исполнитель уходит на DOM-события.
 */
export class DebuggerSessions {
  private readonly drivers = new Map<number, CdpDriver>();
  private canceled = false;
  private lastError = '';
  private readonly onDetach = (source: { tabId?: number }, reason: string) => {
    if (source.tabId !== undefined) this.drivers.delete(source.tabId);
    if (reason === 'canceled_by_user') this.canceled = true;
  };

  constructor() {
    browser.debugger.onDetach.addListener(this.onDetach);
  }

  /** Почему CDP недоступен (для сообщения в ленте), пустая строка — доступен. */
  get unavailableReason(): string {
    if (this.canceled) return 'отладка отключена пользователем (плашка Chrome закрыта)';
    return this.lastError;
  }

  /** Драйвер для вкладки или null — тогда действовать DOM-событиями. */
  async driverFor(tabId: number): Promise<CdpDriver | null> {
    if (this.canceled) return null;
    const existing = this.drivers.get(tabId);
    if (existing) return existing;
    try {
      await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Уже подключены (например, после перезапуска worker'а) — это не ошибка.
      if (!/already attached/i.test(msg)) {
        this.lastError = msg;
        return null;
      }
    }
    const platform = await browser.runtime.getPlatformInfo().then((p): 'mac' | 'other' => (p.os === 'mac' ? 'mac' : 'other'));
    const driver = new CdpDriver((method, params) => browser.debugger.sendCommand({ tabId }, method, params), {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      platform,
    });
    this.drivers.set(tabId, driver);
    return driver;
  }

  async detachAll(): Promise<void> {
    browser.debugger.onDetach.removeListener(this.onDetach);
    const tabs = [...this.drivers.keys()];
    this.drivers.clear();
    await Promise.all(tabs.map((tabId) => browser.debugger.detach({ tabId }).catch(() => {})));
  }
}
