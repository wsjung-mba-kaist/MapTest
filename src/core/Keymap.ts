/**
 * The one table of keyboard shortcuts: which key code fires which action, the gamepad button that mirrors it, and
 * the label the help panel / hint bar show. App binds `Input.onKey` from it, Input builds its gamepad map from it,
 * and the UI copy is derived from it — so a shortcut cannot change in one place and keep its old key in another
 * (the README table is the authoritative reference; keep it in step).
 */
export type ActionId =
  | 'escape' | 'help' | 'menu' | 'gpu' | 'fly' | 'time' | 'nextTime' | 'weather' | 'share' | 'screenshot' | 'minimap'
  | 'places' | 'card' | 'lift' | 'mute' | 'timeBack' | 'timeForward' | 'landmark';

export interface KeyBinding {
  action: ActionId;
  /** KeyboardEvent.code values (`Digit1`..`Digit8` are matched by the `landmark` regex, not listed) */
  codes: readonly string[];
  /** Gamepad button index that emits the first code (standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 8 Back, 9 Start) */
  gamepad?: number;
  /** key as shown in the help panel */
  key: string;
  /** Korean description for the help panel */
  label: string;
}

export const KEYMAP: readonly KeyBinding[] = [
  { action: 'escape', codes: ['Escape'], key: 'Esc', label: '마우스 해제 · 메뉴' },
  { action: 'help', codes: ['KeyH'], gamepad: 1, key: 'H', label: '도움말 (열린 채 한 번 더: 진단 정보 표시)' },
  { action: 'menu', codes: ['Menu'], key: '⋯', label: '일시정지 메뉴 (터치)' },
  { action: 'gpu', codes: ['KeyG'], key: 'G', label: 'GPU 선택 패널' },
  { action: 'fly', codes: ['KeyF'], gamepad: 3, key: 'F', label: '비행 모드 켜기/끄기 · 비행 중 Q / E 하강·상승, Shift 5배속' },
  { action: 'time', codes: ['KeyT'], gamepad: 9, key: 'T', label: '시간 패널 (슬라이더 · 프리셋)' },
  { action: 'nextTime', codes: ['KeyN'], gamepad: 2, key: 'N', label: '시간대 순환: 새벽 → 낮 → 오후 → 노을 → 야경 → 심야' },
  { action: 'weather', codes: ['KeyR'], key: 'R', label: '날씨 순환: 맑음 → 흐림 → 비 → 안개' },
  { action: 'share', codes: ['KeyP'], key: 'P', label: '현재 위치·시점·시각을 담은 링크 복사' },
  { action: 'screenshot', codes: ['KeyO'], key: 'O', label: '스크린샷 PNG 저장' },
  { action: 'minimap', codes: ['KeyM'], gamepad: 8, key: 'M', label: '미니맵 순환: 숨김 → 320 m → 800 m → 1.5 km' },
  { action: 'places', codes: ['KeyL'], gamepad: 4, key: 'L', label: '명소 목록' },
  { action: 'card', codes: ['KeyI'], gamepad: 5, key: 'I', label: '명소 카드 펼치기/접기' },
  { action: 'lift', codes: ['KeyE'], gamepad: 0, key: 'E', label: '승강기 (탑 기둥 발치 · 각 층 승강기 앞)' },
  { action: 'mute', codes: ['KeyV'], key: 'V', label: '소리 끄기/켜기' },
  { action: 'timeBack', codes: ['Comma'], key: ',', label: '15분 뒤로 (Shift: 1시간)' },
  { action: 'timeForward', codes: ['Period'], key: '.', label: '15분 앞으로 (Shift: 1시간)' },
  { action: 'landmark', codes: [], key: '1 – 8', label: '명소로 이동' },
];

const BY_CODE = new Map<string, ActionId>();
for (const b of KEYMAP) for (const c of b.codes) BY_CODE.set(c, b.action);

/** Action for a KeyboardEvent.code, with the landmark hotkey number for `Digit1`..`Digit8`. */
export function actionOf(code: string): { action: ActionId; hotkey?: number } | null {
  const a = BY_CODE.get(code);
  if (a) return { action: a };
  const d = /^Digit([1-8])$/.exec(code);
  return d ? { action: 'landmark', hotkey: Number(d[1]) } : null;
}

/** Gamepad button index → key code (what Input emits when the button is pressed). */
export function gamepadMap(): Record<number, string> {
  const m: Record<number, string> = {};
  for (const b of KEYMAP) if (b.gamepad !== undefined) m[b.gamepad] = b.codes[0];
  return m;
}
