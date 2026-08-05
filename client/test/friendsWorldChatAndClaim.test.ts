/**
 * friendsWorldChatAndClaim.test.ts — direct coverage of FriendsScene/service.ts's `doSendWorldChat`
 * and `doClaim`, the two methods the 2026-08-05 client-test-audit flagged as "tests assert 'UI
 * called net.xxx' but never let net.xxx's real body run": every existing test that touches world
 * chat or mail supplies `sendWorldChat`/`claimMail` purely as required-callback filler to satisfy
 * `FriendsSceneCallbacks`'s type, never taps the Send/Claim button, and never calls either method
 * directly (see claudedocs/client-testing.md's audit backlog entry).
 *
 * Follows sectActions.test.ts's / familySendButton.test.ts's pattern: mount `NetworkMixin` directly
 * on a bare-bones fake base exposing only the fields the two methods' bodies touch — plain node
 * unit test, no PIXI. `loadWorldMessages()`/`refresh()` (the sibling NetworkMixin methods each
 * fire-and-forget on success) are spied away rather than driven for real, isolating the two audited
 * methods from the rest of the mixin's data-loading surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { NetworkMixin } from '../src/scenes/FriendsScene/service';
import type { FriendsSceneBaseCtor } from '../src/scenes/FriendsScene/base';
import type { MailView } from '../src/net/ApiClient';

function makeMail(overrides: Partial<MailView> = {}): MailView {
  return {
    mailId: 'mail1', title: 'A gift', body: '', createdAt: 0, read: false, claimed: false,
    ...overrides,
  } as unknown as MailView;
}

/** Bare-bones stand-in for FriendsSceneBase — only the fields service.ts's mixin body touches. */
class FakeFriendsSceneBase {
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
  loadWorldMessages = vi.fn(async () => {});
  refresh = vi.fn(async () => {});
}

const FriendsWithNetwork = NetworkMixin(FakeFriendsSceneBase as unknown as FriendsSceneBaseCtor);

function buildScene(overrides: Partial<FakeFriendsSceneBase> = {}): any {
  const scene = new FriendsWithNetwork() as unknown as FakeFriendsSceneBase & Record<string, any>;
  Object.assign(scene, overrides);
  return scene;
}

// ── doSendWorldChat ───────────────────────────────────────────────────────────

describe('FriendsScene — doSendWorldChat() guards', () => {
  it('does nothing for a blank draft', async () => {
    const scene = buildScene({ worldChatInput: '' });
    await scene.doSendWorldChat();
    expect(scene.cb.sendWorldChat).not.toHaveBeenCalled();
    expect(scene.render).not.toHaveBeenCalled();
  });

  it('does nothing for a whitespace-only draft', async () => {
    const scene = buildScene({ worldChatInput: '   ' });
    await scene.doSendWorldChat();
    expect(scene.cb.sendWorldChat).not.toHaveBeenCalled();
  });

  it('does nothing while already sending (double-tap guard)', async () => {
    const scene = buildScene({ worldChatInput: 'hi', worldSending: true });
    await scene.doSendWorldChat();
    expect(scene.cb.sendWorldChat).not.toHaveBeenCalled();
  });

  it('does nothing when the world-chat callback is not injected (non-SLG builds)', async () => {
    const scene = buildScene({ worldChatInput: 'hi', cb: { ...new FakeFriendsSceneBase().cb, sendWorldChat: undefined } });
    await scene.doSendWorldChat();
    expect(scene.render).not.toHaveBeenCalled();
  });
});

describe('FriendsScene — doSendWorldChat() success', () => {
  it('sends the trimmed draft, clears it, re-pins to the bottom, refreshes the wallet, and re-fetches', async () => {
    const scene = buildScene({ worldChatInput: '  hello world  ', worldStick: false });

    await scene.doSendWorldChat();

    expect(scene.clearHiddenInput).toHaveBeenCalledTimes(1);
    expect(scene.cb.sendWorldChat).toHaveBeenCalledWith('hello world', 'Tester');
    expect(scene.worldChatInput).toBe('');
    expect(scene.worldStick).toBe(true);
    expect(scene.toast).toHaveBeenCalledWith('social.world.sent', 'success');
    expect(scene.cb.refreshWallet).toHaveBeenCalledTimes(1);
    expect(scene.loadWorldMessages).toHaveBeenCalledTimes(1);
    expect(scene.worldSending).toBe(false);
    // One render before the network call (busy state) + one after it settles.
    expect(scene.render).toHaveBeenCalledTimes(2);
  });
});

