import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_SETTINGS, activeProfile, isExternalProfile, loadSettings, modelLevels, parseExtraBody, profileOf, sanitizeSettings, saveSettings } from '@/lib/settings';

describe('sanitizeSettings', () => {
  it('мусор → дефолты', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('частичные настройки дополняются дефолтами', () => {
    const s = sanitizeSettings({ profiles: { slow: { model: 'qwen3:32b-q4' } }, agent: { autonomous: true } });
    expect(s.profiles.slow?.model).toBe('qwen3:32b-q4');
    expect(s.profiles.slow?.baseUrl).toBe(DEFAULT_SETTINGS.profiles.slow.baseUrl);
    expect(s.profiles.fast).toEqual(DEFAULT_SETTINGS.profiles.fast);
    expect(s.agent.autonomous).toBe(true);
    expect(s.agent.maxSteps).toBe(DEFAULT_SETTINGS.agent.maxSteps);
  });

  it('зажимает числа и округляет целые', () => {
    const s = sanitizeSettings({
      profiles: { fast: { temperature: 9, contextTokens: 10, requestTimeoutSec: '30.6' } },
      agent: { maxSteps: -5, loopThreshold: 2.7 },
    });
    expect(s.profiles.fast?.temperature).toBe(2);
    expect(s.profiles.fast?.contextTokens).toBe(1024);
    expect(s.profiles.fast?.requestTimeoutSec).toBe(31);
    expect(s.agent.maxSteps).toBe(1);
    expect(s.agent.loopThreshold).toBe(3);
  });

  it('неверные типы и enum-значения заменяются дефолтами', () => {
    const s = sanitizeSettings({
      activeProfile: 'turbo',
      profiles: { fast: { structuredOutput: 'grammar', temperature: 'abc', apiKey: 42 } },
      agent: { autonomous: 'yes' },
    });
    expect(s.activeProfile).toBe('fast');
    expect(s.profiles.fast?.structuredOutput).toBe('auto');
    expect(s.profiles.fast?.temperature).toBe(DEFAULT_SETTINGS.profiles.fast.temperature);
    expect(s.profiles.fast?.apiKey).toBe('');
    expect(s.agent.autonomous).toBe(false);
  });

  it('обрезает пробелы в адресе, ключе и модели', () => {
    const s = sanitizeSettings({ profiles: { fast: { baseUrl: ' http://h:1 ', apiKey: ' k ', model: ' m ' } } });
    expect(s.profiles.fast).toMatchObject({ baseUrl: 'http://h:1', apiKey: 'k', model: 'm' });
  });

  it('рассуждения, доп. параметры и действий за шаг', () => {
    const s = sanitizeSettings({ profiles: { fast: { thinking: true, extraBody: ' {"top_k":20} ' } }, agent: { maxActionsPerStep: 50 } });
    expect(s.profiles.fast?.thinking).toBe(true);
    expect(s.profiles.fast?.extraBody).toBe('{"top_k":20}');
    expect(s.profiles.slow?.thinking).toBe(true);
    expect(DEFAULT_SETTINGS.profiles.fast.thinking).toBe(false);
    expect(s.agent.maxActionsPerStep).toBe(10);
  });

  it('parseExtraBody', () => {
    expect(parseExtraBody('')).toEqual({});
    expect(parseExtraBody('{"min_p":0.05}')).toEqual({ min_p: 0.05 });
    expect(() => parseExtraBody('{oops}')).toThrow(/не JSON/);
    expect(() => parseExtraBody('"str"')).toThrow(/JSON-объектом/);
  });

  it('activeProfile возвращает выбранный профиль', () => {
    const s = sanitizeSettings({ activeProfile: 'slow' });
    expect(activeProfile(s)).toBe(s.profiles.slow);
  });
});

describe('хранение', () => {
  beforeEach(() => fakeBrowser.reset());

  it('без сохранённых данных отдаёт дефолты', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('сохраняет и читает обратно', async () => {
    const s = sanitizeSettings({ activeProfile: 'slow', profiles: { slow: { model: 'gpt-oss:20b' } } });
    await saveSettings(s);
    expect(await loadSettings()).toEqual(s);
  });

  it('хранит в storage.local, не в sync', async () => {
    await saveSettings(DEFAULT_SETTINGS);
    expect(await fakeBrowser.storage.local.get('settings')).toHaveProperty('settings');
    expect(await fakeBrowser.storage.sync.get('settings')).toEqual({});
  });
});

describe('профили: любое число, создание и удаление', () => {
  const custom = { label: 'Sonnet', provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'sonnet' };

  it('свои профили сохраняются вместе с порядком; новые поля берутся из значений по умолчанию', () => {
    const s = sanitizeSettings({ profileIds: ['fast', 'm1', 'slow'], profiles: { m1: custom } });
    expect(s.profileIds).toEqual(['fast', 'm1', 'slow']);
    expect(Object.keys(s.profiles)).toEqual(['fast', 'm1', 'slow']);
    expect(s.profiles.m1).toMatchObject({ label: 'Sonnet', model: 'sonnet', temperature: DEFAULT_SETTINGS.profiles.fast.temperature });
  });

  it('удалённый стандартный профиль не возвращается, активный переключается на существующий', () => {
    const s = sanitizeSettings({ profileIds: ['m1'], activeProfile: 'fast', profiles: { m1: custom } });
    expect(s.profileIds).toEqual(['m1']);
    expect(s.profiles.fast).toBeUndefined();
    expect(s.activeProfile).toBe('m1');
  });

  it('старые настройки (без profileIds) получают стандартные профили плюс найденные свои', () => {
    const s = sanitizeSettings({ profiles: { extra: custom } });
    expect(s.profileIds).toEqual(['fast', 'slow', 'cloud', 'extra']);
  });

  it('пустой список, мусор и дубли не ломают настройки', () => {
    expect(sanitizeSettings({ profileIds: [] }).profileIds).toEqual(DEFAULT_SETTINGS.profileIds);
    expect(sanitizeSettings({ profileIds: ['a', 'a', 5, '', 'b'], profiles: { a: custom, b: custom } }).profileIds).toEqual(['a', 'b']);
    expect(sanitizeSettings({ profileIds: 'x' }).profileIds).toEqual(['fast', 'slow', 'cloud']);
  });

  it('profileOf: неизвестный id (профиль удалён) заменяется активным', () => {
    const s = sanitizeSettings({ profileIds: ['m1'], profiles: { m1: custom } });
    expect(profileOf(s, 'gone')).toBe(s.profiles.m1);
  });
});

describe('автосмена моделей: настройки и цепочка', () => {
  const profiles = {
    a: { label: 'Qwen', baseUrl: 'http://192.168.0.6:8080', model: 'qwen' },
    b: { label: 'Big', baseUrl: 'http://192.168.0.6:8081', model: 'big' },
    c: { label: 'Cloud', baseUrl: 'https://api.anthropic.com/v1', model: 'sonnet' },
  };
  const base = { profileIds: ['a', 'b', 'c'], profiles, activeProfile: 'a' };

  it('по умолчанию выключена; цепочка чистится от несуществующих и повторов, пороги зажимаются', () => {
    expect(sanitizeSettings({}).escalation.enabled).toBe(false);
    const s = sanitizeSettings({ ...base, escalation: { enabled: true, chain: ['b', 'zzz', 'b', 'c'], failStreak: 99, returnAfter: 0 } });
    expect(s.escalation).toMatchObject({ enabled: true, chain: ['b', 'c'], failStreak: 10, returnAfter: 1 });
  });

  it('удаление профиля убирает его из цепочки при очистке', () => {
    const s = sanitizeSettings({ ...base, profileIds: ['a', 'c'], escalation: { enabled: true, chain: ['b', 'c'] } });
    expect(s.escalation.chain).toEqual(['c']);
  });

  it('isExternalProfile: домашняя сеть — своя, облако и чужие адреса — внешние', () => {
    const p = (patch: object) => sanitizeSettings({ profileIds: ['x'], profiles: { x: patch } }).profiles.x!;
    expect(isExternalProfile(p({ baseUrl: 'http://192.168.0.6:8080' }))).toBe(false);
    expect(isExternalProfile(p({ baseUrl: 'http://localhost:11434' }))).toBe(false);
    expect(isExternalProfile(p({ baseUrl: 'https://api.anthropic.com/v1' }))).toBe(true);
    expect(isExternalProfile(p({ provider: 'google', baseUrl: 'http://192.168.0.6' }))).toBe(true);
  });

  it('modelLevels: без автосмены — одна базовая; внешние только с разрешением; базовая в цепочке пропускается', () => {
    const off = sanitizeSettings(base);
    expect(modelLevels(off).map((l) => l.id)).toEqual(['a']);
    const on = sanitizeSettings({ ...base, escalation: { enabled: true, chain: ['a', 'b', 'c'], allowExternal: false } });
    expect(modelLevels(on).map((l) => l.id)).toEqual(['a', 'b']);
    const cloud = sanitizeSettings({ ...base, escalation: { enabled: true, chain: ['b', 'c'], allowExternal: true } });
    expect(modelLevels(cloud).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });
});
