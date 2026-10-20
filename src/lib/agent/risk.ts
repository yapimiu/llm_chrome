import type { ElementFlag } from '../dom/types';
import type { AgentAction } from './actions';
import { noteMatches, type SiteNote } from './site-notes';

/**
 * Оценка риска действий. Решает расширение, а не модель: модель видит текст страницы,
 * и страница может уговорить её «это безопасно». Флаг модели risky только добавляет подтверждение.
 */

export type RiskKind = 'payment' | 'delete' | 'send' | 'secret' | 'model';

export interface RiskReason {
  kind: RiskKind;
  /** Для человека: «кнопка «Оплатить» (слово «оплат»)». */
  why: string;
}

/** Словари — по одному слову/фразе на строку; совпадение по началу слова, без учёта регистра. */
export interface RiskRules {
  payment: string;
  delete: string;
  send: string;
  /** Части адреса страницы оплаты (сегменты пути или поддомен): checkout, payment… */
  paymentUrls: string;
}

export const DEFAULT_RISK_RULES: RiskRules = {
  payment: ['оплат', 'заплатить', 'купить', 'оформить заказ', 'подтвердить заказ', 'перевести', 'pay', 'buy', 'checkout', 'place order', 'purchase'].join('\n'),
  delete: ['удали', 'удаление', 'очистить', 'стереть', 'delete', 'remove', 'erase'].join('\n'),
  send: ['отправить', 'отправьте', 'опубликовать', 'разместить', 'send', 'post', 'publish', 'submit'].join('\n'),
  paymentUrls: ['checkout', 'payment', 'payments', 'pay', 'billing', 'oplata'].join('\n'),
};

export const RISK_LABELS: Record<RiskKind, string> = {
  payment: 'оплата',
  delete: 'удаление',
  send: 'отправка',
  secret: 'пароль / карта',
  model: 'отметила модель',
};

export type SiteRiskMode = 'ask' | 'allow' | 'block';

export interface SitePolicy {
  /** ask — подтверждать; allow — выполнять без подтверждения; block — не выполнять никогда. */
  mode: SiteRiskMode;
  /** Тексты кнопок, для которых подтверждение не нужно (нижний регистр). */
  safe: string[];
}

export function wordList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Первое слово из списка, с которого начинается какое-нибудь слово в тексте. */
export function matchWord(text: string, words: readonly string[]): string | null {
  const t = text.toLowerCase();
  for (const w of words) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}`, 'u').test(t)) return w;
  }
  return null;
}

/** Сегмент адреса целиком: «/checkout/», «pay.example.com», «/order-pay». «paypal» и «payload» — нет. */
export function matchUrl(url: string, parts: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // оставляем как есть
  }
  const where = `${u.hostname} ${path}`.toLowerCase();
  for (const p of parts) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}($|[^\\p{L}\\p{N}])`, 'u').test(where)) return p;
  }
  return null;
}

