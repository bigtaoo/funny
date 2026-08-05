/**
 * sectActions.test.ts — direct coverage of SectScene/actions.ts's mutating-action bodies that the
 * existing UI-level tests never actually execute:
 *
 * - ally / unally (openAllyList/openManageAllies candidate filtering + doAlly/doUnally network body)
 * - leader-removal vote (confirmVote wiring + doVote's passed/not-passed toast branches)
 * - join-sect flow (openBrowseList + doJoin's real network body, not just "UI called net.xxx")
 * - channel send (doSendChannelMessage's guards + real success/failure paths)
 *
 * sectActionBusyLock.ui.ts already covers the busy-lock/timeout/button-grey mechanics using
 * doLeave/doDissolve as "representative" of every action sharing the same wrapper; this file is
 * the audit-flagged gap-fill for the four actions that wrapper never itself exercised (2026-08-05
 * full-suite audit — see claudedocs/client-testing.md).
 *
 * Follows familySendButton.test.ts's pattern: mount ActionsMixin directly on a bare-bones fake
 * base exposing only the fields the mixin body touches, so this runs as a plain node unit test —
 * no PIXI, no headless adapter needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { ActionsMixin } from '../src/scenes/SectScene/actions';
import type { SectSceneBaseCtor } from '../src/scenes/SectScene/base';
import { BusyTracker, TimeoutError } from '../src/ui/busyTracker';
import { WorldApiError } from '../src/net/WorldApiClient';
import type { SectDetailView, SectView } from '../src/net/WorldApiClient';

function makeSect(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect_me', worldId: 'w1', name: 'Sky Sect', tag: 'SKY',
    leaderId: 'me', leaderFamilyId: 'fam_1', memberFamilyCount: 1, prosperity: 0,
    memberFamilies: [], allySectIds: [],
    ...overrides,
  } as unknown as SectDetailView;
}

function makeSectView(sectId: string, name: string): SectView {
  return { sectId, name, tag: name.slice(0, 3).toUpperCase(), memberFamilyCount: 1 } as unknown as SectView;
}

/** Bare-bones stand-in for SectSceneBase — only the fields actions.ts's mixin body touches. */
class FakeSectSceneBase {
  destroyed = false;
  sect: SectDetailView | null = null;
  messages: unknown[] = [];
  mode: 'loading' | 'noSect' | 'create' | 'mySect' = 'noSect';
  activeTab: 'families' | 'channel' = 'families';
  sectsCache: SectView[] = [];
  createName = '';
  createTag = '';
  channelInput = '';
  channelActive = true;
  channelSending = false;
  channelStick = false;
  hiddenInput: { remove: () => void } | null = null;
  bt = new BusyTracker();
  cb = {
    worldApi: {
      createSect: vi.fn(),
      listSects: vi.fn(async (): Promise<SectView[]> => []),
      joinSect: vi.fn(async () => ({ ok: true as const })),
      allySect: vi.fn(async () => ({ ok: true as const })),
      unallySect: vi.fn(async () => ({ ok: true as const })),
      voteRemoveSectLeader: vi.fn(async () => ({ passed: false, voteCount: 1, needed: 3 })),
      sendSectMessage: vi.fn(async () => ({ id: 'm1', senderId: 'me', senderName: 'Tester', body: 'hi', ts: 0 })),
    },
    worldId: 'w1',
    myAccountId: 'me',
    playerName: 'Tester',
    getCoins: () => 0,
    refreshWallet: vi.fn(async () => {}),
  };
  render = vi.fn();
  showToast = vi.fn();
  errorMsg = (e: unknown): string => String(e);
  closeModal = vi.fn();
  showSectPickModal = vi.fn();
  showConfirm = vi.fn();
  loadMySect = vi.fn(async () => {});
  loadChannel = vi.fn(async () => {});
}

const SectWithActions = ActionsMixin(FakeSectSceneBase as unknown as SectSceneBaseCtor);

function buildScene(overrides: Partial<FakeSectSceneBase> = {}): any {
  const scene = new SectWithActions() as unknown as FakeSectSceneBase & Record<string, any>;
  Object.assign(scene, overrides);
  return scene;
}

// ── Join-sect flow ───────────────────────────────────────────────────────────

