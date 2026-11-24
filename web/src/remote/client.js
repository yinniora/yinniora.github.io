import { t } from '../shared/i18n.js';
import { version as clientVersion } from '../../../package.json';
import { deviceFeatures } from './device-features.js';
import { authenticateRelay, relayICEAuthorization } from './relay-auth.js';
import {
  normalizeTransport,
  publicRemoteConfig,
  saveRemoteConfig,
  TRANSPORT_KEY,
} from './config.js';
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

// Connection budgets. The Mac answers within its own 25s budget; a relay
// allocation normally completes in well under a second.
export const SIGNAL_OPEN_TIMEOUT = 8000;
export const ANSWER_TIMEOUT = 20000;
export const CHANNEL_TIMEOUT = 20000;
export const RESUME_PROBE_TIMEOUT = 1500;
const PRIVATE_ROUTE_HEAD_START = 250;
const DIRECT_FALLBACK_TIMEOUT = 5000;
const routeFailures = new Set([
  'timeout',
  'relayFailed',
  'signalTimeout',
  'channelTimeout',
  'disconnected',
  'offline',
]);

// Short-lived TURN credentials are reused in memory (never persisted) so a
// reconnect in the same page skips the signed /ice round trip.
const ICE_CACHE_MARGIN = 15 * 60;
const ICE_CACHE_MAX_AGE = 90 * 60;
const iceCache = new Map();

function cachedICE(url) {
  const entry = iceCache.get(url);
  if (entry && entry.expires > Date.now() / 1000) return entry.servers;
  iceCache.delete(url);
  return null;
}

function rememberICE(url, servers) {
  const now = Math.floor(Date.now() / 1000);
  let expires = now + ICE_CACHE_MAX_AGE;
  for (const server of servers) {
    // TURN REST usernames are "<unix expiry>:<id>".
    const expiry = Number(String(server.username || '').split(':')[0]);
    if (Number.isFinite(expiry) && expiry > 0)
      expires = Math.min(expires, expiry - ICE_CACHE_MARGIN);
  }
  if (servers.length && expires > now) iceCache.set(url, { servers, expires });
}

export function forgetICE(url) {
  if (url) iceCache.delete(url);
  else iceCache.clear();
}
function connectionError(code) {
  const error = new Error(t(`remote.${code}`));
  error.code = code;
  return error;
}

function openSignalSocket(endpoint, signal, unavailable, createSocket) {
  return new Promise((resolve, reject) => {
    const socket = createSocket(endpoint);
    const fail = () => {
      clearTimeout(timer);
      reject(connectionError(unavailable));
    };
    const timer = setTimeout(() => {
      fail();
      socket.close();
    }, SIGNAL_OPEN_TIMEOUT);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = socket.onclose = fail;
    signal.addEventListener(
      'abort',
      () => {
        fail();
        socket.close();
      },
      { once: true },
    );
  });
}

