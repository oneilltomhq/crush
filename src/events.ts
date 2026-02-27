// src/events.ts

type Listener = (...args: any[]) => void;

export class EventEmitter {
  private events: Record<string, Listener[]> = {};

  on(eventName: string, listener: Listener) {
    if (!this.events[eventName]) {
      this.events[eventName] = [];
    }
    this.events[eventName].push(listener);
  }

  off(eventName: string, listener: Listener) {
    if (!this.events[eventName]) {
      return;
    }
    this.events[eventName] = this.events[eventName].filter(l => l !== listener);
  }

  emit(eventName: string, ...args: any[]) {
    if (!this.events[eventName]) {
      return;
    }
    this.events[eventName].forEach(l => l(...args));
  }

  once(eventName: string, listener: Listener) {
    const onceListener = (...args: any[]) => {
      listener(...args);
      this.off(eventName, onceListener);
    };
    this.on(eventName, onceListener);
  }
}

/** Global event bus for CDP events, usable from any module */
export const cdpEventBus = new EventEmitter();
