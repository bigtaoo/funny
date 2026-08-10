// Unit tests for the hand-rolled UA parser (service/defs.ts parseUserAgent). Pure function, no Mongo.
import { describe, expect, it } from 'vitest';
import { parseUserAgent } from '../src/service/defs';

describe('parseUserAgent', () => {
  it('undefined/empty UA falls back to unknown browser + desktop device_type', () => {
    expect(parseUserAgent(undefined)).toEqual({ browser: 'unknown', device_type: 'desktop' });
    expect(parseUserAgent('')).toEqual({ browser: 'unknown', device_type: 'desktop' });
  });

  it('detects WeChat in-app browser (MicroMessenger) on Android as mobile', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 ' +
      'Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.34.2400(0x28002234) Process/tools';
    expect(parseUserAgent(ua)).toEqual({ browser: 'wechat', device_type: 'mobile' });
  });

  it('detects QQBrowser ahead of the generic Chrome match', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36 QQBrowser/11.4.5185.400';
    expect(parseUserAgent(ua).browser).toBe('qqbrowser');
  });

  it('detects Edge (Edg/) ahead of the generic Chrome match', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    expect(parseUserAgent(ua).browser).toBe('edge');
  });

  it('detects Opera (OPR/) ahead of the generic Chrome match', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0';
    expect(parseUserAgent(ua).browser).toBe('opera');
  });

  it('detects Firefox ahead of the generic Chrome/Safari match', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
    expect(parseUserAgent(ua).browser).toBe('firefox');
  });

  it('a real desktop Chrome UA is chrome + desktop (not mis-bucketed as safari)', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(parseUserAgent(ua)).toEqual({ browser: 'chrome', device_type: 'desktop' });
  });

  it('CriOS (Chrome on iOS) is still bucketed as chrome', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.66 Mobile/15E148 Safari/604.1';
    expect(parseUserAgent(ua)).toEqual({ browser: 'chrome', device_type: 'mobile' });
  });

  it('a real desktop Safari UA (no Chrome/CriOS token) is safari + desktop', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    expect(parseUserAgent(ua)).toEqual({ browser: 'safari', device_type: 'desktop' });
  });

  it('a real iPad Safari UA is device_type tablet even though "Mobile" also appears in the string', () => {
    // Real-world iPadOS Safari UAs include a "Mobile/15E148" token; the iPad branch of the device_type
    // regex must win regardless (only the separate bare "Tablet" alternative has the (?!.*Mobile) guard).
    const ua =
      'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
    expect(parseUserAgent(ua)).toEqual({ browser: 'safari', device_type: 'tablet' });
  });

  it('an Android tablet UA (Tablet keyword, no Mobile keyword) is device_type tablet', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Tablet';
    expect(parseUserAgent(ua).device_type).toBe('tablet');
  });

  it('an Android phone UA (Android + Mobile) is device_type mobile', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    expect(parseUserAgent(ua)).toEqual({ browser: 'chrome', device_type: 'mobile' });
  });

  it('an iPhone UA is device_type mobile', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(parseUserAgent(ua)).toEqual({ browser: 'safari', device_type: 'mobile' });
  });

  it('an unrecognised UA string still returns a device_type (desktop default) with browser unknown', () => {
    expect(parseUserAgent('some-weird-custom-client/1.0')).toEqual({ browser: 'unknown', device_type: 'desktop' });
  });
});
