// Unit cases for the sink hand-off itself (src/ui/dialogs/subscriptionDisclosure.ts), which every
// other test only exercises indirectly through a well-behaved sink (shopNav-buySubscription.test.ts,
// appDialogInputGate.test.ts). Those never hit requestSubscriptionDisclosure's own edge branches:
// no sink registered, a sink that throws synchronously, and a sink that calls `answer` twice — all
// three matter because a purchase that cannot show its terms must not proceed (App Review 3.1.2).
import { describe, it, expect, afterEach } from 'vitest';
import {
  requestSubscriptionDisclosure,
  setSubscriptionDisclosureSink,
  type SubscriptionDisclosureInfo,
} from '../src/ui/dialogs/subscriptionDisclosure';

const info: SubscriptionDisclosureInfo = { product: 'monthly_card', price: '4,99 €' };

afterEach(() => { setSubscriptionDisclosureSink(null); });

describe('requestSubscriptionDisclosure', () => {
  it('no sink registered → resolves false (a purchase that cannot show its terms must not proceed)', async () => {
    expect(await requestSubscriptionDisclosure(info)).toBe(false);
  });

  it('resolves with whatever the sink answers, and hands it the info unchanged', async () => {
    let seen: SubscriptionDisclosureInfo | undefined;
    setSubscriptionDisclosureSink((got, answer) => { seen = got; answer(true); });
    expect(await requestSubscriptionDisclosure(info)).toBe(true);
    expect(seen).toEqual(info);

    setSubscriptionDisclosureSink((_info, answer) => answer(false));
    expect(await requestSubscriptionDisclosure(info)).toBe(false);
  });

  it('a sink that throws synchronously resolves false rather than rejecting', async () => {
    setSubscriptionDisclosureSink(() => { throw new Error('dialog mount failed'); });
    await expect(requestSubscriptionDisclosure(info)).resolves.toBe(false);
  });

  it('a sink that calls answer twice only settles the promise once (first answer wins)', async () => {
    setSubscriptionDisclosureSink((_info, answer) => { answer(true); answer(false); });
    expect(await requestSubscriptionDisclosure(info)).toBe(true);
  });

  it('setSubscriptionDisclosureSink(null) clears a previously registered sink', async () => {
    setSubscriptionDisclosureSink((_info, answer) => answer(true));
    setSubscriptionDisclosureSink(null);
    expect(await requestSubscriptionDisclosure(info)).toBe(false);
  });
});
