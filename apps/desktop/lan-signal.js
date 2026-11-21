const { createHash, timingSafeEqual } = require('node:crypto');
const tls = require('node:tls');
const WebSocket = require('ws');

const TRUSTED_VIEWER = 'https://yinniora.github.io';
const SIGNAL_LIMIT = 70 * 1024;
const SIGNAL_CHANNEL = 'yugo:lan:signal';
const EVENT_CHANNEL = 'yugo:lan:event';

function parseLANEndpoint(url, fingerprint) {
  if (typeof url !== 'string' || url.length > 80 || typeof fingerprint !== 'string' || fingerprint.length !== 95 ||
      !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/.test(fingerprint)) return null;
  const match = /^wss:\/\/((?:[0-9]{1,3}\.){3}[0-9]{1,3}):([1-9][0-9]{0,4})\/remote-signal$/.exec(url);
  if (!match || match[0] !== url) return null;
  const [, ip, portText] = match;
  const port = Number(portText);
  const octets = ip.split('.').map(Number);
  const [a, b] = octets;
  if (port > 65535 || octets.some((part) => part > 255) || octets.join('.') !== ip ||
      !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return null;
  return { url, ip, port, pin: Buffer.from(fingerprint.replaceAll(':', ''), 'hex') };
}

function normalizeSignal(content, expectedType) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > SIGNAL_LIMIT) return null;
  try {
    const { type, sdp } = JSON.parse(content);
    if (type === expectedType && typeof sdp === 'string' && sdp) return JSON.stringify({ type, sdp });
  } catch {
    // Invalid payloads close the connection.
  }
  return null;
}

function createPinnedLANSocket(endpoint, emit) {
  let transport;
  let socket;
  let timeout;
  let closed = false;
  let sentOffer = false;
  let receivedAnswer = false;

  function finish(failed) {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    socket?.terminate();
    transport?.destroy();
    if (failed) emit('error');
    emit('close');
  }

  return {
    start() {
      timeout = setTimeout(() => finish(true), 12000);
      // Do not provide this socket to HTTP or WebSocket until the TLS leaf
      // matches the identity pinned in the pairing QR code.
      transport = tls.connect({
        host: endpoint.ip, port: endpoint.port, family: 4,
        minVersion: 'TLSv1.2', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'],
      });
      transport.on('error', () => finish(true));
      transport.on('close', () => finish(!receivedAnswer));
      transport.once('secureConnect', () => {
        const leaf = transport.getPeerCertificate()?.raw;
        if (!leaf || !timingSafeEqual(createHash('sha256').update(leaf).digest(), endpoint.pin)) {
          finish(true);
          return;
        }
        socket = new WebSocket(endpoint.url, {
          createConnection: () => transport,
          origin: TRUSTED_VIEWER, followRedirects: false, perMessageDeflate: false,
          maxPayload: SIGNAL_LIMIT, handshakeTimeout: 10000,
        });
        socket.on('error', () => finish(true));
        socket.on('close', () => finish(false));
        socket.once('open', () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => finish(true), 35000);
          emit('open');
        });
        socket.on('message', (payload, binary) => {
          const answer = !binary && normalizeSignal(payload.toString('utf8'), 'answer');
          if (!sentOffer || receivedAnswer || !answer) {
            finish(true);
            return;
          }
          receivedAnswer = true;
          clearTimeout(timeout);
          emit('message', answer);
        });
      });
    },
    send(content) {
      const offer = normalizeSignal(content, 'offer');
      if (closed || socket?.readyState !== WebSocket.OPEN || sentOffer || !offer) {
        finish(true);
        return;
      }
      sentOffer = true;
      socket.send(offer, (error) => { if (error) finish(true); });
    },
    close() { finish(false); },
  };
}

function isTrustedDocument(value) {
  try {
    const url = new URL(value);
    return url.origin === TRUSTED_VIEWER && url.pathname === '/' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function connectViewerLAN(contents) {
  const sockets = new Map();
  const stop = () => {
    const previous = [...sockets.values()];
    sockets.clear();
    for (const socket of previous) socket.close();
  };
  const trustedFrame = (frame) => !contents.isDestroyed() && frame &&
    !frame.detached && frame === contents.mainFrame && frame.origin === TRUSTED_VIEWER && isTrustedDocument(frame.url);

  contents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) stop();
  });
  contents.on('render-process-gone', stop);
  contents.once('destroyed', stop);
  contents.ipc.on(SIGNAL_CHANNEL, (event, action, id, url, value) => {
    const frame = event.senderFrame;
    if (event.sender !== contents || !trustedFrame(frame) || typeof id !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) return;
    const emit = (type, content = '') => {
      if (trustedFrame(frame)) frame.send(EVENT_CHANNEL, id, type, content);
    };
    if (action === 'open') {
      if (sockets.has(id)) return;
      const endpoint = sockets.size < 3 && parseLANEndpoint(url, value);
      if (!endpoint) {
        emit('error');
        emit('close');
        return;
      }
      const socket = createPinnedLANSocket(endpoint, (type, content) => {
        if (sockets.get(id) !== socket) return;
        if (type === 'close') sockets.delete(id);
        emit(type, content);
      });
      sockets.set(id, socket);
      socket.start();
    } else if (action === 'send') {
      sockets.get(id)?.send(value);
    } else if (action === 'close') {
      sockets.get(id)?.close();
    }
  });
}

module.exports = { TRUSTED_VIEWER, connectViewerLAN, createPinnedLANSocket, parseLANEndpoint };