describe('SectScene — openBrowseList()', () => {
  it('fetches the world sect list and opens the picker wired to doJoin', async () => {
    const sects = [makeSectView('s1', 'Alpha'), makeSectView('s2', 'Beta')];
    const scene = buildScene();
    scene.cb.worldApi.listSects.mockResolvedValueOnce(sects);

    await scene.openBrowseList();

    expect(scene.cb.worldApi.listSects).toHaveBeenCalledWith('w1');
    expect(scene.sectsCache).toEqual(sects);
    expect(scene.showSectPickModal).toHaveBeenCalledTimes(1);
    const [list, onPick, emptyKey] = scene.showSectPickModal.mock.calls[0]!;
    expect(list).toEqual(sects);
    expect(emptyKey).toBe('sect.noSects');

    // Picking a row drives the real doJoin — spy on it via the prototype-level method.
    const doJoinSpy = vi.spyOn(scene, 'doJoin').mockResolvedValue(undefined);
    onPick('s2');
    expect(doJoinSpy).toHaveBeenCalledWith('s2');
  });

  it('shows a toast and never opens the picker when the fetch fails', async () => {
    const scene = buildScene();
    scene.cb.worldApi.listSects.mockRejectedValueOnce(new Error('down'));

    await scene.openBrowseList();

    expect(scene.showSectPickModal).not.toHaveBeenCalled();
    expect(scene.showToast).toHaveBeenCalledTimes(1);
  });
});

describe('SectScene — doJoin()', () => {
  it('joins, closes the modal, and loads the newly-joined sect', async () => {
    const scene = buildScene();

    await scene.doJoin('sect_target');

    expect(scene.cb.worldApi.joinSect).toHaveBeenCalledWith('w1', 'sect_target');
    expect(scene.closeModal).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).toHaveBeenCalledWith('sect_target');
    expect(scene.bt.busy).toBe(false);
  });

  it('a second call while the first is in flight does not re-issue the join request', async () => {
    const scene = buildScene();
    scene.cb.worldApi.joinSect.mockReturnValueOnce(new Promise<{ ok: true }>(() => {})); // never resolves

    void scene.doJoin('sect_target');
    void scene.doJoin('sect_target');
    await Promise.resolve();

    expect(scene.cb.worldApi.joinSect).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(true);
  });

  it('a failed join shows a toast, does not load the sect, and unlocks', async () => {
    const scene = buildScene();
    scene.cb.worldApi.joinSect.mockRejectedValueOnce(new WorldApiError('SECT_FULL', 'full'));

    await scene.doJoin('sect_target');

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).not.toHaveBeenCalled();
    expect(scene.bt.busy).toBe(false);
  });
});

// ── Ally / unally ────────────────────────────────────────────────────────────

describe('SectScene — openAllyList()', () => {
  it('excludes own sect and already-allied sects from the candidate list', async () => {
    const sect = makeSect({ sectId: 'sect_me', allySectIds: ['sect_ally1'] });
    const scene = buildScene({ sect });
    scene.cb.worldApi.listSects.mockResolvedValueOnce([
      makeSectView('sect_me', 'Mine'),
      makeSectView('sect_ally1', 'Already Allied'),
      makeSectView('sect_new', 'New Candidate'),
    ]);

    await scene.openAllyList();

    const [candidates, , emptyKey] = scene.showSectPickModal.mock.calls[0]!;
    expect(candidates.map((s: SectView) => s.sectId)).toEqual(['sect_new']);
    expect(emptyKey).toBe('sect.noSects');
  });

  it('picking a candidate routes to confirmAlly with a resolved label', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const scene = buildScene({ sect });
    scene.cb.worldApi.listSects.mockResolvedValueOnce([makeSectView('sect_new', 'New Candidate')]);

    await scene.openAllyList();
    const confirmAllySpy = vi.spyOn(scene, 'confirmAlly');
    const onPick = scene.showSectPickModal.mock.calls[0]![1];
    onPick('sect_new');

    expect(confirmAllySpy).toHaveBeenCalledWith('sect_new', '[NEW] New Candidate');
  });

  it('is a no-op when the player has no sect', async () => {
    const scene = buildScene({ sect: null });
    await scene.openAllyList();
    expect(scene.cb.worldApi.listSects).not.toHaveBeenCalled();
  });
});

describe('SectScene — confirmAlly() wiring', () => {
  it('shows a confirm dialog whose OK action calls doAlly with the target id', () => {
    const scene = buildScene();
    const doAllySpy = vi.spyOn(scene, 'doAlly').mockResolvedValue(undefined);

    scene.confirmAlly('sect_target', '[TAG] Target Sect');

    expect(scene.showConfirm).toHaveBeenCalledTimes(1);
    const [msg, onOk] = scene.showConfirm.mock.calls[0]!;
    expect(msg).toContain('Target Sect');
    onOk();
    expect(doAllySpy).toHaveBeenCalledWith('sect_target');
  });
});