describe('FriendsScene — doSendWorldChat() failure', () => {
  it('shows the send-failed toast, keeps the draft, and does not re-fetch', async () => {
    const scene = buildScene({ worldChatInput: 'doomed' });
    scene.cb.sendWorldChat.mockRejectedValueOnce(new Error('network down'));

    await scene.doSendWorldChat();

    expect(scene.toast).toHaveBeenCalledWith('social.world.sendFail');
    expect(scene.worldChatInput).toBe('doomed'); // draft survives a failed send so the user can retry
    expect(scene.worldStick).toBe(false); // never got to the re-pin line
    expect(scene.loadWorldMessages).not.toHaveBeenCalled();
    expect(scene.cb.refreshWallet).not.toHaveBeenCalled();
    expect(scene.worldSending).toBe(false);
  });

  it('also treats a refreshWallet() rejection as a send failure (same try block) — even though the input was already cleared', async () => {
    const scene = buildScene({ worldChatInput: 'hi' });
    scene.cb.refreshWallet.mockRejectedValueOnce(new Error('wallet fetch failed'));

    await scene.doSendWorldChat();

    expect(scene.cb.sendWorldChat).toHaveBeenCalledTimes(1); // the send itself DID succeed
    expect(scene.toast).toHaveBeenCalledWith('social.world.sent', 'success'); // fired before refreshWallet
    expect(scene.toast).toHaveBeenCalledWith('social.world.sendFail'); // then the reject lands in the same catch
    // The input-clear/re-pin lines run BEFORE the awaited refreshWallet(), so they are NOT rolled
    // back by a later refreshWallet failure — only loadWorldMessages() (which comes after it) is skipped.
    expect(scene.worldChatInput).toBe('');
    expect(scene.worldStick).toBe(true);
    expect(scene.loadWorldMessages).not.toHaveBeenCalled();
  });
});

// ── doClaim ───────────────────────────────────────────────────────────────────

describe('FriendsScene — doClaim() success', () => {
  it('marks the mail claimed, toasts success, re-renders, and refetches', async () => {
    const scene = buildScene();
    const mail = makeMail();

    await scene.doClaim(mail);

    expect(scene.cb.claimMail).toHaveBeenCalledWith('mail1');
    expect(mail.claimed).toBe(true);
    expect(scene.toast).toHaveBeenCalledWith('mail.claimDone', 'success');
    expect(scene.render).toHaveBeenCalledTimes(1);
    expect(scene.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not mark claimed when the server resolves ok:false without throwing', async () => {
    const scene = buildScene();
    scene.cb.claimMail.mockResolvedValueOnce(false);
    const mail = makeMail();

    await scene.doClaim(mail);

    expect(mail.claimed).toBe(false);
    expect(scene.toast).toHaveBeenCalledWith('mail.claimFail');
    // refresh() still fires unconditionally — even a soft failure re-syncs the mail list.
    expect(scene.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('FriendsScene — doClaim() failure', () => {
  it('maps an ALREADY_CLAIMED error code to the specific toast', async () => {
    const scene = buildScene();
    scene.cb.claimMail.mockRejectedValueOnce({ code: 'ALREADY_CLAIMED' });
    const mail = makeMail();

    await scene.doClaim(mail);

    expect(mail.claimed).toBe(false);
    expect(scene.toast).toHaveBeenCalledWith('mail.alreadyClaimed');
    expect(scene.refresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic claim-failed toast for any other error', async () => {
    const scene = buildScene();
    scene.cb.claimMail.mockRejectedValueOnce(new Error('network down'));
    const mail = makeMail();

    await scene.doClaim(mail);

    expect(mail.claimed).toBe(false);
    expect(scene.toast).toHaveBeenCalledWith('mail.claimFail');
  });

  it('also falls back to the generic toast for a rejection with no .code at all', async () => {
    const scene = buildScene();
    scene.cb.claimMail.mockRejectedValueOnce(null);
    const mail = makeMail();

    await scene.doClaim(mail);

    expect(scene.toast).toHaveBeenCalledWith('mail.claimFail');
  });
});
