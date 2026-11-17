import { t } from '../shared/i18n.js';
import {
  base64ToBytes,
  bytesToBase64,
  createDeviceProof,
  getDeviceIdentity,
  validateRemoteConfig,
  verifyRemoteSDP,
  validatedICEServers,
} from './identity.js';

const originalFetch = window.fetch.bind(window);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteClient {
  constructor(config) {
    this.config = validateRemoteConfig(config);
    this.pending = new Map();
    this.connecting = null;
    this.peer = null;
    this.channel = null;
    this.blocked = false;
  }

  async connect() {
    if (this.channel?.readyState === 'open' && this.authorized) return;
    if (this.blocked) throw new Error(t('remote.denied'));
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async openConnection() {
    const identity = await getDeviceIdentity(this.config.fingerprint);
    let iceServers = [];
    try {
      const response = await originalFetch(this.config.iceUrl, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new Error('ICE response too large');
        }
        chunks.push(value);
      }
      const data = JSON.parse(await new Blob(chunks).text());
      iceServers = validatedICEServers(data, new URL(this.config.iceUrl).hostname);
    } catch {
      /* Direct candidates may still connect over Tailscale or LAN. */
    }
    const peer = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: this.preference === 'remote' ? 'relay' : 'all',
    });
    const channel = peer.createDataChannel('pi-workspace-v1', { ordered: true });
    this.peer = peer;
    this.channel = channel;
    this.authorized = false;
    let socket;
    const approved = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(t('remote.timeout'))), 45000);
      channel.onmessage = async (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'challenge') {
          try {
            if (message.fingerprint !== this.config.fingerprint)
              throw new Error(t('remote.identityFailed'));
            channel.send(
              JSON.stringify(
                await createDeviceProof(
                  identity,
                  message.nonce,
                  this.config.fingerprint,
                  this.config.ticket || '',
                ),
              ),
            );
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        } else if (message.type === 'authorized') {
          clearTimeout(timeout);
          this.authorized = true;
          delete this.config.ticket;
          localStorage.setItem('pi-remote:config-v1', JSON.stringify(this.config));
          if (location.hash.startsWith('#pair='))
            history.replaceState({}, '', location.pathname + location.search);
          resolve();
        } else if (message.type === 'denied') {
          clearTimeout(timeout);
          this.blocked = true;
          reject(new Error(t('remote.denied')));
        } else this.receive(message);
      };
      channel.onclose = () => {
        clearTimeout(timeout);
        this.authorized = false;
        for (const request of this.pending.values()) {
          request.reject(new Error(t('remote.disconnected')));
          request.controller?.error(new Error(t('remote.disconnected')));
        }
        this.pending.clear();
        reject(new Error(t('remote.disconnected')));
      };
    });
    approved.catch(() => {});
    try {
      const endpoints =
        this.config.directUrl && this.preference !== 'remote'
          ? [this.config.directUrl, this.config.signalUrl]
          : [this.config.signalUrl];
      const sockets = [];
      try {
        socket = await Promise.any(
          endpoints.map(
            (endpoint) =>
              new Promise((resolve, reject) => {
                const candidate = new WebSocket(endpoint);
                sockets.push(candidate);
                const timeout = setTimeout(() => {
                  candidate.close();
                  reject(new Error(t('remote.relayFailed')));
                }, 12000);
                candidate.onopen = () => {
                  clearTimeout(timeout);
                  resolve(candidate);
                };
                candidate.onerror = () => {
                  clearTimeout(timeout);
                  reject(new Error(t('remote.relayFailed')));
                };
                candidate.onclose = () => {
                  clearTimeout(timeout);
                  reject(new Error(t('remote.relayFailed')));
                };
              }),
          ),
        );
      } finally {
        for (const candidate of sockets) if (candidate !== socket) candidate.close();
      }
      const answerPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t('remote.timeout'))), 30000);
        socket.onmessage = (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === 'answer') {
            clearTimeout(timer);
            resolve(message.sdp);
          }
          if (message.type === 'offline') {
            clearTimeout(timer);
            reject(new Error(t('remote.offline')));
          }
        };
      });
      const gathered = new Promise((resolve) => {
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') resolve();
        };
      });
      await peer.setLocalDescription(await peer.createOffer());
      await Promise.race([gathered, delay(10000)]);
      socket.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }));
      const sdp = await answerPromise;
      verifyRemoteSDP(sdp, this.config.fingerprint);
      await peer.setRemoteDescription({ type: 'answer', sdp });
      await approved;
      this.socket = socket;
    } catch (error) {
      peer.close();
      socket?.close();
      throw error;
    }
  }

  async send(message) {
    while (this.channel?.bufferedAmount > 1024 * 1024) await delay(10);
    if (this.channel?.readyState !== 'open') throw new Error(t('remote.disconnected'));
    this.channel.send(JSON.stringify(message));
  }

  receive(message) {
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.type === 'response') {
      const headers = new Headers();
      for (const [key, values] of Object.entries(message.headers || {}))
        for (const value of values) headers.append(key, value);
      const bodyless = [204, 205, 304].includes(message.status) || request.method === 'HEAD';
      const stream = bodyless
        ? null
        : new ReadableStream({
            start: (controller) => {
              request.controller = controller;
            },
            pull: () => this.send({ type: 'window', id: message.id, size: 16384 }).catch(() => {}),
            cancel: () => {
              this.send({ type: 'cancel', id: message.id }).catch(() => {});
              this.pending.delete(message.id);
            },
          });
      request.resolve(new Response(stream, { status: message.status, headers }));
    } else if (message.type === 'data') request.controller?.enqueue(base64ToBytes(message.data));
    else if (message.type === 'end') {
      request.controller?.close();
      this.pending.delete(message.id);
    }
  }

  async fetch(path, options = {}) {
    await this.connect();
    const request = new Request(new URL(path, location.origin), options);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
    if (body.length > 36 * 1024 * 1024) throw new Error(t('remote.tooLarge'));
    const id = crypto.randomUUID();
    const response = new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject, method: request.method }),
    );
    const abort = () => {
      this.send({ type: 'cancel', id }).catch(() => {});
      const pending = this.pending.get(id);
      pending?.reject(new DOMException('Aborted', 'AbortError'));
      pending?.controller?.error(new DOMException('Aborted', 'AbortError'));
      this.pending.delete(id);
    };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return response;
    }
    try {
      await this.send({
        type: 'request',
        id,
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: Object.fromEntries([...request.headers].map(([key, value]) => [key, [value]])),
        size: body.length,
      });
      for (let offset = 0; offset < body.length; offset += 16384)
        await this.send({
          type: 'body',
          id,
          data: bytesToBase64(body.subarray(offset, offset + 16384)),
        });
      await this.send({ type: 'body-end', id });
    } catch (error) {
      this.pending.get(id)?.reject(error);
      this.pending.delete(id);
    }
    return response;
  }

  reconnect(preference = 'all') {
    this.preference = preference;
    this.peer?.close();
    this.socket?.close();
    return this.connect();
  }
}
