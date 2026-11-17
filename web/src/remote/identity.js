export function normalizedFingerprint(value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(normalized))
    throw new Error('Invalid Mac identity');
  return normalized;
}

// Check every SDP fingerprint before handing the description to WebRTC. Native
// DTLS then verifies the peer really owns the pinned certificate's private key.
export function verifyRemoteSDP(sdp, expected) {
  const fingerprints = [...String(sdp).matchAll(/^a=fingerprint:([^\s]+)\s+([^\r\n]+)$/gim)];
  if (
    !fingerprints.length ||
    fingerprints.some(
      (match) =>
        match[1].toLowerCase() !== 'sha-256' ||
        normalizedFingerprint(match[2].trim()) !== normalizedFingerprint(expected),
    )
  ) {
    throw new Error('Mac identity mismatch. The connection was blocked.');
  }
  return true;
}

export function bytesToBase64(bytes, url = false) {
  const value = btoa(String.fromCharCode(...bytes));
  return url ? value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : value;
}
export function base64ToBytes(value) {
  const raw = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export function validateRemoteConfig(config) {
  config.fingerprint = normalizedFingerprint(config.fingerprint);
  const signal = new URL(config.signalUrl);
  const ice = new URL(config.iceUrl);
  if (
    signal.protocol !== 'wss:' ||
    ice.protocol !== 'https:' ||
    signal.host !== ice.host ||
    signal.username ||
    signal.password
  )
    throw new Error('Invalid relay connection');
  if (config.directUrl && new URL(config.directUrl).protocol !== 'wss:')
    throw new Error('Invalid direct connection');
  return config;
}

export async function getDeviceIdentity(fingerprint) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pi-device-identities', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const key = normalizedFingerprint(fingerprint);
  const read = () =>
    new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  let identity = await read();
  if (!identity) {
    const candidate = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );
    identity = await new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      const store = transaction.objectStore('keys');
      const request = store.get(key);
      let winner;
      request.onsuccess = () => {
        winner = request.result || candidate;
        if (!request.result) store.put(candidate, key);
      };
      transaction.oncomplete = () => resolve(winner);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Device storage failed'));
    });
  }
  db.close();
  if (identity.privateKey.extractable) throw new Error('Device key must not be exportable');
  return identity;
}

export async function createDeviceProof(identity, nonce, fingerprint, ticket = '') {
  const data = new TextEncoder().encode(
    `pi-device-auth-v1:${nonce}:${normalizedFingerprint(fingerprint)}`,
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    data,
  );
  return {
    type: 'auth',
    publicKey: await crypto.subtle.exportKey('jwk', identity.publicKey),
    signature: bytesToBase64(new Uint8Array(signature), true),
    ticket,
  };
}

// A compromised signaling service must not turn ICE into a private-network
// probe. The only accepted fallback is TURN on the configured relay itself.
export function validatedICEServers(data, relayHost) {
  return (Array.isArray(data?.iceServers) ? data.iceServers : []).slice(0, 4).flatMap((server) => {
    if (
      typeof server.username !== 'string' ||
      server.username.length > 256 ||
      typeof server.credential !== 'string' ||
      server.credential.length > 256
    )
      return [];
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((value) => {
      if (typeof value !== 'string') return false;
      const match = /^turn:([^/?#@]+):3478\?transport=(udp|tcp)$/.exec(value);
      return match && match[1] === relayHost;
    });
    return urls.length ? [{ urls, username: server.username, credential: server.credential }] : [];
  });
}