describe('SectScene — doAlly()', () => {
  it('allies, closes the modal, and reloads the sect', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const scene = buildScene({ sect });

    await scene.doAlly('sect_target');

    expect(scene.cb.worldApi.allySect).toHaveBeenCalledWith('w1', 'sect_target');
    expect(scene.closeModal).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).toHaveBeenCalledWith('sect_me');
    expect(scene.bt.busy).toBe(false);
  });

  it('a second call while the first is in flight does not re-issue the request', async () => {
    const scene = buildScene({ sect: makeSect() });
    scene.cb.worldApi.allySect.mockReturnValueOnce(new Promise<{ ok: true }>(() => {}));

    void scene.doAlly('sect_target');
    void scene.doAlly('sect_target');
    await Promise.resolve();

    expect(scene.cb.worldApi.allySect).toHaveBeenCalledTimes(1);
  });

  it('shows a toast and does not reload the sect on failure', async () => {
    const scene = buildScene({ sect: makeSect() });
    scene.cb.worldApi.allySect.mockRejectedValueOnce(new WorldApiError('ALLY_CAP_REACHED', 'cap'));

    await scene.doAlly('sect_target');

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).not.toHaveBeenCalled();
  });
});

describe('SectScene — openManageAllies()', () => {
  it('resolves the sect ally-id list to names and routes a pick through confirmUnally', async () => {
    const sect = makeSect({ sectId: 'sect_me', allySectIds: ['sect_ally1', 'sect_gone'] });
    const scene = buildScene({ sect });
    scene.cb.worldApi.listSects.mockResolvedValueOnce([
      makeSectView('sect_ally1', 'Old Friend'),
      // 'sect_gone' has since been dissolved — must not blow up resolving it, just drop it.
    ]);

    await scene.openManageAllies();

    const [allies, onPick] = scene.showSectPickModal.mock.calls[0]!;
    expect(allies.map((s: SectView) => s.sectId)).toEqual(['sect_ally1']);

    const confirmUnallySpy = vi.spyOn(scene, 'confirmUnally');
    onPick('sect_ally1');
    expect(confirmUnallySpy).toHaveBeenCalledWith('sect_ally1', '[OLD] Old Friend');
  });
});

describe('SectScene — doUnally()', () => {
  it('unallies and reloads the sect', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const scene = buildScene({ sect });

    await scene.doUnally('sect_ally1');

    expect(scene.cb.worldApi.unallySect).toHaveBeenCalledWith('w1', 'sect_ally1');
    expect(scene.closeModal).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).toHaveBeenCalledWith('sect_me');
  });

  it('shows a toast on failure without reloading', async () => {
    const scene = buildScene({ sect: makeSect() });
    scene.cb.worldApi.unallySect.mockRejectedValueOnce(new Error('boom'));

    await scene.doUnally('sect_ally1');

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).not.toHaveBeenCalled();
  });
});

describe('SectScene — openAlliesView() (read-only)', () => {
  it('resolves ally ids to full SectView objects for a member-facing read-only picker', async () => {
    const sect = makeSect({ sectId: 'sect_me', allySectIds: ['sect_ally1'] });
    const scene = buildScene({ sect });
    scene.cb.worldApi.listSects.mockResolvedValueOnce([makeSectView('sect_ally1', 'Old Friend')]);

    await scene.openAlliesView();

    const [allies, , emptyKey, readOnly] = scene.showSectPickModal.mock.calls[0]!;
    expect(allies.map((s: SectView) => s.sectId)).toEqual(['sect_ally1']);
    expect(emptyKey).toBe('sect.noAllies');
    expect(readOnly).toBe(true);
  });
});

// ── Leader-removal vote ──────────────────────────────────────────────────────

describe('SectScene — confirmVote() wiring', () => {
  it('shows a confirm dialog naming the nominee whose OK action calls doVote', () => {
    const scene = buildScene();
    const doVoteSpy = vi.spyOn(scene, 'doVote').mockResolvedValue(undefined);

    scene.confirmVote('fam_2', '[G1] Guild One');

    const [msg, onOk] = scene.showConfirm.mock.calls[0]!;
    expect(msg).toContain('Guild One');
    onOk();
    expect(doVoteSpy).toHaveBeenCalledWith('fam_2');
  });
});

