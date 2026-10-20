// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AgentAction } from '@/lib/agent/actions';
import { parseAgentStep } from '@/lib/agent/parse';
import {
  assessAction,
  DEFAULT_RISK_RULES,
  elementName,
  matchUrl,
  matchWord,
  sitePolicyFor,
  wordList,
  type RiskInput,
  type SitePolicy,
} from '@/lib/agent/risk';
import type { SiteNote } from '@/lib/agent/site-notes';
import { riskFlags } from '@/lib/dom/collect';
import type { ElementFlag } from '@/lib/dom/types';

const ASK: SitePolicy = { mode: 'ask', safe: [] };

function assess(action: AgentAction, target?: string, flags: ElementFlag[] = [], extra: Partial<RiskInput> = {}) {
  return assessAction({ action, target, flags, url: 'https://shop.example/catalog', modelFlag: false, rules: DEFAULT_RISK_RULES, policy: ASK, ...extra });
}
const kinds = (r: { kind: string }[]) => r.map((x) => x.kind);
const click: AgentAction = { action: 'click', index: 1 };

describe('словари и адреса', () => {
  it('слово совпадает по началу слова, без учёта регистра', () => {
    const pay = wordList(DEFAULT_RISK_RULES.payment);
    expect(matchWord('Оплатить 1 500 ₽', pay)).toBe('оплат');
    expect(matchWord('Перейти к оплате', pay)).toBe('оплат');
    expect(matchWord('Купить в 1 клик', pay)).toBe('купить');
    expect(matchWord('Купон на скидку', pay)).toBeNull();
    expect(matchWord('PayPal', pay)).toBe('pay'); // начало слова — да, это оплата
    expect(matchWord('Repay later', pay)).toBeNull(); // середина слова — нет
    const del = wordList(DEFAULT_RISK_RULES.delete);
    expect(matchWord('Удалить аккаунт', del)).toBe('удали');
    expect(matchWord('Удалённая работа', del)).toBeNull();
  });

  it('адрес оплаты — целым сегментом пути или поддоменом', () => {
    const urls = wordList(DEFAULT_RISK_RULES.paymentUrls);
    expect(matchUrl('https://shop.example/checkout/step-2', urls)).toBe('checkout');
    expect(matchUrl('https://pay.example.com/form', urls)).toBe('pay');
    expect(matchUrl('https://shop.example/order-pay?id=1', urls)).toBe('pay');
    expect(matchUrl('https://www.paypal.com/', urls)).toBeNull();
    expect(matchUrl('https://api.example/payload', urls)).toBeNull();
    expect(matchUrl('не адрес', urls)).toBeNull();
  });

  it('имя элемента из строки наблюдения', () => {
    expect(elementName('button "Оплатить" disabled')).toBe('Оплатить');
    expect(elementName('input[type=submit] "Отправить \\"срочно\\""')).toBe('Отправить "срочно"');
    expect(elementName('input[type=email] placeholder="Email" value=""')).toBe('');
    expect(elementName(undefined)).toBe('');
  });
});

