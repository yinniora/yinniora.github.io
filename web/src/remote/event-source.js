export function remoteEventSource(client) {
  return class RemoteEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSED = 2;
      for (const type of ['open', 'message', 'error'])
        this.addEventListener(type, (event) => this[`on${type}`]?.(event));
      this.start();
    }
    async start() {
      this.abort = new AbortController();
      try {
        const response = await client.fetch(this.url, {
          headers: { Accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
        if (!response.ok) throw new Error('SSE unavailable');
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
          let separator;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            let type = 'message';
            const data = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim();
              if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (data.length) this.dispatchEvent(new MessageEvent(type, { data: data.join('\n') }));
          }
        }
      } catch {
        /* Existing live-reload controllers handle reconnect state. */
      }
      if (!this.closed) {
        this.readyState = 0;
        this.dispatchEvent(new Event('error'));
        this.timer = setTimeout(() => this.start(), 2000);
      }
    }
    close() {
      this.closed = true;
      this.readyState = 2;
      clearTimeout(this.timer);
      this.abort?.abort();
    }
  };
}
