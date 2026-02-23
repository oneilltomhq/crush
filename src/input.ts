/**
 * Input handler — converts DOM keyboard events to terminal data.
 *
 * Modelled after vendor/ghostty-web/lib/input-handler.ts but stripped
 * down: no mouse, no selection, no IME (yet). Just keyboard → bytes.
 */

import type { Ghostty, KeyEncoder } from 'ghostty-web';
import { Key, KeyAction, KeyEncoderOption, Mods } from 'ghostty-web';

/** Map KeyboardEvent.code → Ghostty Key enum */
const KEY_MAP: Record<string, Key> = {
  // Letters
  KeyA: Key.A, KeyB: Key.B, KeyC: Key.C, KeyD: Key.D, KeyE: Key.E,
  KeyF: Key.F, KeyG: Key.G, KeyH: Key.H, KeyI: Key.I, KeyJ: Key.J,
  KeyK: Key.K, KeyL: Key.L, KeyM: Key.M, KeyN: Key.N, KeyO: Key.O,
  KeyP: Key.P, KeyQ: Key.Q, KeyR: Key.R, KeyS: Key.S, KeyT: Key.T,
  KeyU: Key.U, KeyV: Key.V, KeyW: Key.W, KeyX: Key.X, KeyY: Key.Y,
  KeyZ: Key.Z,

  // Digits
  Digit0: Key.ZERO, Digit1: Key.ONE, Digit2: Key.TWO, Digit3: Key.THREE,
  Digit4: Key.FOUR, Digit5: Key.FIVE, Digit6: Key.SIX, Digit7: Key.SEVEN,
  Digit8: Key.EIGHT, Digit9: Key.NINE,

  // Special
  Enter: Key.ENTER, Escape: Key.ESCAPE, Backspace: Key.BACKSPACE,
  Tab: Key.TAB, Space: Key.SPACE,

  // Punctuation
  Minus: Key.MINUS, Equal: Key.EQUAL, BracketLeft: Key.BRACKET_LEFT,
  BracketRight: Key.BRACKET_RIGHT, Backslash: Key.BACKSLASH,
  Semicolon: Key.SEMICOLON, Quote: Key.QUOTE, Backquote: Key.GRAVE,
  Comma: Key.COMMA, Period: Key.PERIOD, Slash: Key.SLASH,

  // Function keys
  CapsLock: Key.CAPS_LOCK,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,

  // Navigation
  PrintScreen: Key.PRINT_SCREEN, ScrollLock: Key.SCROLL_LOCK,
  Pause: Key.PAUSE, Insert: Key.INSERT, Home: Key.HOME,
  PageUp: Key.PAGE_UP, Delete: Key.DELETE, End: Key.END,
  PageDown: Key.PAGE_DOWN,

  // Arrows
  ArrowRight: Key.RIGHT, ArrowLeft: Key.LEFT,
  ArrowDown: Key.DOWN, ArrowUp: Key.UP,

  // Keypad
  NumLock: Key.NUM_LOCK, NumpadDivide: Key.KP_DIVIDE,
  NumpadMultiply: Key.KP_MULTIPLY, NumpadSubtract: Key.KP_MINUS,
  NumpadAdd: Key.KP_PLUS, NumpadEnter: Key.KP_ENTER,
  Numpad0: Key.KP_0, Numpad1: Key.KP_1, Numpad2: Key.KP_2,
  Numpad3: Key.KP_3, Numpad4: Key.KP_4, Numpad5: Key.KP_5,
  Numpad6: Key.KP_6, Numpad7: Key.KP_7, Numpad8: Key.KP_8,
  Numpad9: Key.KP_9, NumpadDecimal: Key.KP_PERIOD,

  // International
  IntlBackslash: Key.INTL_BACKSLASH, ContextMenu: Key.CONTEXT_MENU,
};

