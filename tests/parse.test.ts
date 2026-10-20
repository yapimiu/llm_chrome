import { describe, expect, it } from 'vitest';
import { formatAction } from '@/lib/agent/actions';
import { findJsonObjects, normalizeAction, parseAgentStep, stripThinking } from '@/lib/agent/parse';

const ok = (text: string, max = 5) => {
  const r = parseAgentStep(text, max);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
};
const fail = (text: string, max = 5) => {
  const r = parseAgentStep(text, max);
  if (r.ok) throw new Error(`expected error, got: ${JSON.stringify(r.step)}`);
  return r.error;
};

describe('stripThinking', () => {
  it('убирает закрытые блоки рассуждений', () => {
    expect(stripThinking('<think>долго думаю {"x":1}</think>\n{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('<thinking>hmm</thinking>{"a":1}')).toBe('{"a":1}');
  });
  it('убирает незакрытый блок (обрыв по лимиту) и одинокий закрывающий тег', () => {
    expect(stripThinking('<think>думаю и не дошёл')).toBe('');
    expect(stripThinking('думаю без открывающего тега</think>{"a":1}')).toBe('{"a":1}');
  });
  it('gpt-oss harmony: берёт финальный канал', () => {
    expect(stripThinking('<|channel|>analysis<|message|>think<|end|><|start|>assistant<|channel|>final<|message|>{"a":1}<|return|>')).toBe('{"a":1}');
  });
});

describe('findJsonObjects', () => {
  it('находит объекты верхнего уровня с учётом строк и экранирования', () => {
    expect(findJsonObjects('text {"a":"}{"} more {"b":{"c":"\\"}"}} end')).toEqual(['{"a":"}{"}', '{"b":{"c":"\\"}"}}']);
  });
});

describe('parseAgentStep: формат', () => {
  it('эталонный ответ', () => {
    const r = ok('{"reasoning":"Надо войти","expected_outcome":"Откроется форма","actions":[{"action":"click","index":12}]}');
    expect(r.step).toEqual({ reasoning: 'Надо войти', expected_outcome: 'Откроется форма', actions: [{ action: 'click', index: 12 }] });
    expect(r.warnings).toEqual([]);
  });

  it('markdown-ограждение и текст вокруг', () => {
    const r = ok('Вот мой ответ:\n```json\n{"reasoning":"r","expected_outcome":"e","actions":[{"action":"go_back"}]}\n```\nУдачи!');
    expect(r.step.actions).toEqual([{ action: 'go_back' }]);
  });

  it('рассуждения в content перед JSON, с черновиком JSON внутри', () => {
    const r = ok('<think>может {"action":"click","index":1}? нет</think>{"reasoning":"r","expected_outcome":"","actions":[{"action":"click","index":2}]}');
    expect(r.step.actions).toEqual([{ action: 'click', index: 2 }]);
  });

  it('висячие запятые и «умные» кавычки', () => {
    const r = ok('{"reasoning":"r","expected_outcome":"e","actions":[{"action":"click","index":3,},],}');
    expect(r.step.actions).toEqual([{ action: 'click', index: 3 }]);
  });

  it('одно действие прямо в корне', () => {
    const r = ok('{"action":"click","index":"[7]","reasoning":"жму"}');
    expect(r.step).toEqual({ reasoning: 'жму', expected_outcome: '', actions: [{ action: 'click', index: 7 }] });
  });

  it('actions объектом, а не массивом; синонимы полей', () => {
    const r = ok('{"thought":"t","expected":"x","actions":{"type":"fill","element":"4","value":"привет","enter":true}}');
    expect(r.step).toEqual({ reasoning: 't', expected_outcome: 'x', actions: [{ action: 'type', index: 4, text: 'привет', submit: true }] });
  });

  it('вид {"click": {"index": 3}}', () => {
    expect(ok('{"reasoning":"","expected_outcome":"","actions":[{"click":{"index":3}}]}').step.actions).toEqual([{ action: 'click', index: 3 }]);
  });

  it('массив действий без обёртки', () => {
    expect(ok('[{"action":"scroll","direction":"down"},{"action":"wait","ms":500}]').step.actions).toEqual([
      { action: 'scroll', direction: 'down', amount: 1 },
      { action: 'wait', ms: 500 },
    ]);
  });

  it('берёт последний валидный объект, если их несколько', () => {
    const r = ok('Пример: {"actions":[{"action":"click","index":1}]}. Мой ответ: {"actions":[{"action":"click","index":9}]}');
    expect(r.step.actions).toEqual([{ action: 'click', index: 9 }]);
  });
});

describe('parseAgentStep: все действия', () => {
  it.each([
    ['{"action":"click","index":1}', { action: 'click', index: 1 }],
    ['{"action":"type","index":2,"text":"a@b.c"}', { action: 'type', index: 2, text: 'a@b.c', submit: false }],
    ['{"action":"select","index":3,"value":"Казань"}', { action: 'select', index: 3, value: 'Казань' }],
    ['{"action":"scroll","direction":"up","amount":2}', { action: 'scroll', direction: 'up', amount: 2 }],
    ['{"action":"navigate","url":"https://ya.ru"}', { action: 'navigate', url: 'https://ya.ru' }],
    ['{"action":"go_back"}', { action: 'go_back' }],
    ['{"action":"wait","ms":99999}', { action: 'wait', ms: 30000 }],
    ['{"action":"new_tab","url":"https://ya.ru"}', { action: 'new_tab', url: 'https://ya.ru' }],
    ['{"action":"switch_tab","tab_id":"42"}', { action: 'switch_tab', tab_id: 42 }],
    ['{"action":"extract","note":"цена 100 ₽"}', { action: 'extract', note: 'цена 100 ₽' }],
    ['{"action":"done","result":"Готово"}', { action: 'done', result: 'Готово' }],
    ['{"action":"ask_user","question":"Какой город?"}', { action: 'ask_user', question: 'Какой город?' }],
    ['{"action":"goto","url":"https://ya.ru"}', { action: 'navigate', url: 'https://ya.ru' }],
    ['{"action":"finish","answer":"42"}', { action: 'done', result: '42' }],
  ])('%s', (raw, expected) => {
    expect(ok(`{"actions":[${raw}]}`).step.actions).toEqual([expected]);
  });
});

describe('parseAgentStep: ошибки, понятные модели', () => {
  it('нет JSON', () => {
    expect(fail('Я нажму на кнопку войти')).toMatch(/no valid JSON/);
  });
  it('только рассуждения', () => {
    expect(fail('<think>думаю долго')).toMatch(/empty reply/);
  });
  it('неизвестное действие перечисляет допустимые', () => {
    expect(fail('{"actions":[{"action":"teleport","index":1}]}')).toMatch(/unknown action "teleport"; valid: click, type/);
  });
  it('новые действия: hover, press_key, drag, wait_for, прокрутка области', () => {
    const one = (json: string) => {
      const r = parseAgentStep(`{"actions":[${json}]}`, 4);
      if (!r.ok) throw new Error(r.error);
      return r.step.actions[0];
    };
    expect(one('{"action":"mouse_over","element":"[5]"}')).toEqual({ action: 'hover', index: 5 });
    expect(one('{"action":"press_key","key":"esc"}')).toEqual({ action: 'press_key', key: 'Escape' });
    expect(one('{"action":"key","key":"shift+tab"}')).toEqual({ action: 'press_key', key: 'Shift+Tab' });
    expect(one('{"action":"drag_and_drop","index":2,"to":7}')).toEqual({ action: 'drag', index: 2, to_index: 7 });
    expect(one('{"action":"wait_for","text":"Готово"}')).toEqual({ action: 'wait_for', text: 'Готово', timeout_ms: 10000 });
    expect(one('{"action":"wait_for","text":"x","timeout_ms":999999}')).toMatchObject({ timeout_ms: 30000 });
    expect(one('{"action":"scroll","direction":"down","index":4}')).toEqual({ action: 'scroll', direction: 'down', amount: 1, index: 4 });
    expect(one('{"action":"scroll","direction":"down"}')).toEqual({ action: 'scroll', direction: 'down', amount: 1 });
  });
  it('press_key не нажимает Enter и пробел — это клик или отправка', () => {
    expect(fail('{"actions":[{"action":"press_key","key":"Enter"}]}')).toMatch(/for Enter use "type"/);
    expect(fail('{"actions":[{"action":"press_key","key":" "}]}')).toMatch(/press_key/);
    expect(fail('{"actions":[{"action":"drag","index":1}]}')).toMatch(/to_index/);
  });
  it('нет обязательного поля', () => {
    expect(fail('{"actions":[{"action":"click"}]}')).toMatch(/actions\[0\]: "click" requires integer "index"/);
    expect(fail('{"actions":[{"action":"click","index":1},{"action":"type","index":2}]}')).toMatch(/actions\[1\]: "type" requires string "text"/);
  });
  it('индекс должен быть положительным целым', () => {
    expect(fail('{"actions":[{"action":"click","index":0}]}')).toMatch(/>= 1/);
    expect(fail('{"actions":[{"action":"click","index":"кнопка"}]}')).toMatch(/index/);
  });
  it('пустой список действий', () => {
    expect(fail('{"reasoning":"r","actions":[]}')).toMatch(/empty/);
  });
});

describe('parseAgentStep: обрезка цепочки', () => {
  it('после done и ask_user ничего не выполняется', () => {
    const r = ok('{"actions":[{"action":"done","result":"ok"},{"action":"click","index":1}]}');
    expect(r.step.actions).toEqual([{ action: 'done', result: 'ok' }]);
    expect(r.warnings[0]).toMatch(/dropped 1 action\(s\) after "done"/);
  });
  it('после смены страницы номера недействительны', () => {
    const r = ok('{"actions":[{"action":"type","index":1,"text":"q"},{"action":"navigate","url":"https://x"},{"action":"click","index":2}]}');
    expect(r.step.actions.map((a) => a.action)).toEqual(['type', 'navigate']);
  });
  it('лимит действий за шаг', () => {
    const actions = Array.from({ length: 6 }, (_, i) => `{"action":"click","index":${i + 1}}`).join(',');
    const r = ok(`{"actions":[${actions}]}`, 3);
    expect(r.step.actions).toHaveLength(3);
    expect(r.warnings[0]).toMatch(/limit of 3/);
  });
});

describe('normalizeAction', () => {
  it('не объект', () => {
    expect(normalizeAction('click')).toEqual({ ok: false, error: 'action must be a JSON object' });
  });
});

describe('formatAction', () => {
  it('коротко для UI', () => {
    expect(formatAction({ action: 'click', index: 12 })).toBe('click [12]');
    expect(formatAction({ action: 'type', index: 3, text: 'почта', submit: true })).toBe('type [3] "почта" ⏎');
    expect(formatAction({ action: 'scroll', direction: 'down', amount: 1 })).toBe('scroll down 1');
  });
});
