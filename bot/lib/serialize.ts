const tails = new Map<string, Promise<unknown>>();

/** Run `fn` after any in-process call with the same key. A failure does not block the next one. */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
