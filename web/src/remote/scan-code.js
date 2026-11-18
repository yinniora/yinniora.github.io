import jsQR from 'jsqr';

export function readQRCode(frame, { invert = true } = {}) {
  if (
    !frame ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width * frame.height > 2000000 ||
    frame.data?.length !== frame.width * frame.height * 4
  )
    return '';
  return (
    jsQR(frame.data, frame.width, frame.height, {
      inversionAttempts: invert ? 'attemptBoth' : 'dontInvert',
    })?.data || ''
  );
}
