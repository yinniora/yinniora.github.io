import { expect, it, vi } from 'vitest';
import { createCameraScanner } from './camera-scanner.js';

it('uses a supported native QR detector without copying pixels or loading the fallback', async () => {
  const detect = vi.fn(async () => [{ rawValue: 'private-pairing-link' }]);
  class Detector {
    static async getSupportedFormats() {
      return ['qr_code'];
    }
    detect = detect;
  }
  const loadDecoder = vi.fn();
  const read = await createCameraScanner({ Detector, loadDecoder });
  const context = { getImageData: vi.fn() };
  expect(await read({}, context)).toBe('private-pairing-link');
  expect(loadDecoder).not.toHaveBeenCalled();
  expect(context.getImageData).not.toHaveBeenCalled();
});

it('loads the local decoder once and retains inverted-frame fallback for unsupported browsers', async () => {
  const readQRCode = vi.fn(() => 'decoded');
  const loadDecoder = vi.fn(async () => ({ readQRCode }));
  const read = await createCameraScanner({ Detector: null, loadDecoder });
  const frame = {},
    context = { getImageData: vi.fn(() => frame) };
  expect(await read({ width: 720, height: 720 }, context)).toBe('decoded');
  await read({ width: 720, height: 720 }, context, true);
  expect(loadDecoder).toHaveBeenCalledTimes(1);
  expect(readQRCode).toHaveBeenLastCalledWith(frame, { invert: true });
});
