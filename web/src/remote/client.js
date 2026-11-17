import { t } from '../shared/i18n.js';
import { deviceFeatures } from './device-features.js';
import { authenticateRelay, relayICEAuthorization } from './relay-auth.js';
import { normalizeTransport, saveRemoteConfig, TRANSPORT_KEY } from './config.js';
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

export class RemoteClient extends EventTarget {
  constructor(config, { preference = 'auto' } = {}) {
    super();
    this.config = validateRemoteConfig(config);
    this.preference = normalizeTransport(preference);
    this.pending = new Map();
    this.connecting = null;
    this.peer = null;
    this.channel = null;
    this.blocked = false;
    this.connection = 'disconnected';
    this.everConnected = false;
    this.syncing = false;
    this.transport = '';
  }

  get status() {
    if (this.blocked) return 'blocked';
    if (this.connection !== 'connected') return this.connection;
    if (this.syncing) return 'syncing';
    return [...this.pending.values()].some((request) => request.loading) ? 'loading' : 'connected';
  }

  emitStatus() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  setSyncing(value) {
    this.syncing = value;
    this.emitStatus();
  }

  updateConfiguration(config) {
    if (config?.fingerprint !== this.config.fingerprint) return;
    try {
      this.config = validateRemoteConfig({ ...this.config, ...config });
      saveRemoteConfig(this.config);
    } catch {
      /* A metadata refresh cannot replace the scanned Mac identity. */
    }
  }

  async updateTransport(peer = this.peer) {
    if (!peer?.getStats) return;
    try {
      const stats = await peer.getStats();
      if (this.peer !== peer) return;
      const entries = [...stats.values()];
      const selected = entries.find(
        (entry) => entry.type === 'transport' && entry.selectedCandidatePairId,
      );
      const pair =
        (selected && stats.get(selected.selectedCandidatePairId)) ||
        entries.find(
          (entry) =>
            entry.type === 'candidate-pair' &&
            entry.state === 'succeeded' &&
            (entry.selected || entry.nominated),
        );
      if (!pair) return;
      const local = stats.get(pair.localCandidateId),
        remote = stats.get(pair.remoteCandidateId);
      if (!local || !remote) return;
      this.transport =
        local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'p2p';
      this.emitStatus();
    } catch {
      /* Keep the mode unknown until the browser exposes the selected pair. */
    }
  }

