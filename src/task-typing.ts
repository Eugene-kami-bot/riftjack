// Matrix typing is room-scoped, expires on the server and never carries task text.
export function taskTyping(send: (typing: boolean, timeout: number) => Promise<unknown>,
  allowed: () => Promise<boolean>, report: (error: unknown) => void, signal: AbortSignal) {
  let closed = false, pending: Promise<void> | undefined, closing: Promise<void> | undefined;
  const update = async (typing: boolean) => {
    try {
      if (await allowed() && (!typing || (!closed && !signal.aborted))) await send(typing, 30_000);
    } catch (error) { report(error); }
  };
  // A delivered message can clear typing even while an earlier renewal is in
  // flight. Coalesce those requests into one refresh after that renewal.
  let refreshRequested = false;
  const refresh = (afterMessage = false) => {
    if (closed || signal.aborted) return;
    if (pending) { refreshRequested ||= afterMessage; return; }
    pending = update(true).finally(() => {
      pending = undefined;
      if (refreshRequested) { refreshRequested = false; refresh(); }
    });
  };
  const timer = setInterval(() => refresh(), 15_000);
  timer.unref();
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(timer);
    signal.removeEventListener('abort', onAbort);
    // Serialize the clear after an in-flight renewal so it cannot restore typing.
    closing = (pending ?? Promise.resolve()).then(() => update(false));
    return closing;
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) void close();
  else refresh();
  return { close, refresh: () => refresh(true) };
}
