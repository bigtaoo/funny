/**
 * friendsWorldChatAndClaim.test.ts — direct coverage of FriendsScene/network.ts's `doSendWorldChat`
 * and `doClaim`, the two methods the 2026-08-05 client-test-audit flagged as "tests assert 'UI
 * called net.xxx' but never let net.xxx's real body run": every existing test that touches world
 * chat or mail supplies `sendWorldChat`/`claimMail` purely as required-callback filler to satisfy
 * `FriendsSceneCallbacks`'s type, never taps the Send/Claim button, and never calls either method
 * directly (see claudedocs/client-testing.md's audit backlog entry).
 *
 * NetworkPanel is now an independent class over `core` (2026-08-11 composition conversion — see
 * claudedocs/client-modules.md's split-form priority note): construct a real NetworkPanel over a
 * bare-bones fake core — plain node unit test, no PIXI. `loadWorldMessages()`/`refresh()` (the
 * sibling NetworkPanel methods each fire-and-forget on success) are spied away on the REAL
 * NetworkPanel instance rather than driven for real — this works because `this.loadWorldMessages()`/
 * `this.refresh()` inside doSendWorldChat/doClaim are dynamic same-instance dispatch (a real class
 * method lookup through `this`, not a free function's lexical self-reference), so spying on the
 * instance intercepts the internal call — isolating the two audited methods from the rest of the
 * class's data-loading surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { NetworkPanel } from '../src/scenes/FriendsScene/network';
import type { FriendsSceneCore } from '../src/scenes/FriendsScene/core';
import type { MailView } from '../src/net/ApiClient';

function makeMail(overrides: Partial<MailView> = {}): MailView {
  return {
    mailId: 'mail1', title: 'A gift', body: '', createdAt: 0, read: false, claimed: false,
    ...overrides,
  } as unknown as MailView;
}

/** Bare-bones stand-in for FriendsSceneCore — only the fields network.ts's doSendWorldChat/doClaim
 *  bodies touch. */
class FakeFriendsSceneCore {
  dead = false;
  worldChatInput = '';
  worldSending = false;
  worldStick = false;
  cb = {
    sendWorldChat: vi.fn(async (_body: string, _senderName: string) => {}) as
      ((body: string, senderName: string) => Promise<void>) | undefined,
    claimMail: vi.fn(async (_mailId: string): Promise<boolean> => true),
    playerName: vi.fn((): string => 'Tester'),
    refreshWallet: vi.fn(async () => {}),
  };
  render = vi.fn();
  toast = vi.fn();
  clearHiddenInput = vi.fn();
}

function buildScene(overrides: Partial<FakeFriendsSceneCore> = {}) {
  const core = new FakeFriendsSceneCore();
  Object.assign(core, overrides);
  const network = new NetworkPanel(core as unknown as FriendsSceneCore);
  vi.spyOn(network, 'loadWorldMessages').mockResolvedValue(undefined);
  vi.spyOn(network, 'refresh').mockResolvedValue(undefined);
  return { core, network };
}

// ── doSendWorldChat ───────────────────────────────────────────────────────────

describe('FriendsScene — doSendWorldChat() guards', () => {
  it('does nothing for a blank draft', async () => {
    const { core, network } = buildScene({ worldChatInput: '' });
    await network.doSendWorldChat();
    expect(core.cb.sendWorldChat).not.toHaveBeenCalled();
    expect(core.render).not.toHaveBeenCalled();
  });

  it('does nothing for a whitespace-only draft', async () => {
    const { core, network } = buildScene({ worldChatInput: '   ' });
    await network.doSendWorldChat();
    expect(core.cb.sendWorldChat).not.toHaveBeenCalled();
  });

  it('does nothing while already sending (double-tap guard)', async () => {
    const { core, network } = buildScene({ worldChatInput: 'hi', worldSending: true });
    await network.doSendWorldChat();
    expect(core.cb.sendWorldChat).not.toHaveBeenCalled();
  });

  it('does nothing when the world-chat callback is not injected (non-SLG builds)', async () => {
    const { core, network } = buildScene({ worldChatInput: 'hi', cb: { ...new FakeFriendsSceneCore().cb, sendWorldChat: undefined } });
    await network.doSendWorldChat();
    expect(core.render).not.toHaveBeenCalled();
  });
});

