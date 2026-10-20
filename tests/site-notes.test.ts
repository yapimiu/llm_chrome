import { messageText, type ChatMessage } from '@/lib/llm/client';
import { describe, expect, it } from 'vitest';
import { buildStepMessages } from '@/lib/agent/prompt';
import { hiddenNamesFor, noteMatches, siteNotesFor } from '@/lib/agent/site-notes';
import { sanitizeSettings } from '@/lib/settings';

const lesson = 'https://practicum.yandex.ru/learn/ap-frontend-st/courses/x/lessons/y/';

describe('noteMatches', () => {
  it.each([
    ['practicum.yandex.ru', lesson, true],
    ['https://practicum.yandex.ru/', lesson, true],
    ['www.practicum.yandex.ru', lesson, true],
    ['yandex.ru', lesson, true],
    ['practicum.yandex.ru/learn', lesson, true],
    ['practicum.yandex.ru/profile', lesson, false],
    ['ya.ru', lesson, false],
    ['ndex.ru', lesson, false],
    ['', lesson, false],
    ['practicum.yandex.ru', 'not a url', false],
  ])('%j на %s → %s', (pattern, url, expected) => {
    expect(noteMatches(url, pattern)).toBe(expected);
  });
});

describe('siteNotesFor', () => {
  it('собирает все подходящие заметки и пропускает пустые', () => {
    const notes = [
      { pattern: 'yandex.ru', notes: 'Общее для Яндекса', hide: '', risk: 'ask' as const, safe: '', next: '' },
      { pattern: 'practicum.yandex.ru/learn', notes: '«Узнать ответ» = проверить ответ', hide: 'Оценить\n  \nСбросить ', risk: 'ask' as const, safe: '', next: '' },
      { pattern: 'hh.ru', notes: 'Про hh', hide: '', risk: 'ask' as const, safe: '', next: '' },
      { pattern: 'practicum.yandex.ru', notes: '   ', hide: '', risk: 'ask' as const, safe: '', next: '' },
    ];
    expect(siteNotesFor(lesson, notes)).toBe('Общее для Яндекса\n«Узнать ответ» = проверить ответ');
    expect(siteNotesFor('https://hh.ru/vacancy/1', notes)).toBe('Про hh');
    expect(siteNotesFor('https://example.com', notes)).toBe('');
    expect(hiddenNamesFor(lesson, notes)).toEqual(['Оценить', 'Сбросить']);
    expect(hiddenNamesFor('https://hh.ru/', notes)).toEqual([]);
  });
});

describe('заметки в промпте и настройках', () => {
  it('идут в конце, после страницы, вне её блока', () => {
    const c = (buildStepMessages({
      systemTemplate: 'S',
      task: 'Пройди модуль',
      observation: 'obs',
      tabs: [],
      boundary: 'b',
      maxActions: 3,
      siteNotes: '«Узнать ответ» = проверить',
    })[1]! as ChatMessage).content as string;
    expect(c).toContain('SITE NOTES (from the user, about this website — they override your own guesses):\n«Узнать ответ» = проверить');
    // В самом конце, после страницы и перед просьбой ответить.
    expect(c.indexOf('SITE NOTES')).toBeGreaterThan(c.indexOf('END PAGE'));
    expect(c.trimEnd().endsWith('Reply with the JSON object for the next step.')).toBe(true);
  });

  it('без заметок блока нет', () => {
    const c = (buildStepMessages({ systemTemplate: 'S', task: 't', observation: 'o', tabs: [], boundary: 'b', maxActions: 3, siteNotes: '  ' })[1]! as ChatMessage).content as string;
    expect(c).not.toContain('SITE NOTES');
  });

  it('sanitizeSettings чистит мусор в заметках', () => {
    const s = sanitizeSettings({ siteNotes: [{ pattern: ' practicum.yandex.ru ', notes: 'x' }, 'мусор', { notes: 5 }] });
    expect(s.siteNotes).toEqual([
      { pattern: 'practicum.yandex.ru', notes: 'x', hide: '', risk: 'ask' as const, safe: '', next: '' },
      { pattern: '', notes: '', hide: '', risk: 'ask' as const, safe: '', next: '' },
    ]);
    expect(sanitizeSettings({}).siteNotes).toEqual([]);
  });
});
