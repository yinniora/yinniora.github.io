// Tiny HTTP client for the per-session chat queue (/api/chat/queue).
// QueueStore depends on this for hydration + mutations; the runtime glue
// (steer-queue.js) calls through it for the user actions that mutate the
// queue (enqueue, remove, pause).
//
// All methods return a Promise; failures throw so callers can fall back to
// "best-effort" behaviour (the UI shows an error toast but the panel stays
// usable).

export function createQueueApi({ sessionId, fetchImpl = fetch } = {}) {
  if (!sessionId) throw new Error('createQueueApi: sessionId is required');
  const base = `/api/chat/queue?id=${encodeURIComponent(sessionId)}`;

  async function readJSON(resp) {
    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.json();
        detail = body?.error || '';
      } catch {
        /* ignore */
      }
      throw new Error(detail || `chat queue request failed (${resp.status})`);
    }
    return resp.json();
  }

  return {
    async list() {
      return readJSON(await fetchImpl(base, { headers: { Accept: 'application/json' } }));
    },
    async add(message, displayText, files = []) {
      const headers = { Accept: 'application/json' };
      let body;
      if (files.length) {
        body = new FormData();
        body.set('message', message);
        body.set('displayText', displayText || '');
        appendChatFiles(body, files);
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ message, displayText });
      }
      return readJSON(
        await fetchImpl(base, {
          method: 'POST',
          headers,
          body,
        }),
      );
    },
    async remove(position, { edit = false } = {}) {
      const url = `${base}&position=${encodeURIComponent(position)}${edit ? '&edit=1' : ''}`;
      return readJSON(await fetchImpl(url, { method: 'DELETE' }));
    },
    async sendNow(position) {
      return readJSON(
        await fetchImpl(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ action: 'send-now', position }),
        }),
      );
    },
    async setPaused(paused) {
      return readJSON(
        await fetchImpl(base, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ paused: !!paused }),
        }),
      );
    },
  };
}

export function appendChatFiles(body, files) {
  for (const file of files) {
    const image = /^image\/(png|jpeg|webp|gif)$/i.test(file.type);
    body.append(image ? 'images' : 'files', file);
  }
}
