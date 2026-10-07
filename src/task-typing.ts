// Matrix typing is room-scoped, expires on the server and never carries task text.
export function taskTyping(send: (typing: boolean, timeout: number) => Promise<unknown>,
  allowed: () => Promise<boolean>, report: (error: unknown) => void, signal: AbortSignal) {
  let closed = false, pending: Promise<void> | undefined, closing: Promise<void> | undefined;
  let deliveries = 0, resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !closed && !signal.aborted;
  const update = async (typing: boolean) => {
    try {
      if (await allowed() && (!typing || (active() && !deliveries))) await send(typing, 30_000);
    } catch (error) { report(error); }
  };
  const enqueue = (typing: boolean) => {
    const next = (pending ? pending.then(() => update(typing)) : update(typing)).finally(() => {
      if (pending === next) pending = undefined;
    });
    pending = next;
    return next;
  };
  const refresh = () => {
    if (active() && !deliveries && !resumeTimer && !pending) void enqueue(true);
  };
  const cancelResume = () => { clearTimeout(resumeTimer); resumeTimer = undefined; };
  const message = async <T>(deliver: () => Promise<T>): Promise<T> => {
    if (!active()) return deliver();
    deliveries++;
    cancelResume();
    try {
      // Clear before sending: clients can hide typing on receipt, while Synapse
      // suppresses repeated true updates. Serialize after any in-flight renewal.
      await enqueue(false);
      signal.throwIfAborted();
      return await deliver();
    } finally {
      deliveries--;
      if (!deliveries && active()) {
        // Separate the new typing event from message processing in the client.
        // Other deliveries and task completion cancel this delayed restore.
        resumeTimer = setTimeout(() => { resumeTimer = undefined; refresh(); }, 250);
        resumeTimer.unref();
      }
    }
  };
  const timer = setInterval(refresh, 15_000);
  timer.unref();
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(timer);
    cancelResume();
    signal.removeEventListener('abort', onAbort);
    closing = enqueue(false);
    return closing;
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) void close();
  else refresh();
  return { close, message };
}
