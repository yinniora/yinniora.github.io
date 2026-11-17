import { bytesToBase64 } from './identity.js';

async function signedProof(identity, message, ticket) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(message),
  );
  return {
    publicKey: await crypto.subtle.exportKey('jwk', identity.publicKey),
    signature: bytesToBase64(new Uint8Array(signature), true),
    ...(ticket ? { ticket } : {}),
  };
}
export async function relayICEAuthorization(identity, config) {
  const room = new URL(config.signalUrl).searchParams.get('room') || '';
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const proof = await signedProof(
    identity,
    `pi-relay-ice-v1:${room}:${timestamp}:${nonce}`,
    config.relayTicket,
  );
  return (
    'PiRelay ' +
    bytesToBase64(new TextEncoder().encode(JSON.stringify({ ...proof, timestamp, nonce })), true)
  );
}
export function authenticateRelay(socket, identity, config) {
  return new Promise((resolve, reject) => {
    let challenged = false;
    const fail = () => {
      const error = new Error('Relay access was not authorized');
      error.code = 'relayDenied';
      finish(error);
    };
    const finish = (error) => {
      clearTimeout(timer);
      socket.removeEventListener('message', message);
      socket.removeEventListener('close', fail);
      socket.removeEventListener('error', fail);
      if (error) reject(error);
      else resolve();
    };
    const message = async (event) => {
      let packet;
      try {
        packet = JSON.parse(event.data);
      } catch {
        return;
      }
      if (packet.type === 'relay-authorized' && challenged) finish();
      if (packet.type !== 'relay-challenge') return;
      challenged = true;
      if (!/^[a-f0-9]{64}$/i.test(packet.nonce || '')) {
        fail();
        return;
      }
      try {
        const room = new URL(config.signalUrl).searchParams.get('room') || '';
        const proof = await signedProof(
          identity,
          `pi-relay-client-v1:${room}:${packet.nonce}`,
          config.relayTicket,
        );
        socket.send(JSON.stringify({ type: 'relay-auth', ...proof }));
      } catch {
        fail();
      }
    };
    const timer = setTimeout(
      () => {
        if (config.relayAuth || challenged) fail();
        else finish();
      },
      config.relayAuth ? 10000 : 1500,
    );
    socket.addEventListener('message', message);
    socket.addEventListener('close', fail);
    socket.addEventListener('error', fail);
  });
}
