declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, work: () => R): R;
    getStore(): T | undefined;
  }
}
