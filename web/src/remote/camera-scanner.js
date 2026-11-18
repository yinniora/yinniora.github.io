export async function createCameraScanner({
  Detector = globalThis.BarcodeDetector,
  loadDecoder = () => import('./scan-code.js'),
} = {}) {
  let detector;
  try {
    if (Detector && (await Detector.getSupportedFormats()).includes('qr_code'))
      detector = new Detector({ formats: ['qr_code'] });
  } catch {}
  let decoder = detector ? null : loadDecoder();
  decoder?.catch(() => {});
  return async (canvas, context, invert = false) => {
    if (detector) {
      try {
        const results = await detector.detect(canvas);
        const text = results.find((result) => result.rawValue)?.rawValue;
        if (text) return text;
      } catch {
        detector = null;
      }
    }
    decoder ||= loadDecoder();
    const { readQRCode } = await decoder;
    return readQRCode(context.getImageData(0, 0, canvas.width, canvas.height), { invert });
  };
}