/** Simple escape sequences for unmodified/shift-only special keys */
const SIMPLE_SEQUENCES: Partial<Record<Key, string>> = {
  [Key.ENTER]: '\r',
  [Key.BACKSPACE]: '\x7F',
  [Key.ESCAPE]: '\x1B',
  [Key.HOME]: '\x1B[H',
  [Key.END]: '\x1B[F',
  [Key.INSERT]: '\x1B[2~',
  [Key.DELETE]: '\x1B[3~',
  [Key.PAGE_UP]: '\x1B[5~',
  [Key.PAGE_DOWN]: '\x1B[6~',
  [Key.F1]: '\x1BOP', [Key.F2]: '\x1BOQ', [Key.F3]: '\x1BOR', [Key.F4]: '\x1BOS',
  [Key.F5]: '\x1B[15~', [Key.F6]: '\x1B[17~', [Key.F7]: '\x1B[18~', [Key.F8]: '\x1B[19~',
  [Key.F9]: '\x1B[20~', [Key.F10]: '\x1B[21~', [Key.F11]: '\x1B[23~', [Key.F12]: '\x1B[24~',
};

export interface InputHandlerOptions {
  ghostty: Ghostty;
  container: HTMLElement;
  onData: (data: string) => void;
  /** Optional: query terminal mode state (mode 1 = DECCKM app cursor) */
  getMode?: (mode: number) => boolean;
}

export class InputHandler {
  private encoder: KeyEncoder;
  private container: HTMLElement;
  private onData: (data: string) => void;
  private getMode?: (mode: number) => boolean;
  private keydownHandler: (e: KeyboardEvent) => void;
  private pasteHandler: (e: ClipboardEvent) => void;

  constructor(opts: InputHandlerOptions) {
    this.encoder = opts.ghostty.createKeyEncoder();
    this.container = opts.container;
    this.onData = opts.onData;
    this.getMode = opts.getMode;

    this.keydownHandler = this.handleKeyDown.bind(this);
    this.pasteHandler = this.handlePaste.bind(this);

    // Make container focusable
    if (!this.container.hasAttribute('tabindex')) {
      this.container.setAttribute('tabindex', '0');
    }
    this.container.style.outline = 'none';

    this.container.addEventListener('keydown', this.keydownHandler);
    this.container.addEventListener('paste', this.pasteHandler);
    this.container.focus();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Composition / IME — skip
    if (e.isComposing || e.keyCode === 229) return;

    // Allow browser paste (Ctrl+V / Cmd+V)
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return;

    // Printable character without modifiers → send directly
    if (this.isPrintable(e)) {
      e.preventDefault();
      this.onData(e.key);
      return;
    }

    const key = KEY_MAP[e.code];
    if (key === undefined) return;

    const mods = this.extractMods(e);

    // Tab with shift → backtab
    if (key === Key.TAB && (mods & Mods.SHIFT)) {
      e.preventDefault();
      this.onData('\x1b[Z');
      return;
    }

    // Simple sequence (no modifiers or shift-only)
    if (mods === Mods.NONE || mods === Mods.SHIFT) {
      const seq = SIMPLE_SEQUENCES[key];
      if (seq !== undefined) {
        e.preventDefault();
        this.onData(seq);
        return;
      }
    }

    // Everything else → use Ghostty encoder (handles Ctrl+key, arrow modes, etc.)
    try {
      if (this.getMode) {
        this.encoder.setOption(
          KeyEncoderOption.CURSOR_KEY_APPLICATION,
          this.getMode(1),
        );
      }

      const utf8 =
        e.key.length === 1 && e.key.charCodeAt(0) < 128
          ? e.key.toLowerCase()
          : undefined;

      const encoded = this.encoder.encode({
        action: KeyAction.PRESS,
        key,
        mods,
        utf8,
      } as any);

      if (encoded.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        this.onData(new TextDecoder().decode(encoded));
      }
    } catch (err) {
      console.warn('Key encode failed:', e.code, err);
    }
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) this.onData(text);
  }

  private isPrintable(e: KeyboardEvent): boolean {
    if (e.ctrlKey && !e.altKey) return false;
    if (e.altKey && !e.ctrlKey) return false;
    if (e.metaKey) return false;
    return e.key.length === 1;
  }

  private extractMods(e: KeyboardEvent): Mods {
    let m = Mods.NONE;
    if (e.shiftKey) m |= Mods.SHIFT;
    if (e.ctrlKey) m |= Mods.CTRL;
    if (e.altKey) m |= Mods.ALT;
    if (e.metaKey) m |= Mods.SUPER;
    return m;
  }

  dispose(): void {
    this.container.removeEventListener('keydown', this.keydownHandler);
    this.container.removeEventListener('paste', this.pasteHandler);
  }
}
