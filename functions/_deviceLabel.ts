/**
 * A device's name for the account sheet's device list, from its User-Agent: "Safari on iPhone",
 * "Chrome on Mac", "Edge on Windows". No dependencies and no guessing beyond the usual tokens; an
 * unrecognized or missing agent is "Unknown browser". iPadOS Safari's desktop-class agent reads as
 * a Mac (it says Macintosh), as every UA parser has it.
 */

const OSES: [RegExp, string][] = [
  [/\biPad\b/, 'iPad'],
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'Chromebook'],
  [/\bWindows\b/, 'Windows'],
  [/\bMacintosh\b|\bMac OS X\b/, 'Mac'],
  [/\bLinux\b/, 'Linux'],
];

/** Most specific first: Edge, Opera and Samsung Internet all say Chrome and Safari too. */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOPiOS\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\/|\bMobile\/\w+ Safari\//, 'Safari'],
];

export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 400);
  const os = OSES.find(([re]) => re.test(ua))?.[1];
  let browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  // An app's web view on iOS or iPadOS (no Version/ token) is Safari's engine; call it Safari.
  if (!browser && (os === 'iPhone' || os === 'iPad') && /AppleWebKit\//.test(ua)) browser = 'Safari';
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? 'Unknown browser';
}