describe('assessAction', () => {
  it('кнопки оплаты, удаления и отправки', () => {
    expect(kinds(assess(click, 'button "Оплатить заказ"'))).toEqual(['payment']);
    expect(kinds(assess(click, 'a "Удалить" href="/items/5/delete"'))).toEqual(['delete']);
    expect(kinds(assess(click, 'button "Отправить"'))).toEqual(['send']);
    expect(assess(click, 'button "Оплатить заказ"')[0]!.why).toContain('«Оплатить заказ»');
  });

  it('обычные клики, прокрутка и переходы безопасны', () => {
    expect(assess(click, 'a "Каталог" href="/catalog"')).toEqual([]);
    expect(assess(click, 'button "Добавить в корзину"')).toEqual([]);
    expect(assess({ action: 'scroll', direction: 'down', amount: 1 })).toEqual([]);
    expect(assess({ action: 'navigate', url: 'https://shop.example/checkout' })).toEqual([]);
    expect(assess({ action: 'type', index: 2, text: 'ноутбук', submit: true }, 'input[type=search] placeholder="Поиск"', ['search'])).toEqual([]);
  });

  it('пароль и карта — всегда, даже для кнопки из исключений', () => {
    const typePass: AgentAction = { action: 'type', index: 3, text: 'qwerty', submit: false };
    expect(kinds(assess(typePass, 'input[type=password] value=""', ['secret']))).toEqual(['secret']);
    const login = assess(click, 'button "Войти"', ['submit', 'form-secret'], { policy: { mode: 'ask', safe: ['войти'] } });
    expect(kinds(login)).toEqual(['secret']);
    // Enter в поле логина отправляет форму с паролем
    expect(kinds(assess({ action: 'type', index: 2, text: 'me@x.ru', submit: true }, 'input[type=email]', ['form-secret']))).toEqual(['secret']);
    // без Enter — просто ввод почты
    expect(assess({ action: 'type', index: 2, text: 'me@x.ru', submit: false }, 'input[type=email]', ['form-secret'])).toEqual([]);
  });

  it('Enter в поле формы — как клик по её кнопке отправки', () => {
    const enter: AgentAction = { action: 'type', index: 2, text: 'hello', submit: true };
    const field = 'input[type=text] placeholder="Your message" value=""';
    expect(kinds(assess(enter, field, [], { formSubmit: 'Отправить' }))).toEqual(['send']);
    expect(kinds(assess(enter, field, [], { formSubmit: 'Оплатить заказ' }))).toEqual(['payment']);
    expect(assess(enter, field, [], { formSubmit: 'Найти' })).toEqual([]);
    expect(assess({ ...enter, submit: false }, field, [], { formSubmit: 'Отправить' })).toEqual([]);
    expect(assess(enter, field, [], { formSubmit: 'Отправить ответ', policy: { mode: 'ask', safe: ['отправить ответ'] } })).toEqual([]);
  });

  it('Enter в поле сообщения — отправка, в поиске — нет', () => {
    const send: AgentAction = { action: 'type', index: 4, text: 'Привет!', submit: true };
    expect(kinds(assess(send, 'textarea placeholder="Сообщение"', ['message']))).toEqual(['send']);
    expect(kinds(assess(send, 'div[contenteditable] "…"', ['message']))).toEqual(['send']);
    expect(assess({ ...send, submit: false }, 'textarea', ['message'])).toEqual([]);
    expect(assess(send, 'textarea placeholder="Поиск"', ['message', 'search'])).toEqual([]);
  });

  it('любое действие с элементом на странице оплаты', () => {
    const url = 'https://shop.example/checkout';
    expect(kinds(assess(click, 'button "Назад"', [], { url }))).toEqual(['payment']);
    expect(kinds(assess({ action: 'type', index: 1, text: 'Иванов', submit: false }, 'input "Фамилия"', [], { url }))).toEqual(['payment']);
    // одна причина «оплата», а не две
    expect(kinds(assess(click, 'button "Оплатить"', [], { url }))).toEqual(['payment']);
  });

  it('исключения сайта снимают проверку по словам и адресу', () => {
    const policy: SitePolicy = { mode: 'ask', safe: ['отправить ответ'] };
    expect(assess(click, 'button "Отправить ответ"', [], { policy })).toEqual([]);
    expect(kinds(assess(click, 'button "Отправить отзыв"', [], { policy }))).toEqual(['send']);
  });

  it('режим allow выключает всё; block — оценивает как обычно (запрещает цикл агента)', () => {
    expect(assess(click, 'button "Оплатить"', ['secret'], { policy: { mode: 'allow', safe: [] }, modelFlag: true })).toEqual([]);
    expect(kinds(assess(click, 'button "Оплатить"', [], { policy: { mode: 'block', safe: [] } }))).toEqual(['payment']);
  });

  it('флаг модели добавляет подтверждение к действиям с эффектом, но не к прокрутке', () => {
    expect(kinds(assess(click, 'button "Далее"', [], { modelFlag: true }))).toEqual(['model']);
    expect(kinds(assess({ action: 'navigate', url: 'https://x.example' }, undefined, [], { modelFlag: true }))).toEqual(['model']);
    expect(assess({ action: 'scroll', direction: 'down', amount: 1 }, undefined, [], { modelFlag: true })).toEqual([]);
    expect(assess({ action: 'done', result: '' }, undefined, [], { modelFlag: true })).toEqual([]);
  });

  it('свои словари из настроек', () => {
    const rules = { ...DEFAULT_RISK_RULES, send: 'сдать работу' };
    expect(kinds(assess(click, 'button "Сдать работу"', [], { rules }))).toEqual(['send']);
    expect(assess(click, 'button "Отправить"', [], { rules })).toEqual([]);
  });
});