describe('SectScene — doVote()', () => {
  it('a passing vote toasts the leadership-changed message and reloads the sect', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const scene = buildScene({ sect });
    scene.cb.worldApi.voteRemoveSectLeader.mockResolvedValueOnce({ passed: true, voteCount: 3, needed: 3 });

    await scene.doVote('fam_2');

    expect(scene.cb.worldApi.voteRemoveSectLeader).toHaveBeenCalledWith('w1', 'fam_2');
    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.showToast.mock.calls[0]![0]).not.toContain('/'); // votePassed has no cur/need interpolation
    expect(scene.loadMySect).toHaveBeenCalledWith('sect_me');
  });

  it('a non-passing vote toasts the running tally and still reloads (a family may have gained/lost members)', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const scene = buildScene({ sect });
    scene.cb.worldApi.voteRemoveSectLeader.mockResolvedValueOnce({ passed: false, voteCount: 1, needed: 3 });

    await scene.doVote('fam_2');

    expect(scene.showToast.mock.calls[0]![0]).toContain('1');
    expect(scene.showToast.mock.calls[0]![0]).toContain('3');
    expect(scene.loadMySect).toHaveBeenCalledWith('sect_me');
  });

  it('a second call while the first is in flight does not re-issue the vote', async () => {
    const scene = buildScene({ sect: makeSect() });
    scene.cb.worldApi.voteRemoveSectLeader.mockReturnValueOnce(new Promise(() => {}));

    void scene.doVote('fam_2');
    void scene.doVote('fam_2');
    await Promise.resolve();

    expect(scene.cb.worldApi.voteRemoveSectLeader).toHaveBeenCalledTimes(1);
  });

  it('shows a toast and does not reload on failure', async () => {
    const scene = buildScene({ sect: makeSect() });
    scene.cb.worldApi.voteRemoveSectLeader.mockRejectedValueOnce(new TimeoutError());

    await scene.doVote('fam_2');

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadMySect).not.toHaveBeenCalled();
  });
});

// ── Channel send ─────────────────────────────────────────────────────────────

describe('SectScene — doSendChannelMessage() guards', () => {
  it('does nothing for a blank draft', async () => {
    const scene = buildScene({ sect: makeSect(), channelInput: '' });
    await scene.doSendChannelMessage();
    expect(scene.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });

  it('does nothing for a whitespace-only draft', async () => {
    const scene = buildScene({ sect: makeSect(), channelInput: '   ' });
    await scene.doSendChannelMessage();
    expect(scene.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });

  it('does nothing while already sending (double-tap guard)', async () => {
    const scene = buildScene({ sect: makeSect(), channelInput: 'hi', channelSending: true });
    await scene.doSendChannelMessage();
    expect(scene.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });

  it('does nothing without a sect', async () => {
    const scene = buildScene({ sect: null, channelInput: 'hi' });
    await scene.doSendChannelMessage();
    expect(scene.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });
});

describe('SectScene — doSendChannelMessage() success', () => {
  it('trims the draft, sends it, clears the input, and refetches the channel', async () => {
    const removeSpy = vi.fn();
    const scene = buildScene({ sect: makeSect(), channelInput: '  hello sect  ', hiddenInput: { remove: removeSpy } });

    await scene.doSendChannelMessage();

    expect(scene.cb.worldApi.sendSectMessage).toHaveBeenCalledWith('w1', 'hello sect', 'Tester');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(scene.hiddenInput).toBeNull();
    expect(scene.channelInput).toBe('');
    expect(scene.channelSending).toBe(false);
    expect(scene.channelStick).toBe(true);
    expect(scene.loadChannel).toHaveBeenCalledTimes(1);
    // One render to show the "sending…" state, one more once it settles.
    expect(scene.render).toHaveBeenCalledTimes(2);
  });
});

describe('SectScene — doSendChannelMessage() failure', () => {
  it('shows a toast, keeps the draft, and does not refetch the channel', async () => {
    const scene = buildScene({ sect: makeSect(), channelInput: 'doomed' });
    scene.cb.worldApi.sendSectMessage.mockRejectedValueOnce(new Error('network down'));

    await scene.doSendChannelMessage();

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadChannel).not.toHaveBeenCalled();
    expect(scene.channelInput).toBe('doomed'); // draft survives a failed send so the user can retry
    expect(scene.channelSending).toBe(false);
  });

  it('does not render a second time once the scene is destroyed mid-flight', async () => {
    const scene = buildScene({ sect: makeSect(), channelInput: 'hi' });
    let resolveSend!: (v: { id: string; senderId: string; senderName: string; body: string; ts: number }) => void;
    scene.cb.worldApi.sendSectMessage.mockReturnValueOnce(
      new Promise((r) => { resolveSend = r; }),
    );

    const pending = scene.doSendChannelMessage();
    scene.render.mockClear();
    scene.destroyed = true;
    resolveSend({ id: 'm1', senderId: 'me', senderName: 'Tester', body: 'hi', ts: 0 });
    await pending;

    expect(scene.render).not.toHaveBeenCalled();
  });
});
