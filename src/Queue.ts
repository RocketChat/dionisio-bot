type Chain<T = any> = Promise<T>;

const store = new Map<string, Chain>();

const run = async <T = any>(key: string, fn: () => Promise<T>) => {
  const chain = store.get(key);

  if (!chain) {
    const p = fn();
    store.set(key, p);
    await p;

    return;
  }

  store.set(key, chain.finally(fn));

  await chain;
};