describe('FriendsScene — doSendWorldChat() success', () => {
  it('sends the trimmed draft, clears it, re-pins to the bottom, refreshes the wallet, and re-fetches', async () => {
    const { core, network } = buildScene({ worldChatInput: '  hello world  ', worldStick: false });

    await network.doSendWorldChat();

    expect(core.clearHiddenInput).toHaveBeenCalledTimes(1);
    expect(core.cb.sendWorldChat).toHaveBeenCalledWith('hello world', 'Tester');
    expect(core.worldChatInput).toBe('');
    expect(core.worldStick).toBe(true);
    expect(core.toast).toHaveBeenCalledWith('social.world.sent', 'success');
    expect(core.cb.refreshWallet).toHaveBeenCalledTimes(1);
    expect(network.loadWorldMessages).toHaveBeenCalledTimes(1);
    expect(core.worldSending).toBe(false);
    // One render before the network call (busy state) + one after it settles.
    expect(core.render).toHaveBeenCalledTimes(2);
  });
});

describe('FriendsScene — doSendWorldChat() failure', () => {
  it('shows the send-failed toast, keeps the draft, and does not re-fetch', async () => {
    const { core, network } = buildScene({ worldChatInput: 'doomed' });
    (core.cb.sendWorldChat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    await network.doSendWorldChat();

    expect(core.toast).toHaveBeenCalledWith('social.world.sendFail');
    expect(core.worldChatInput).toBe('doomed'); // draft survives a failed send so the user can retry
    expect(core.worldStick).toBe(false); // never got to the re-pin line
    expect(network.loadWorldMessages).not.toHaveBeenCalled();
    expect(core.cb.refreshWallet).not.toHaveBeenCalled();
    expect(core.worldSending).toBe(false);
  });

  it('also treats a refreshWallet() rejection as a send failure (same try block) — even though the input was already cleared', async () => {
    const { core, network } = buildScene({ worldChatInput: 'hi' });
    core.cb.refreshWallet.mockRejectedValueOnce(new Error('wallet fetch failed'));

    await network.doSendWorldChat();

    expect(core.cb.sendWorldChat).toHaveBeenCalledTimes(1); // the send itself DID succeed
    expect(core.toast).toHaveBeenCalledWith('social.world.sent', 'success'); // fired before refreshWallet
    expect(core.toast).toHaveBeenCalledWith('social.world.sendFail'); // then the reject lands in the same catch
    // The input-clear/re-pin lines run BEFORE the awaited refreshWallet(), so they are NOT rolled
    // back by a later refreshWallet failure — only loadWorldMessages() (which comes after it) is skipped.
    expect(core.worldChatInput).toBe('');
    expect(core.worldStick).toBe(true);
    expect(network.loadWorldMessages).not.toHaveBeenCalled();
  });
});

// ── doClaim ───────────────────────────────────────────────────────────────────

describe('FriendsScene — doClaim() success', () => {
  it('marks the mail claimed, toasts success, re-renders, and refetches', async () => {
    const { core, network } = buildScene();
    const mail = makeMail();

    await network.doClaim(mail);

    expect(core.cb.claimMail).toHaveBeenCalledWith('mail1');
    expect(mail.claimed).toBe(true);
    expect(core.toast).toHaveBeenCalledWith('mail.claimDone', 'success');
    expect(core.render).toHaveBeenCalledTimes(1);
    expect(network.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not mark claimed when the server resolves ok:false without throwing', async () => {
    const { core, network } = buildScene();
    core.cb.claimMail.mockResolvedValueOnce(false);
    const mail = makeMail();

    await network.doClaim(mail);

    expect(mail.claimed).toBe(false);
    expect(core.toast).toHaveBeenCalledWith('mail.claimFail');
    // refresh() still fires unconditionally — even a soft failure re-syncs the mail list.
    expect(network.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('FriendsScene — doClaim() failure', () => {
  it('maps an ALREADY_CLAIMED error code to the specific toast', async () => {
    const { core, network } = buildScene();
    core.cb.claimMail.mockRejectedValueOnce({ code: 'ALREADY_CLAIMED' });
    const mail = makeMail();

    await network.doClaim(mail);

    expect(mail.claimed).toBe(false);
    expect(core.toast).toHaveBeenCalledWith('mail.alreadyClaimed');
    expect(network.refresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic claim-failed toast for any other error', async () => {
    const { core, network } = buildScene();
    core.cb.claimMail.mockRejectedValueOnce(new Error('network down'));
    const mail = makeMail();

    await network.doClaim(mail);

    expect(mail.claimed).toBe(false);
    expect(core.toast).toHaveBeenCalledWith('mail.claimFail');
  });

  it('also falls back to the generic toast for a rejection with no .code at all', async () => {
    const { core, network } = buildScene();
    core.cb.claimMail.mockRejectedValueOnce(null);
    const mail = makeMail();

    await network.doClaim(mail);

    expect(core.toast).toHaveBeenCalledWith('mail.claimFail');
  });
});
