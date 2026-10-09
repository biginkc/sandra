import { describe, expect, it, vi } from 'vitest';
import { createCallLock } from './call-lock';

describe('createCallLock', () => {
  it('acquires when free and reports the holder source', () => {
    const lock = createCallLock();
    const a = Symbol('a');
    expect(lock.holder()).toBeNull();
    expect(lock.acquire('dialpad', a)).toBe(true);
    expect(lock.holder()).toBe('dialpad');
  });

  it('lets the same token re-acquire but refuses any other token, even of the same source', () => {
    const lock = createCallLock();
    const a = Symbol('a');
    const b = Symbol('b');
    lock.acquire('dialpad', a);
    expect(lock.acquire('dialpad', a)).toBe(true);
    expect(lock.acquire('dialpad', b)).toBe(false);
    expect(lock.acquire('softphone', b)).toBe(false);
    expect(lock.holder()).toBe('dialpad');
  });

  it('only the owner releases; a foreign release does nothing', () => {
    const lock = createCallLock();
    const a = Symbol('a');
    lock.acquire('softphone', a);
    lock.release(Symbol('foreign'));
    expect(lock.holder()).toBe('softphone');
    lock.release(a);
    expect(lock.holder()).toBeNull();
  });

  it('a double release is harmless and does not free a later holder', () => {
    const lock = createCallLock();
    const a = Symbol('a');
    const b = Symbol('b');
    lock.acquire('dialpad', a);
    lock.release(a);
    lock.release(a);
    expect(lock.acquire('softphone', b)).toBe(true);
    lock.release(a);
    expect(lock.holder()).toBe('softphone');
  });

  it('notifies subscribers only on real changes', () => {
    const lock = createCallLock();
    const listener = vi.fn();
    const unsubscribe = lock.subscribe(listener);
    const a = Symbol('a');
    lock.acquire('dialpad', a);
    lock.acquire('dialpad', a);
    lock.release(Symbol('x'));
    lock.release(a);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    lock.acquire('dialpad', a);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