export class RemoteClient extends EventTarget {
  constructor(
    config,
    { preference = 'auto', nativeLANSocket = window.__YUGOPI_LAN_SOCKET__ } = {},
  ) {
    super();
    this.config = validateRemoteConfig({ ...config });
    this.preference = normalizeTransport(preference);
    this.nativeLANSocket = typeof nativeLANSocket === 'function' ? nativeLANSocket : null;
    this.pending = new Map();
    this.connecting = null;
    this.resuming = null;
    this.identity = null;
    this.deviceIdentified = false;
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
    const now = performance.now();
    if (this.diagnostics.stage && this.phaseStarted != null) {
      this.diagnostics.phaseMs ||= {};
      this.diagnostics.phaseMs[this.diagnostics.stage] = Math.round(now - this.phaseStarted);
    }
    this.phaseStarted = now;
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
    if (!this.authorized || config?.fingerprint !== this.config.fingerprint) return;
    try {
      this.config = publicRemoteConfig({ ...this.config, ...config });
      saveRemoteConfig(this.config);
      this.dispatchEvent(new Event('configuration'));
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
    if (this.connecting) return this.connecting;
    if (this.blocked) throw new Error(t('remote.denied'));
    if (navigator.onLine === false && !this.config.lanUrl && !this.config.directUrl)
      throw connectionError('offline');
    const state = this.peer?.connectionState;
    if (
      this.channel?.readyState === 'open' &&
      this.authorized &&
      !['failed', 'closed'].includes(state)
    ) {
      if (this.connection === 'disconnected') return this.resume();
      return;
    }
    this.peer?.close();
    this.socket?.close();
    this.authorized = false;
    this.connection = this.everConnected ? 'reconnecting' : 'connecting';
    this.diagnostics = {
      clientVersion,
      mode: this.preference,
      startedAt: new Date().toISOString(),
    };
    this.transport = '';
    this.emitStatus();
    this.connecting = this.openConnection()
      .then(() => {
        this.phase('sync');
        this.refreshRoutes(AbortSignal.timeout(5000), true).catch(() => {});
        if (this.deviceIdentified) return;
        this.fetch('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'identify', features: deviceFeatures() }),
          signal: AbortSignal.timeout(8000),
          priority: 'low',
        })
          .then(async (response) => {
            await response.arrayBuffer();
            this.deviceIdentified = response.ok;
          })
          .catch(() => {});
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
      this.identity ||= getDeviceIdentity(this.config.fingerprint);
      identity = await this.identity;
    } catch {
      this.identity = null;
      const error = new Error(t('remote.storageUnavailable'));
      error.code = 'storageUnavailable';
      throw error;
    }
    const { lanUrl, directUrl, signalUrl, iceUrl } = this.config;
    const relayOnly = this.preference === 'vps' && !!signalUrl;
    const useTURN = !!iceUrl && this.preference !== 'tailscale';
    const unavailable = signalUrl ? 'relayFailed' : 'timeout';
    const routes = [];
    if (lanUrl && this.nativeLANSocket && !relayOnly) routes.push({ url: lanUrl, kind: 'lan' });
    if (directUrl && !relayOnly) routes.push({ url: directUrl, kind: 'direct' });
    if (signalUrl && (this.preference !== 'tailscale' || !routes.length))
      routes.push({ url: signalUrl, kind: 'relay' });
    if (!routes.length) throw connectionError('lanNeedsApp');

    for (;;) {
      const attempt = new AbortController();
      let selected;
      try {
        // A relay-only route can fetch credentials while its socket opens. With
        // private routes in the race, fetch them only if the relay is selected.
        const earlyTURN =
          useTURN && routes.length === 1 && routes[0].kind === 'relay'
            ? this.loadTURN(identity, attempt.signal, relayOnly)
            : null;
        const opening = this.openSignaling(routes, identity, attempt.signal, unavailable);
        opening.catch(() => {});
        let turn = earlyTURN ? await earlyTURN : null;
        this.phase('signal');
        selected = await opening;
        this.diagnostics.signalRoute = selected.route.kind;
        if (useTURN && selected.route.kind === 'relay' && !turn)
          turn = await this.loadTURN(identity, attempt.signal, relayOnly);

        const fastFallback =
          this.preference === 'auto' && routes.length > 1 && selected.route.kind !== 'relay';
        await this.negotiate(identity, selected.socket, {
          turn,
          relayOnly,
          signal: attempt.signal,
          unavailable,
          fastFallback,
        });
        return;
      } catch (error) {
        attempt.abort();
        if (
          this.preference !== 'auto' ||
          !selected ||
          routes.length < 2 ||
          this.blocked ||
          !routeFailures.has(error.code)
        )
          throw error;
        routes.splice(routes.indexOf(selected.route), 1);
        this.phase('fallback');
      }
    }
  }

  async openSignaling(routes, identity, signal, unavailable) {
    const attempts = routes.map(() => new AbortController());
    let privatePending = routes.filter(({ kind }) => kind !== 'relay').length;
    let startRelay;
    let relayTimer;
    const relayWait =
      this.preference === 'auto' && privatePending && routes.some(({ kind }) => kind === 'relay')
        ? new Promise((resolve) => {
            startRelay = resolve;
            relayTimer = setTimeout(resolve, PRIVATE_ROUTE_HEAD_START);
          })
        : null;
    signal.addEventListener(
      'abort',
      () => {
        attempts.forEach((attempt) => attempt.abort());
        startRelay?.();
      },
      { once: true },
    );
    try {
      const selected = await Promise.any(
        routes.map(async (route, index) => {
          const createSocket =
            route.kind === 'lan'
              ? (url) => this.nativeLANSocket(url, this.config.fingerprint)
              : (url) => new WebSocket(url);
          const attempt = attempts[index].signal;
          if (route.kind === 'relay' && relayWait) await relayWait;
          attempt.throwIfAborted();
          let socket;
          try {
            socket = await openSignalSocket(route.url, attempt, unavailable, createSocket);
            if (route.kind === 'relay') await authenticateRelay(socket, identity, this.config);
            return { socket, route, index };
          } catch (error) {
            socket?.close();
            if (route.kind !== 'relay' && --privatePending === 0) startRelay?.();
            throw error;
          }
        }),
      );
      attempts.forEach((attempt, index) => {
        if (index !== selected.index) attempt.abort();
      });
      return selected;
    } catch (error) {
      const code = error.errors?.some((failure) => failure?.code === 'relayDenied')
        ? 'relayDenied'
        : unavailable;
      const failure = connectionError(code);
      failure.cause = error;
      throw failure;
    } finally {
      clearTimeout(relayTimer);
      startRelay?.();
    }
  }

  async loadTURN(identity, signal, required) {
    const { iceUrl } = this.config;
    const cached = cachedICE(iceUrl);
    if (cached) {
      this.diagnostics.iceCached = true;
      return { servers: cached, fromCache: true };
    }

    this.phase('ice');
    try {
      const deadline = AbortSignal.timeout(8000);
      const options = {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any?.([signal, deadline]) || deadline,
      };
      if (this.config.relayAuth)
        options.headers = { Authorization: await relayICEAuthorization(identity, this.config) };
      let response = await originalFetch(iceUrl, options);
      this.diagnostics.iceHTTPStatus = response.status;
      if (response.status === 401 && !options.headers) {
        options.headers = { Authorization: await relayICEAuthorization(identity, this.config) };
        response = await originalFetch(iceUrl, options);
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
      const servers = validatedICEServers(data, new URL(iceUrl).hostname);
      rememberICE(iceUrl, servers);
      if (required && !servers.length) throw connectionError('iceUnavailable');
      return { servers };
    } catch (error) {
      const knownError = typeof error.code === 'string';
      this.diagnostics.iceError = knownError
        ? error.code
        : error.name === 'TimeoutError'
          ? 'timeout'
          : 'network';
      if (required) throw knownError ? error : connectionError('iceUnavailable');
      return { servers: [] };
    }
  }

  async negotiate(identity, socket, { turn, relayOnly, signal, unavailable, fastFallback }) {
    const peer = new RTCPeerConnection({
      iceServers: turn?.servers || [],
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
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
      if (peer.connectionState === 'connected') {
        if (this.authorized) {
          this.connection = 'connected';
          this.emitStatus();
        }
        this.updateTransport(peer);
      }
    };
    this.authorized = false;
    let answerTimer;
    let rejectAnswer;
    let approvalTimer;
    let rejectApproval;
    let gatherGrace;
    const approved = new Promise((resolve, reject) => {
      rejectApproval = reject;
      channel.onmessage = async (event) => {
        if (this.channel !== channel || signal.aborted) return;
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
            const proof = await createDeviceProof(
              identity,
              message.nonce,
              this.config.fingerprint,
              this.config.ticket || '',
            );
            if (this.channel === channel && !signal.aborted) channel.send(JSON.stringify(proof));
          } catch (error) {
            clearTimeout(approvalTimer);
            reject(error);
          }
        } else if (message.type === 'authorized') {
          clearTimeout(approvalTimer);
          try {
            saveRemoteConfig(this.config);
          } catch {
            reject(connectionError('storageUnavailable'));
            return;
          }
          this.authorized = true;
          this.connection = 'connected';
          this.everConnected = true;
          this.emitStatus();
          delete this.config.ticket;
          delete this.config.relayTicket;
          this.updateTransport(peer);
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
      const answerPromise = new Promise((resolve, reject) => {
        // Start the answer budget only after sending the offer, not during ICE gathering.
        rejectAnswer = reject;
        socket.addEventListener?.('close', () => reject(connectionError(unavailable)), {
          once: true,
        });
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
            reject(connectionError('offline'));
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
      this.phase('answer');
      if (socket.readyState != null && socket.readyState !== WebSocket.OPEN)
        throw connectionError(unavailable);
      socket.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }));
      answerTimer = setTimeout(
        () => rejectAnswer(connectionError('signalTimeout')),
        fastFallback ? DIRECT_FALLBACK_TIMEOUT : ANSWER_TIMEOUT,
      );
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
          fastFallback ? DIRECT_FALLBACK_TIMEOUT : CHANNEL_TIMEOUT,
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
      // Stale cached TURN credentials must not poison the next attempt.
      if (turn?.fromCache) forgetICE(this.config.iceUrl);
      rejectApproval(error);
      peer.close();
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

  async fetch(path, options = {}, reuseChannel = false) {
    const request = new Request(new URL(path, location.origin), options);
    request.signal.throwIfAborted();
    if (!reuseChannel) await this.connect();
    if (this.blocked || !this.authorized || this.channel?.readyState !== 'open')
      throw connectionError('disconnected');
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
        loading: options.priority !== 'low' && new URL(request.url).pathname !== '/events',
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

  async refreshRoutes(signal, reuseChannel = false) {
    const peer = this.peer;
    const config = this.config;
    const response = await this.fetch('/api/devices', { signal, priority: 'low' }, reuseChannel);
    if (!response.ok) throw connectionError('disconnected');
    const { connection } = await response.json();
    if (this.peer === peer && this.config === config) this.updateConfiguration(connection);
  }

  resume() {
    this.resuming ||= this.verifyChannel().finally(() => {
      this.resuming = null;
    });
    return this.resuming;
  }

  async verifyChannel() {
    if (navigator.onLine === false && !this.config.lanUrl && !this.config.directUrl)
      throw connectionError('offline');
    const peer = this.peer;
    if (
      !this.authorized ||
      this.channel?.readyState !== 'open' ||
      ['failed', 'closed'].includes(peer?.connectionState)
    )
      return this.connect();
    try {
      await this.refreshRoutes(AbortSignal.timeout(RESUME_PROBE_TIMEOUT), true);
      if (this.peer === peer && this.authorized) {
        this.connection = 'connected';
        this.emitStatus();
      }
    } catch {
      if (this.peer === peer) return this.reconnect(this.preference, { persist: false });
    }
  }

  async reconnect(preference = 'all', { persist = true } = {}) {
    if (this.connecting) await this.connecting.catch(() => {});
    this.preference = normalizeTransport(preference);
    try {
      if (persist) localStorage.setItem(TRANSPORT_KEY, this.preference);
    } catch {}
    this.authorized = false;
    this.peer?.close();
    this.socket?.close();
    return this.connect();
  }
}