  async connect() {
    if (['failed', 'closed', 'disconnected'].includes(this.peer?.connectionState)) {
      this.peer.close();
      this.authorized = false;
    }
    if (this.channel?.readyState === 'open' && this.authorized) return;
    if (this.blocked) throw new Error(t('remote.denied'));
    if (this.connecting) return this.connecting;
    this.connection = this.everConnected ? 'reconnecting' : 'connecting';
    this.transport = '';
    this.emitStatus();
    this.connecting = this.openConnection()
      .then(async () => {
        this.setSyncing(true);
        try {
          const response = await this.fetch('/api/devices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'identify', features: deviceFeatures() }),
            signal: AbortSignal.timeout(8000),
          });
          await response.arrayBuffer();
        } catch {
          /* Older servers and offline metadata sync do not block the workspace. */
        } finally {
          this.setSyncing(false);
        }
      })
      .catch((error) => {
        this.connection = 'disconnected';
        this.emitStatus();
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async openConnection() {
    let identity;
    try {
      identity = await getDeviceIdentity(this.config.fingerprint);
    } catch {
      const error = new Error(t('remote.storageUnavailable'));
      error.code = 'storageUnavailable';
      throw error;
    }
    let iceServers = [];
    if (this.preference !== 'tailscale') {
      try {
        const options = {
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        };
        if (this.config.relayAuth)
          options.headers = { Authorization: await relayICEAuthorization(identity, this.config) };
        let response = await originalFetch(this.config.iceUrl, options);
        if (response.status === 401 && !options.headers) {
          options.headers = { Authorization: await relayICEAuthorization(identity, this.config) };
          response = await originalFetch(this.config.iceUrl, options);
        }
        if (!response.ok) throw new Error(t('remote.relayDenied'));
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
    }
    const peer = new RTCPeerConnection({
      iceServers: this.preference === 'tailscale' ? [] : iceServers,
      iceTransportPolicy: this.preference === 'vps' ? 'relay' : 'all',
    });
    const channel = peer.createDataChannel('pi-workspace-v1', { ordered: true });
    this.peer = peer;
    this.channel = channel;
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
        this.connection = 'disconnected';
        this.emitStatus();
      } else if (peer.connectionState === 'connecting') {
        this.connection = this.everConnected ? 'reconnecting' : 'connecting';
        this.emitStatus();
      }
      if (peer.connectionState === 'failed') peer.close();
      if (peer.connectionState === 'connected') this.updateTransport(peer);
    };
    this.authorized = false;
    let socket;
    let answerTimer;
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
          this.connection = 'connected';
          this.everConnected = true;
          this.emitStatus();
          delete this.config.ticket;
          delete this.config.relayTicket;
          this.updateTransport(peer);
          saveRemoteConfig(this.config);
          if (location.hash.startsWith('#pair='))
            history.replaceState({}, '', location.pathname + location.search);
          resolve();
        } else if (message.type === 'denied') {
          clearTimeout(timeout);
          this.blocked = true;
          this.emitStatus();
          reject(new Error(t('remote.denied')));
        } else this.receive(message);
      };
      channel.onclose = () => {
        clearTimeout(timeout);
        if (this.channel === channel) {
          this.authorized = false;
          this.connection = 'disconnected';
        }
        for (const [id, request] of this.pending) {
          if (request.channel !== channel) continue;
          request.reject(new Error(t('remote.disconnected')));
          request.controller?.error(new Error(t('remote.disconnected')));
          this.pending.delete(id);
        }
        this.emitStatus();
        reject(new Error(t('remote.disconnected')));
      };
    });
    approved.catch(() => {});
    try {
      const endpoints =
        this.preference === 'tailscale'
          ? [this.config.directUrl || this.config.signalUrl]
          : this.config.directUrl && this.preference === 'auto'
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
      const relayReady =
        this.config.directUrl && socket.url === new URL(this.config.directUrl).href
          ? Promise.resolve()
          : authenticateRelay(socket, identity, this.config);
      relayReady.catch(() => {});
      const answerPromise = new Promise((resolve, reject) => {
        answerTimer = setTimeout(() => reject(new Error(t('remote.timeout'))), 30000);
        socket.onmessage = (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === 'answer') {
            clearTimeout(answerTimer);
            resolve(message.sdp);
          }
          if (message.type === 'offline') {
            clearTimeout(answerTimer);
            reject(new Error(t('remote.offline')));
          }
        };
      });
      answerPromise.catch(() => {});
      const gathered = new Promise((resolve) => {
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') resolve();
        };
      });
      await peer.setLocalDescription(await peer.createOffer());
      await Promise.race([gathered, delay(10000)]);
      await relayReady;
      socket.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }));
      const sdp = await answerPromise;
      verifyRemoteSDP(sdp, this.config.fingerprint);
      await peer.setRemoteDescription({ type: 'answer', sdp });
      peer.sctp?.transport?.iceTransport?.addEventListener?.('selectedcandidatepairchange', () =>
        this.updateTransport(peer),
      );
      await approved;
      this.socket = socket;
    } catch (error) {
      clearTimeout(answerTimer);
      peer.close();
      socket?.close();
      if (error instanceof AggregateError)
        throw new Error(t('remote.relayFailed'), { cause: error });
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
      this.emitStatus();
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
      this.pending.set(id, {
        resolve,
        reject,
        method: request.method,
        channel: this.channel,
        loading: new URL(request.url).pathname !== '/events',
      }),
    );
    this.emitStatus();
    const abort = () => {
      this.send({ type: 'cancel', id }).catch(() => {});
      const pending = this.pending.get(id);
      pending?.reject(new DOMException('Aborted', 'AbortError'));
      pending?.controller?.error(new DOMException('Aborted', 'AbortError'));
      this.pending.delete(id);
      this.emitStatus();
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
      this.emitStatus();
    }
    return response;
  }

  reconnect(preference = 'all') {
    this.preference = normalizeTransport(preference);
    try {
      localStorage.setItem(TRANSPORT_KEY, this.preference);
    } catch {}
    this.peer?.close();
    this.socket?.close();
    return this.connect();
  }
}
