import { describe, it, expect } from 'vitest';
import { verifyRemoteSDP, validatedICEServers } from './identity.js';
const mac = Array(32).fill('ab').join(':');
const fake = Array(32).fill('cd').join(':');
describe('untrusted relay boundary', () => {
  it('pins every SDP fingerprint to the scanned Mac identity', () => {
    expect(verifyRemoteSDP(`v=0\r\na=fingerprint:sha-256 ${mac}\r\n`, mac)).toBe(true);
    for (const sdp of [
      '',
      `a=fingerprint:sha-256 ${fake}`,
      `a=fingerprint:sha-256 ${mac}\r\na=fingerprint:sha-256 ${fake}`,
      `a=fingerprint:sha-1 ${mac}`,
    ])
      expect(() => verifyRemoteSDP(sdp, mac)).toThrow();
  });
  it('rejects relay instructions to probe private networks or other servers', () => {
    const data = {
      iceServers: [
        {
          urls: [
            'turn:relay.example:3478?transport=udp',
            'turn:127.0.0.1:3478?transport=tcp',
            'stun:192.168.1.1',
            'turn:evil.example:3478?transport=tcp',
          ],
          username: 'u',
          credential: 'p',
        },
      ],
    };
    expect(validatedICEServers(data, 'relay.example')).toEqual([
      { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'p' },
    ]);
  });
});
