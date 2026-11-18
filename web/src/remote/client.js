import { t } from '../shared/i18n.js';
import { version as clientVersion } from '../../../package.json';
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
function connectionError(code) {
  const error = new Error(t(`remote.${code}`));
  error.code = code;
  return error;
}

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
    this.diagnostics = {};
  }

  phase(stage) {
    this.diagnostics.stage = stage;
    this.dispatchEvent(new CustomEvent('phase', { detail: stage }));
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
    this.diagnostics = {
      clientVersion,
      mode: this.preference,
      startedAt: new Date().toISOString(),
    };
    this.transport = '';
    this.emitStatus();
    this.connecting = this.openConnection()
      .then(async () => {
        this.phase('sync');
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
        error.diagnostics ||= { ...this.diagnostics };
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
    this.phase('identity');
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
      this.phase('ice');
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
        this.diagnostics.iceHTTPStatus = response.status;
        if (response.status === 401 && !options.headers) {
          options.headers = { Authorization: await relayICEAuthorization(identity, this.config) };
          response = await originalFetch(this.config.iceUrl, options);
          this.diagnostics.iceHTTPStatus = response.status;
        }
        if (!response.ok)
          throw connectionError(response.status === 401 ? 'relayDenied' : 'iceUnavailable');
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
        if (this.preference === 'vps' && !iceServers.length)
          throw connectionError('iceUnavailable');
      } catch (error) {
        const knownError = typeof error.code === 'string';
        this.diagnostics.iceError = knownError
          ? error.code
          : error.name === 'TimeoutError'
            ? 'timeout'
            : 'network';
        if (this.preference === 'vps') throw knownError ? error : connectionError('iceUnavailable');
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
    let rejectAnswer;
    let approvalTimer;
    let rejectApproval;
    let gatherGrace;
    const approved = new Promise((resolve, reject) => {
      rejectApproval = reject;
      channel.onmessage = async (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'challenge') {
          this.phase('auth');
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
            clearTimeout(approvalTimer);
            reject(error);
          }
        } else if (message.type === 'authorized') {
          clearTimeout(approvalTimer);
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
          clearTimeout(approvalTimer);
          this.blocked = true;
          this.emitStatus();
          reject(new Error(t('remote.denied')));
        } else this.receive(message);
      };
      channel.onclose = () => {
        clearTimeout(approvalTimer);
        if (this.channel === channel) {
          this.authorized = false;
          this.connection = 'disconnected';
        }
        for (const [id, request] of this.pending) {
          if (request.channel !== channel) continue;
          request.removeAbortListener();
          request.reject(new Error(t('remote.disconnected')));
          request.controller?.error(new Error(t('remote.disconnected')));
          this.pending.delete(id);
        }
        this.emitStatus();
        reject(
          connectionError(this.diagnostics.stage === 'auth' ? 'authIncomplete' : 'disconnected'),
        );
      };
    });
    approved.catch(() => {});
    try {
      this.phase('signal');
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
        // Start the answer budget only after sending the offer, not during ICE gathering.
        rejectAnswer = reject;
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
        peer.onicecandidate = (event) => {
          if (event.candidate?.type === 'relay' && !gatherGrace)
            gatherGrace = setTimeout(resolve, 400);
        };
      });
      this.phase('gathering');
      await peer.setLocalDescription(await peer.createOffer());
      await Promise.race([gathered, delay(10000)]);
      clearTimeout(gatherGrace);
      this.diagnostics.localRelayCandidates = (
        peer.localDescription.sdp.match(/ typ relay/g) || []
      ).length;
      await relayReady;
      this.phase('answer');
      socket.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }));
      answerTimer = setTimeout(() => rejectAnswer(connectionError('signalTimeout')), 30000);
      const sdp = await answerPromise;
      clearTimeout(answerTimer);
      this.diagnostics.remoteRelayCandidates = (sdp.match(/ typ relay/g) || []).length;
      verifyRemoteSDP(sdp, this.config.fingerprint);
      this.phase('channel');
      await peer.setRemoteDescription({ type: 'answer', sdp });
      peer.sctp?.transport?.iceTransport?.addEventListener?.('selectedcandidatepairchange', () =>
        this.updateTransport(peer),
      );
      if (!this.authorized)
        approvalTimer = setTimeout(
          () =>
            rejectApproval(
              connectionError(
                this.diagnostics.stage === 'auth' ? 'authIncomplete' : 'channelTimeout',
              ),
            ),
          35000,
        );
      await approved;
      clearTimeout(approvalTimer);
      this.socket = socket;
    } catch (error) {
      error.diagnostics = {
        ...this.diagnostics,
        peerState: peer.connectionState,
        iceState: peer.iceConnectionState,
      };
      clearTimeout(answerTimer);
      clearTimeout(approvalTimer);
      clearTimeout(gatherGrace);
      rejectApproval(error);
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
              request.removeAbortListener();
              this.send({ type: 'cancel', id: message.id }).catch(() => {});
              this.pending.delete(message.id);
              this.emitStatus();
            },
          });
      request.resolve(new Response(stream, { status: message.status, headers }));
    } else if (message.type === 'data') request.controller?.enqueue(base64ToBytes(message.data));
    else if (message.type === 'end') {
      request.removeAbortListener();
      request.controller?.close();
      this.pending.delete(message.id);
      this.emitStatus();
    }
  }

  async fetch(path, options = {}) {
    const request = new Request(new URL(path, location.origin), options);
    request.signal.throwIfAborted();
    await this.connect();
    request.signal.throwIfAborted();
    const body = ['GET', 'HEAD'].includes(request.method)
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
    if (body.length > 36 * 1024 * 1024) throw new Error(t('remote.tooLarge'));
    request.signal.throwIfAborted();
    const id = crypto.randomUUID();
    const abort = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      const error = request.signal.reason;
      this.pending.delete(id);
      pending.reject(error);
      pending.controller?.error(error);
      this.send({ type: 'cancel', id }).catch(() => {});
      this.emitStatus();
    };
    const removeAbortListener = () => request.signal.removeEventListener('abort', abort);
    const response = new Promise((resolve, reject) =>
      this.pending.set(id, {
        resolve,
        reject,
        method: request.method,
        channel: this.channel,
        loading: new URL(request.url).pathname !== '/events',
        removeAbortListener,
      }),
    );
    // A cancellation can arrive while a packet is still being sent.
    response.catch(() => {});
    request.signal.addEventListener('abort', abort, { once: true });
    this.emitStatus();
    try {
      request.signal.throwIfAborted();
      await this.send({
        type: 'request',
        id,
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: Object.fromEntries([...request.headers].map(([key, value]) => [key, [value]])),
        size: body.length,
      });
      for (let offset = 0; offset < body.length; offset += 16384) {
        request.signal.throwIfAborted();
        await this.send({
          type: 'body',
          id,
          data: bytesToBase64(body.subarray(offset, offset + 16384)),
        });
      }
      request.signal.throwIfAborted();
      await this.send({ type: 'body-end', id });
    } catch (error) {
      removeAbortListener();
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