/** Имя элемента из строки наблюдения: `button "Оплатить" disabled` → `Оплатить`. */
export function elementName(line: string | undefined): string {
  if (!line) return '';
  const m = /^[^"\s]+\s+"((?:[^"\\]|\\.)*)"/.exec(line);
  return m ? m[1]!.replace(/\\(.)/g, '$1') : '';
}

/** Политика для страницы по заметкам сайтов: запрет сильнее разрешения, разрешение сильнее «спрашивать». */
export function sitePolicyFor(url: string, notes: readonly SiteNote[]): SitePolicy {
  const matching = notes.filter((n) => noteMatches(url, n.pattern));
  const modes = new Set(matching.map((n) => n.risk));
  return {
    mode: modes.has('block') ? 'block' : modes.has('allow') ? 'allow' : 'ask',
    safe: matching.flatMap((n) => wordList(n.safe)),
  };
}

export interface RiskInput {
  action: AgentAction;
  /** Строка элемента из наблюдения без номера: `button "Оплатить"`. */
  target?: string;
  /** drag: строка элемента, на который перетаскиваем. */
  toTarget?: string;
  flags: readonly ElementFlag[];
  /** Для поля формы: текст кнопки, которую нажмёт Enter в нём. */
  formSubmit?: string;
  url: string;
  /** Модель сама пометила шаг как рискованный. */
  modelFlag: boolean;
  rules: RiskRules;
  policy: SitePolicy;
}

const ELEMENT_ACTIONS: ReadonlySet<AgentAction['action']> = new Set(['click', 'type', 'select', 'drag']);
/** Для флага модели — всё, что что-то меняет в браузере. */
const EFFECT_ACTIONS: ReadonlySet<AgentAction['action']> = new Set(['click', 'type', 'select', 'drag', 'press_key', 'navigate', 'new_tab', 'go_back']);

/** Почему действие рискованное; пустой массив — безопасно. Политику block применяет цикл агента. */
export function assessAction(input: RiskInput): RiskReason[] {
  const { action, flags, rules, policy } = input;
  if (policy.mode === 'allow') return [];
  const reasons: RiskReason[] = [];
  const name = elementName(input.target);
  const lowerName = name.toLowerCase();
  const isSafe = !!lowerName && policy.safe.some((s) => lowerName.includes(s));
  // Enter в поле формы — то же, что клик по её кнопке отправки: «Отправить», «Оплатить»…
  const enterSubmits = action.action === 'type' && action.submit && !!input.formSubmit;
  const submitName = enterSubmits ? input.formSubmit! : '';
  const submitSafe = enterSubmits && policy.safe.some((s) => submitName.toLowerCase().includes(s));
  const has = (f: ElementFlag) => flags.includes(f);

  if (ELEMENT_ACTIONS.has(action.action)) {
    // Ввод пароля и отправка формы с паролем — всегда: исключение по тексту кнопки их не снимает.
    if (action.action === 'type' && has('secret')) reasons.push({ kind: 'secret', why: 'ввод в поле пароля или карты' });
    else if (has('form-secret') && ((action.action === 'click' && has('submit')) || (action.action === 'type' && action.submit))) {
      reasons.push({ kind: 'secret', why: 'отправка формы с паролем или картой' });
    }

    if (!isSafe) {
      if (action.action === 'click' && name) {
        for (const kind of ['payment', 'delete', 'send'] as const) {
          const w = matchWord(name, wordList(rules[kind]));
          if (w) reasons.push({ kind, why: `«${name.slice(0, 60)}» (слово «${w}»)` });
        }
      }
      // Перетаскивание в «Удалить» / на «Оплатить» — то же, что клик по ним.
      if (action.action === 'drag') {
        for (const n of [name, elementName(input.toTarget)].filter(Boolean)) {
          for (const kind of ['payment', 'delete', 'send'] as const) {
            const w = matchWord(n, wordList(rules[kind]));
            if (w && !reasons.some((r) => r.kind === kind)) reasons.push({ kind, why: `перетаскивание «${n.slice(0, 60)}» (слово «${w}»)` });
          }
        }
      }
      if (enterSubmits && !submitSafe && !has('search')) {
        for (const kind of ['payment', 'delete', 'send'] as const) {
          const w = matchWord(submitName, wordList(rules[kind]));
          if (w) reasons.push({ kind, why: `Enter отправит форму кнопкой «${submitName.slice(0, 60)}» (слово «${w}»)` });
        }
      }
      if (action.action === 'type' && action.submit && has('message') && !has('search') && !reasons.some((r) => r.kind === 'send')) {
        reasons.push({ kind: 'send', why: 'Enter в поле сообщения отправит его' });
      }
      const pay = matchUrl(input.url, wordList(rules.paymentUrls));
      if (pay && !reasons.some((r) => r.kind === 'payment')) reasons.push({ kind: 'payment', why: `страница оплаты («${pay}» в адресе)` });
    }
  }

  if (input.modelFlag && EFFECT_ACTIONS.has(action.action) && !isSafe && reasons.length === 0) {
    reasons.push({ kind: 'model', why: 'модель пометила шаг как необратимый' });
  }
  return reasons;
}

export function describeRisks(reasons: readonly RiskReason[]): string {
  return reasons.map((r) => `${RISK_LABELS[r.kind]}: ${r.why}`).join('; ');
}
