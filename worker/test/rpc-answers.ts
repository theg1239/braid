/**
 * A fake Artifacts binding whose answers behave like workerd's: every object a call returns carries a disposer, as
 * the runtime adds to RPC results. `undisposed()` names the calls whose answers were never disposed.
 */
export function recordingAnswers<T extends object>(binding: T): { binding: T; undisposed: () => string[] } {
  const open = new Map<object, string>();
  const answer = (method: string, value: unknown) => {
    if (value === null || typeof value !== 'object') return value;
    Object.defineProperty(value, Symbol.dispose, { value: () => { open.delete(value); }, configurable: true });
    open.set(value, method);
    return value;
  };
  const calls = <S extends object>(target: S, answered: (method: string, value: unknown) => unknown): S => new Proxy(target, { get(object, prop) {
    const value = Reflect.get(object, prop);
    return typeof value === 'function' && typeof prop === 'string' ? async (...args: unknown[]) => answered(prop, await Reflect.apply(value, object, args)) : value;
  } });
  return { binding: calls(binding, (method, value) => method === 'get' ? calls(value as object, answer) : answer(method, value)), undisposed: () => [...open.values()] };
}
