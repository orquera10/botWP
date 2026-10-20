/**
 * Buffers and debounces rapid consecutive incoming messages from the same chat,
 * combining fragmented lines (e.g. "hola", "?", "tenes cancha f5?") into a single prompt.
 */
export function createMessageBatcher({ debounceMs = 1500, maxWaitMs = 4000 } = {}) {
  const buffers = new Map();

  return {
    enqueue(key, text, onBatch, onNewMessage = () => {}) {
      let buffer = buffers.get(key);

      if (!buffer) {
        let resolve, reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });

        buffer = {
          texts: [text],
          timer: null,
          maxTimer: null,
          promise,
          resolve,
          reject
        };
        buffers.set(key, buffer);

        const flush = async () => {
          if (!buffers.has(key)) return;
          const current = buffers.get(key);
          buffers.delete(key);
          if (current.timer) clearTimeout(current.timer);
          if (current.maxTimer) clearTimeout(current.maxTimer);

          const combinedText = current.texts.filter(t => typeof t === 'string' && t.trim().length > 0).join('\n');
          try {
            const res = await onBatch(combinedText || text);
            current.resolve(res);
          } catch (err) {
            current.reject(err);
          }
        };

        buffer.flush = flush;
        if (maxWaitMs > 0) {
          buffer.maxTimer = setTimeout(flush, maxWaitMs);
        }
      } else {
        if (text && typeof text === 'string') {
          buffer.texts.push(text);
        }
        if (buffer.timer) clearTimeout(buffer.timer);
      }

      try { onNewMessage(); } catch {}
      buffer.timer = setTimeout(buffer.flush, debounceMs);
      return buffer.promise;
    },

    clear(key) {
      const buffer = buffers.get(key);
      if (buffer) {
        if (buffer.timer) clearTimeout(buffer.timer);
        if (buffer.maxTimer) clearTimeout(buffer.maxTimer);
        buffers.delete(key);
      }
    },

    hasPending(key) {
      return buffers.has(key);
    }
  };
}
