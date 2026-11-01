/** The sync API and the UI's cooperative API consume exactly the same deterministic calculation. */
export function finish<T>(steps: Generator<number, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Give input, paint and timers a turn at least every ~8 ms; microtasks alone do not let a page paint. */
export async function finishAsync<T>(steps: Generator<number, T>, progress?: (fraction: number) => void): Promise<T> {
  await nextTask();
  for (;;) {
    const until = performance.now() + 8;
    let fraction = 0;
    do {
      const step = steps.next();
      if (step.done) { progress?.(1); return step.value; }
      fraction = step.value;
    } while (performance.now() < until);
    progress?.(fraction);
    await nextTask();
  }
}