describe('sitePolicyFor', () => {
  const note = (pattern: string, risk: SiteNote['risk'], safe = ''): SiteNote => ({ pattern, notes: '', hide: '', risk, safe, next: '' });
  it('запрет сильнее разрешения, исключения складываются', () => {
    const notes = [note('yandex.ru', 'allow', 'Отправить'), note('practicum.yandex.ru', 'ask', 'Проверить\n'), note('bank.example', 'block')];
    expect(sitePolicyFor('https://practicum.yandex.ru/learn', notes)).toEqual({ mode: 'allow', safe: ['отправить', 'проверить'] });
    expect(sitePolicyFor('https://bank.example/transfer', [...notes, note('bank.example', 'allow')]).mode).toBe('block');
    expect(sitePolicyFor('https://other.example', notes)).toEqual({ mode: 'ask', safe: [] });
  });
});

describe('riskFlags (сборщик)', () => {
  const html = (s: string) => {
    document.body.innerHTML = s;
    return (sel: string) => riskFlags(document.querySelector(sel)!);
  };

  it('форма входа: пароль, кнопка отправки, форма с паролем', () => {
    const f = html('<form><input id="u" type="email"><input id="p" type="password"><button id="b">Войти</button><button id="c" type="button">Показать</button></form>');
    expect(f('#u')).toEqual(['form-secret']);
    expect(f('#p')).toEqual(['secret', 'form-secret']);
    expect(f('#b')).toEqual(['submit', 'form-secret']);
    expect(f('#c')).toEqual(['form-secret']);
  });

  it('поле карты по autocomplete', () => {
    const f = html('<input id="n" autocomplete="cc-number"><input id="x" autocomplete="shipping cc-exp">');
    expect(f('#n')).toContain('secret');
    expect(f('#x')).toContain('secret');
  });

  it('поиск и поля сообщений', () => {
    const f = html(
      '<form role="search"><input id="q"></form><input id="s" type="search"><input id="ph" placeholder="Найти товар">' +
        '<textarea id="t"></textarea><div id="ce" contenteditable="true"></div><input id="plain">',
    );
    expect(f('#q')).toEqual(['search']);
    expect(f('#s')).toEqual(['search']);
    expect(f('#ph')).toEqual(['search']);
    expect(f('#t')).toEqual(['message']);
    expect(f('#ce')).toEqual(['message']);
    expect(f('#plain')).toEqual([]);
  });
});

describe('поле risky в ответе модели', () => {
  it('читается и не обязательно', () => {
    const r = parseAgentStep('{"reasoning":"r","expected_outcome":"e","risky":true,"actions":[{"action":"click","index":1}]}', 4);
    expect(r.ok && r.step.risky).toBe(true);
    const plain = parseAgentStep('{"reasoning":"r","expected_outcome":"e","actions":[{"action":"click","index":1}]}', 4);
    expect(plain.ok && plain.step.risky).toBeUndefined();
  });
});
