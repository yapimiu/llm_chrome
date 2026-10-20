export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Положение элемента относительно вьюпорта верхнего документа. */
export type Zone = 'above' | 'visible' | 'below';

/**
 * Признаки элемента для оценки риска действия. Модели не показываются — только классификатору
 * (lib/agent/risk.ts): решение «рискованно ли» принимает расширение, а не модель.
 */
export type ElementFlag =
  /** Поле пароля или банковской карты. */
  | 'secret'
  /** Кнопка, отправляющая форму. */
  | 'submit'
  /** Форма элемента содержит поле пароля/карты. */
  | 'form-secret'
  /** Поле поиска: Enter в нём — не «отправка сообщения». */
  | 'search'
  /** Многострочное поле (textarea, contenteditable): Enter в нём обычно отправляет сообщение. */
  | 'message';

export interface ElementInfo {
  /** Номер, по которому модель ссылается на элемент (с 1, в порядке документа). */
  index: number;
  /** localName: button, a, input, div… */
  tag: string;
  role?: string;
  /** Для input — его type. */
  type?: string;
  contentEditable?: boolean;
  /** Доступное имя / видимый текст (без обрезки — режет сериализатор). */
  name: string;
  /** Дополнительные атрибуты в порядке вывода: placeholder, value, href, hint… */
  attrs: Array<[string, string]>;
  /** checked, disabled, expanded, collapsed, selected, readonly. */
  states: string[];
  /** Варианты select (тексты). */
  options?: string[];
  optionsTotal?: number;
  zone: Zone;
  /** Расстояние до вьюпорта в px (0 для visible). */
  distance: number;
  /** Прямоугольник в координатах вьюпорта верхнего документа. */
  rect: Rect;
  inFrame?: boolean;
  inShadow?: boolean;
  flags?: ElementFlag[];
  /** Поле формы: текст кнопки, которую нажмёт Enter в нём (для оценки риска). */
  formSubmit?: string;
  /** Пользователь отметил это кнопкой «Далее» для сайта — модель увидит пометку. */
  next?: boolean;
  /** Внутри fixed/sticky-блока: панель интерфейса, а не содержимое страницы. */
  pinned?: boolean;
}

export interface ScrollInfo {
  x: number;
  y: number;
  maxY: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Прокручивается не окно, а внутренний контейнер (типично для SPA). */
  container?: boolean;
}

export interface CollectStats {
  /** Сколько элементов DOM обошли. */
  nodesVisited: number;
  /** Обход прерван по лимиту узлов. */
  walkTruncated: boolean;
  /** Интерактивные, но перекрытые другими элементами (модалка, оверлей). */
  covered: number;
  /** Интерактивные, но спрятанные по горизонтали / за пределами прокрутки iframe. */
  offscreen: number;
  /** Интерактивные, но невидимые (display/visibility/opacity/нулевой размер). */
  hidden: number;
  /** Скрытые заметкой пользователя для сайта («Скрыть от модели»). */
  userHidden: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  scroll: ScrollInfo;
  elements: ElementInfo[];
  /** Видимый текст страницы вне интерактивных элементов, строки через \n. */
  text: string;
  stats: CollectStats;
}
