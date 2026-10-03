export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const abortableSleep: Sleep = (milliseconds, signal) => {
  if (signal.aborted) return Promise.resolve();

  return new Promise(resolve => {
    const timeout = setTimeout(finish, milliseconds);

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
};
