const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const https = require('node:https');
const { networkInterfaces, tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');
const { TRUSTED_VIEWER, connectViewerLAN, createPinnedLANSocket, parseLANEndpoint } = require('./lan-signal');

const emptyPin = Array(32).fill('00').join(':');
const testEndpoint = 'wss://192.168.1.5:47620/remote-signal';

test('LAN signaling requires a canonical private IPv4 endpoint and SHA-256 pin', () => {
  assert.equal(parseLANEndpoint(testEndpoint, emptyPin).pin.length, 32);
  assert.ok(parseLANEndpoint('wss://10.0.0.3:443/remote-signal', emptyPin));
  assert.ok(parseLANEndpoint('wss://172.31.0.3:65535/remote-signal', emptyPin));
  for (const url of [
    testEndpoint + '/', testEndpoint + '?', testEndpoint + '#', testEndpoint + '\n',
    'ws://192.168.1.5:47620/remote-signal', 'wss://192.168.1.5:47620/%72emote-signal',
    'wss://192.168.1.5:0/remote-signal', 'wss://192.168.1.5:65536/remote-signal',
    'wss://user@192.168.1.5:47620/remote-signal', 'wss://192.168.001.5:47620/remote-signal',
    'wss://127.0.0.1:47620/remote-signal', 'wss://100.64.0.1:47620/remote-signal',
    'wss://8.8.8.8:47620/remote-signal', 'wss://172.32.1.1:47620/remote-signal',
    'wss://10.0.0:47620/remote-signal', 'wss://[fd01::1]:47620/remote-signal',
    'wss://localhost:47620/remote-signal',
  ]) assert.equal(parseLANEndpoint(url, emptyPin), null, url);
  assert.equal(parseLANEndpoint(testEndpoint, emptyPin + '\n'), null);
  assert.equal(parseLANEndpoint(testEndpoint, emptyPin.replace('00', 'AA')), null);
});

test('only the trusted viewer main frame can call the local signaling bridge', () => {
  const sent = [];
  const frame = { origin: TRUSTED_VIEWER, url: TRUSTED_VIEWER + '/', send: (...args) => sent.push(args) };
  const contents = new EventEmitter();
  contents.ipc = new EventEmitter();
  contents.mainFrame = frame;
  contents.isDestroyed = () => false;
  connectViewerLAN(contents);

  const request = (sender, senderFrame) => contents.ipc.emit('yugo:lan:signal',
    { sender, senderFrame }, 'open', '01c49e90-0143-4bbc-a884-5d43926ecc39', 'invalid', emptyPin);
  request({}, frame);
  request(contents, { ...frame });
  frame.detached = true;
  request(contents, frame);
  frame.detached = false;
  frame.url = TRUSTED_VIEWER + '/other-project/';
  request(contents, frame);
  frame.url = TRUSTED_VIEWER + '.evil.invalid/';
  request(contents, frame);
  assert.deepEqual(sent, []);

  frame.url = TRUSTED_VIEWER + '/#pair=example';
  frame.origin = 'null';
  request(contents, frame);
  assert.deepEqual(sent, []);

  frame.origin = TRUSTED_VIEWER;
  request(contents, frame);
  assert.deepEqual(sent.map(([, , event]) => event), ['error', 'close']);
});

test('real TLS grants an upgrade only to the exact leaf and forbids redirects', { timeout: 12000 }, async (t) => {
  const ip = Object.values(networkInterfaces()).flat().map((iface) => iface.address)
    .find((candidate) => parseLANEndpoint(`wss://${candidate}:90/remote-signal`, emptyPin));
  if (!ip) return t.skip('Private IPv4 interface unavailable');
  const fixture = mkdtempSync(path.join(tmpdir(), 'yugopi-lan-test-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1',
      '-nodes', '-subj', '/CN=YuGoLANTest', '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: fixture, stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('OpenSSL unavailable');
    throw error;
  }
  const cert = readFileSync(path.join(fixture, 'cert.pem'));
  const key = readFileSync(path.join(fixture, 'key.pem'));
  const pin = new X509Certificate(cert).fingerprint256.toLowerCase();
  const server = https.createServer({ key, cert });
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  let shouldRedirect = false;
  server.on('upgrade', (request, connection, head) => {
    upgrades++;
    assert.equal(request.headers.origin, TRUSTED_VIEWER);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.url, '/remote-signal');
    if (shouldRedirect) {
      connection.end(`HTTP/1.1 302 Redirect\r\nLocation: https://${ip}:${server.address().port}/other\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, connection, head, (socket) => {
      socket.once('message', (data) => {
        assert.deepEqual(JSON.parse(data), { type: 'offer', sdp: 'offer-data' });
        socket.send(JSON.stringify({ type: 'answer', sdp: 'answer-data', ignored: 'other' }));
      });
    });
  });
  server.listen(0, ip);
  await once(server, 'listening');
  t.after(() => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.close();
  });
  const url = `wss://${ip}:${server.address().port}/remote-signal`;
  const exchange = (fingerprint) => new Promise((resolve) => {
    const events = [];
    const socket = createPinnedLANSocket(parseLANEndpoint(url, fingerprint), (type, content) => {
      events.push(type);
      if (type === 'open') socket.send(JSON.stringify({ type: 'offer', sdp: 'offer-data', ignored: 'other' }));
      if (type === 'message') {
        assert.deepEqual(JSON.parse(content), { type: 'answer', sdp: 'answer-data' });
        socket.close();
      }
      if (type === 'close') resolve(events);
    });
    socket.start();
  });

  assert.deepEqual(await exchange(emptyPin), ['error', 'close']);
  assert.equal(upgrades, 0);
  assert.deepEqual(await exchange(pin), ['open', 'message', 'close']);
  assert.equal(upgrades, 1);
  shouldRedirect = true;
  assert.deepEqual(await exchange(pin), ['error', 'close']);
  assert.equal(upgrades, 2);
});
