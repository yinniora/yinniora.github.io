// Coarse labels only: no full user-agent, hardware model, IP or location is saved.
export function deviceFeatures({
  navigatorImpl = navigator,
  standalone = matchMedia('(display-mode: standalone)').matches,
} = {}) {
  const ua = String(navigatorImpl.userAgent || '');
  let os = '';
  const ios = /(?:iPhone|iPad|iPod).*OS ([\d_]+)/.exec(ua);
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  const android = /Android ([\d.]+)/.exec(ua);
  if (ios) os = /iPad/.test(ua) ? 'iPad · iPadOS' : 'iPhone · iOS';
  else if (/Macintosh/.test(ua) && navigatorImpl.maxTouchPoints > 1) os = 'iPad · iPadOS';
  else if (android) os = 'Android';
  else if (mac) os = 'Mac · macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = '';
  for (const [name, pattern] of [
    ['Edge', /(?:Edg|EdgiOS|EdgA)\/([\d]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ]) {
    const match = pattern.exec(ua);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  if (!browser && /AppleWebKit/.test(ua)) browser = 'WebKit';
  return { os, browser, app: standalone || navigatorImpl.standalone ? 'standalone' : 'browser' };
}
