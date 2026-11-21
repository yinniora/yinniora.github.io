const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.origin === 'https://yinniora.github.io' && location.pathname === '/' &&
    typeof contextBridge.executeInMainWorld === 'function') {
  const callbacks = new Map();
  ipcRenderer.on('yugo:lan:event', (_event, id, kind, content) => {
    const callback = callbacks.get(id);
    if (kind === 'close') callbacks.delete(id);
    callback?.(kind, content);
  });

  contextBridge.exposeInMainWorld('__YUGOPI_DESKTOP_SIGNAL__', {
    open(url, fingerprint, notify) {
      if (typeof url !== 'string' || url.length > 80 || typeof fingerprint !== 'string' ||
          fingerprint.length !== 95 || typeof notify !== 'function' || callbacks.size >= 3) {
        throw new TypeError('Invalid LAN signaling request');
      }
      const id = crypto.randomUUID();
      callbacks.set(id, notify);
      ipcRenderer.send('yugo:lan:signal', 'open', id, url, fingerprint);
      return {
        send(content) {
          if (typeof content !== 'string' || content.length > 71680) throw new TypeError('Invalid LAN signal');
          ipcRenderer.send('yugo:lan:signal', 'send', id, '', content);
        },
        close() { ipcRenderer.send('yugo:lan:signal', 'close', id); },
      };
    },
  });

  contextBridge.executeInMainWorld({ func: () => {
    const bridge = globalThis.__YUGOPI_DESKTOP_SIGNAL__;
    Object.defineProperty(globalThis, '__YUGOPI_LAN_SOCKET__', {
      value: (url, fingerprint) => {
        const socket = new EventTarget();
        let state = 0;
        const commands = bridge.open(url, fingerprint, (kind, content) => {
          if (kind === 'open') {
            if (state !== 0) return;
            state = 1;
          } else if (kind === 'close') {
            state = 3;
          } else if (kind === 'message' && state !== 1) {
            return;
          }
          const event = kind === 'message' ? new MessageEvent(kind, { data: content }) : new Event(kind);
          socket.dispatchEvent(event);
          socket['on' + kind]?.(event);
        });
        Object.defineProperties(socket, {
          url: { value: url },
          readyState: { get: () => state },
          send: { value: (content) => {
            if (state !== 1) throw new DOMException('Socket is not open', 'InvalidStateError');
            commands.send(content);
          } },
          close: { value: () => {
            if (state >= 2) return;
            state = 2;
            commands.close();
          } },
        });
        return socket;
      },
    });
  } });
}
