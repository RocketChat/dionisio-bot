type Chain<T = unknown> = Promise<T>;

const store = new Map<string, Chain>();

export const run = async <T = unknown>(key: string, fn: () => Promise<T>) => {
  const chain = store.get(key);

  if (!chain) {
    const p = fn();
    store.set(key, p);
    await p;

    return;
  }

  const c = chain.finally(fn);

  store.set(key, c);

  await c;
};
