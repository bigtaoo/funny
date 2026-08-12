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
 * ActionsPanel is now an independent class over `core` + `data` + `modals` (2026-08-11 composition
 * conversion — see claudedocs/client-modules.md's split-form priority note): construct a real
 * ActionsPanel over bare-bones fakes (no PIXI, no headless adapter needed) instead of mounting a
 * mixin. Several tests below spy on ActionsPanel's OWN methods to catch internal same-instance
 * calls (e.g. openBrowseList's onPick closure calling `this.doJoin(...)`) — spying works here
 * because `this` inside a class method resolves dynamically through the prototype chain (unlike a
 * free function's lexical self-reference — see grid.ts's self-import workaround in
 * DefenseEditorScene for the case where that ISN'T true).
 */
import { describe, it, expect, vi } from 'vitest';
import { ActionsPanel } from '../src/scenes/SectScene/actions';
import type { SectSceneCore } from '../src/scenes/SectScene/core';
import type { DataHandlers } from '../src/scenes/SectScene/data';
import type { ModalsHandlers } from '../src/scenes/SectScene/modals';
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

/** Bare-bones stand-in for SectSceneCore — only the fields actions.ts's ActionsPanel body touches. */
class FakeSectSceneCore {
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
}

function buildScene(overrides: Partial<FakeSectSceneCore> = {}) {
  const core = new FakeSectSceneCore();
  Object.assign(core, overrides);
  const data = { loadMySect: vi.fn(async () => {}), loadChannel: vi.fn(async () => {}) };
  const modals = { showSectPickModal: vi.fn(), showConfirm: vi.fn() };
  const actions = new ActionsPanel(
    core as unknown as SectSceneCore,
    data as unknown as DataHandlers,
    modals as unknown as ModalsHandlers,
  );
  return { core, data, modals, actions };
}

// ── Join-sect flow ───────────────────────────────────────────────────────────

describe('SectScene — openBrowseList()', () => {
  it('fetches the world sect list and opens the picker wired to doJoin', async () => {
    const sects = [makeSectView('s1', 'Alpha'), makeSectView('s2', 'Beta')];
    const { core, modals, actions } = buildScene();
    core.cb.worldApi.listSects.mockResolvedValueOnce(sects);

    await actions.openBrowseList();

    expect(core.cb.worldApi.listSects).toHaveBeenCalledWith('w1');
    expect(core.sectsCache).toEqual(sects);
    expect(modals.showSectPickModal).toHaveBeenCalledTimes(1);
    const [list, onPick, emptyKey] = modals.showSectPickModal.mock.calls[0]!;
    expect(list).toEqual(sects);
    expect(emptyKey).toBe('sect.noSects');

    // Picking a row drives the real doJoin — spy on it via the prototype-level method.
    const doJoinSpy = vi.spyOn(actions, 'doJoin').mockResolvedValue(undefined);
    onPick('s2');
    expect(doJoinSpy).toHaveBeenCalledWith('s2');
  });

  it('shows a toast and never opens the picker when the fetch fails', async () => {
    const { core, modals, actions } = buildScene();
    core.cb.worldApi.listSects.mockRejectedValueOnce(new Error('down'));

    await actions.openBrowseList();

    expect(modals.showSectPickModal).not.toHaveBeenCalled();
    expect(core.showToast).toHaveBeenCalledTimes(1);
  });
});

describe('SectScene — doJoin()', () => {
  it('joins, closes the modal, and loads the newly-joined sect', async () => {
    const { core, data, actions } = buildScene();

    await actions.doJoin('sect_target');

    expect(core.cb.worldApi.joinSect).toHaveBeenCalledWith('w1', 'sect_target');
    expect(core.closeModal).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).toHaveBeenCalledWith('sect_target');
    expect(core.bt.busy).toBe(false);
  });

  it('a second call while the first is in flight does not re-issue the join request', async () => {
    const { core, actions } = buildScene();
    core.cb.worldApi.joinSect.mockReturnValueOnce(new Promise<{ ok: true }>(() => {})); // never resolves

    void actions.doJoin('sect_target');
    void actions.doJoin('sect_target');
    await Promise.resolve();

    expect(core.cb.worldApi.joinSect).toHaveBeenCalledTimes(1);
    expect(core.bt.busy).toBe(true);
  });

  it('a failed join shows a toast, does not load the sect, and unlocks', async () => {
    const { core, data, actions } = buildScene();
    core.cb.worldApi.joinSect.mockRejectedValueOnce(new WorldApiError('SECT_FULL', 'full'));

    await actions.doJoin('sect_target');

    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).not.toHaveBeenCalled();
    expect(core.bt.busy).toBe(false);
  });
});

// ── Ally / unally ────────────────────────────────────────────────────────────

describe('SectScene — openAllyList()', () => {
  it('excludes own sect and already-allied sects from the candidate list', async () => {
    const sect = makeSect({ sectId: 'sect_me', allySectIds: ['sect_ally1'] });
    const { core, modals, actions } = buildScene({ sect });
    core.cb.worldApi.listSects.mockResolvedValueOnce([
      makeSectView('sect_me', 'Mine'),
      makeSectView('sect_ally1', 'Already Allied'),
      makeSectView('sect_new', 'New Candidate'),
    ]);

    await actions.openAllyList();

    const [candidates, , emptyKey] = modals.showSectPickModal.mock.calls[0]!;
    expect(candidates.map((s: SectView) => s.sectId)).toEqual(['sect_new']);
    expect(emptyKey).toBe('sect.noSects');
  });

  it('picking a candidate routes to confirmAlly with a resolved label', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const { core, modals, actions } = buildScene({ sect });
    core.cb.worldApi.listSects.mockResolvedValueOnce([makeSectView('sect_new', 'New Candidate')]);

    await actions.openAllyList();
    const confirmAllySpy = vi.spyOn(actions, 'confirmAlly');
    const onPick = modals.showSectPickModal.mock.calls[0]![1];
    onPick('sect_new');

    expect(confirmAllySpy).toHaveBeenCalledWith('sect_new', '[NEW] New Candidate');
  });

  it('is a no-op when the player has no sect', async () => {
    const { core, actions } = buildScene({ sect: null });
    await actions.openAllyList();
    expect(core.cb.worldApi.listSects).not.toHaveBeenCalled();
  });
});

describe('SectScene — confirmAlly() wiring', () => {
  it('shows a confirm dialog whose OK action calls doAlly with the target id', () => {
    const { modals, actions } = buildScene();
    const doAllySpy = vi.spyOn(actions, 'doAlly').mockResolvedValue(undefined);

    actions.confirmAlly('sect_target', '[TAG] Target Sect');

    expect(modals.showConfirm).toHaveBeenCalledTimes(1);
    const [msg, onOk] = modals.showConfirm.mock.calls[0]!;
    expect(msg).toContain('Target Sect');
    onOk();
    expect(doAllySpy).toHaveBeenCalledWith('sect_target');
  });
});

describe('SectScene — doAlly()', () => {
  it('allies, closes the modal, and reloads the sect', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const { core, data, actions } = buildScene({ sect });

    await actions.doAlly('sect_target');

    expect(core.cb.worldApi.allySect).toHaveBeenCalledWith('w1', 'sect_target');
    expect(core.closeModal).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).toHaveBeenCalledWith('sect_me');
    expect(core.bt.busy).toBe(false);
  });

  it('a second call while the first is in flight does not re-issue the request', async () => {
    const { core, actions } = buildScene({ sect: makeSect() });
    core.cb.worldApi.allySect.mockReturnValueOnce(new Promise<{ ok: true }>(() => {}));

    void actions.doAlly('sect_target');
    void actions.doAlly('sect_target');
    await Promise.resolve();

    expect(core.cb.worldApi.allySect).toHaveBeenCalledTimes(1);
  });

  it('shows a toast and does not reload the sect on failure', async () => {
    const { core, data, actions } = buildScene({ sect: makeSect() });
    core.cb.worldApi.allySect.mockRejectedValueOnce(new WorldApiError('ALLY_CAP_REACHED', 'cap'));

    await actions.doAlly('sect_target');

    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).not.toHaveBeenCalled();
  });
});

describe('SectScene — openManageAllies()', () => {
  it('resolves the sect ally-id list to names and routes a pick through confirmUnally', async () => {
    const sect = makeSect({ sectId: 'sect_me', allySectIds: ['sect_ally1', 'sect_gone'] });
    const { core, modals, actions } = buildScene({ sect });
    core.cb.worldApi.listSects.mockResolvedValueOnce([
      makeSectView('sect_ally1', 'Old Friend'),
      // 'sect_gone' has since been dissolved — must not blow up resolving it, just drop it.
    ]);

    await actions.openManageAllies();

    const [allies, onPick] = modals.showSectPickModal.mock.calls[0]!;
    expect(allies.map((s: SectView) => s.sectId)).toEqual(['sect_ally1']);

    const confirmUnallySpy = vi.spyOn(actions, 'confirmUnally');
    onPick('sect_ally1');
    expect(confirmUnallySpy).toHaveBeenCalledWith('sect_ally1', '[OLD] Old Friend');
  });
});

describe('SectScene — doUnally()', () => {
  it('unallies and reloads the sect', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const { core, data, actions } = buildScene({ sect });

    await actions.doUnally('sect_ally1');

    expect(core.cb.worldApi.unallySect).toHaveBeenCalledWith('w1', 'sect_ally1');
    expect(core.closeModal).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).toHaveBeenCalledWith('sect_me');
  });

  it('shows a toast on failure without reloading', async () => {
    const { core, data, actions } = buildScene({ sect: makeSect() });
    core.cb.worldApi.unallySect.mockRejectedValueOnce(new Error('boom'));

    await actions.doUnally('sect_ally1');

    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).not.toHaveBeenCalled();
  });
});

describe('SectScene — openAlliesView() (read-only)', () => {
  it('resolves ally ids to full SectView objects for a member-facing read-only picker', async () => {
    const sect = makeSect({ sectId: 'sect_me', allySectIds: ['sect_ally1'] });
    const { core, modals, actions } = buildScene({ sect });
    core.cb.worldApi.listSects.mockResolvedValueOnce([makeSectView('sect_ally1', 'Old Friend')]);

    await actions.openAlliesView();

    const [allies, , emptyKey, readOnly] = modals.showSectPickModal.mock.calls[0]!;
    expect(allies.map((s: SectView) => s.sectId)).toEqual(['sect_ally1']);
    expect(emptyKey).toBe('sect.noAllies');
    expect(readOnly).toBe(true);
  });
});

// ── Leader-removal vote ──────────────────────────────────────────────────────

describe('SectScene — confirmVote() wiring', () => {
  it('shows a confirm dialog naming the nominee whose OK action calls doVote', () => {
    const { modals, actions } = buildScene();
    const doVoteSpy = vi.spyOn(actions, 'doVote').mockResolvedValue(undefined);

    actions.confirmVote('fam_2', '[G1] Guild One');

    const [msg, onOk] = modals.showConfirm.mock.calls[0]!;
    expect(msg).toContain('Guild One');
    onOk();
    expect(doVoteSpy).toHaveBeenCalledWith('fam_2');
  });
});

describe('SectScene — doVote()', () => {
  it('a passing vote toasts the leadership-changed message and reloads the sect', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const { core, data, actions } = buildScene({ sect });
    core.cb.worldApi.voteRemoveSectLeader.mockResolvedValueOnce({ passed: true, voteCount: 3, needed: 3 });

    await actions.doVote('fam_2');

    expect(core.cb.worldApi.voteRemoveSectLeader).toHaveBeenCalledWith('w1', 'fam_2');
    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(core.showToast.mock.calls[0]![0]).not.toContain('/'); // votePassed has no cur/need interpolation
    expect(data.loadMySect).toHaveBeenCalledWith('sect_me');
  });

  it('a non-passing vote toasts the running tally and still reloads (a family may have gained/lost members)', async () => {
    const sect = makeSect({ sectId: 'sect_me' });
    const { core, data, actions } = buildScene({ sect });
    core.cb.worldApi.voteRemoveSectLeader.mockResolvedValueOnce({ passed: false, voteCount: 1, needed: 3 });

    await actions.doVote('fam_2');

    expect(core.showToast.mock.calls[0]![0]).toContain('1');
    expect(core.showToast.mock.calls[0]![0]).toContain('3');
    expect(data.loadMySect).toHaveBeenCalledWith('sect_me');
  });

  it('a second call while the first is in flight does not re-issue the vote', async () => {
    const { core, actions } = buildScene({ sect: makeSect() });
    core.cb.worldApi.voteRemoveSectLeader.mockReturnValueOnce(new Promise(() => {}));

    void actions.doVote('fam_2');
    void actions.doVote('fam_2');
    await Promise.resolve();

    expect(core.cb.worldApi.voteRemoveSectLeader).toHaveBeenCalledTimes(1);
  });

  it('shows a toast and does not reload on failure', async () => {
    const { core, data, actions } = buildScene({ sect: makeSect() });
    core.cb.worldApi.voteRemoveSectLeader.mockRejectedValueOnce(new TimeoutError());

    await actions.doVote('fam_2');

    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadMySect).not.toHaveBeenCalled();
  });
});

// ── Channel send ─────────────────────────────────────────────────────────────

describe('SectScene — doSendChannelMessage() guards', () => {
  it('does nothing for a blank draft', async () => {
    const { core, actions } = buildScene({ sect: makeSect(), channelInput: '' });
    await actions.doSendChannelMessage();
    expect(core.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });

  it('does nothing for a whitespace-only draft', async () => {
    const { core, actions } = buildScene({ sect: makeSect(), channelInput: '   ' });
    await actions.doSendChannelMessage();
    expect(core.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });

  it('does nothing while already sending (double-tap guard)', async () => {
    const { core, actions } = buildScene({ sect: makeSect(), channelInput: 'hi', channelSending: true });
    await actions.doSendChannelMessage();
    expect(core.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });

  it('does nothing without a sect', async () => {
    const { core, actions } = buildScene({ sect: null, channelInput: 'hi' });
    await actions.doSendChannelMessage();
    expect(core.cb.worldApi.sendSectMessage).not.toHaveBeenCalled();
  });
});

describe('SectScene — doSendChannelMessage() success', () => {
  it('trims the draft, sends it, clears the input, and refetches the channel', async () => {
    const removeSpy = vi.fn();
    const { core, data, actions } = buildScene({ sect: makeSect(), channelInput: '  hello sect  ', hiddenInput: { remove: removeSpy } });

    await actions.doSendChannelMessage();

    expect(core.cb.worldApi.sendSectMessage).toHaveBeenCalledWith('w1', 'hello sect', 'Tester');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(core.hiddenInput).toBeNull();
    expect(core.channelInput).toBe('');
    expect(core.channelSending).toBe(false);
    expect(core.channelStick).toBe(true);
    expect(data.loadChannel).toHaveBeenCalledTimes(1);
    // One render to show the "sending…" state, one more once it settles.
    expect(core.render).toHaveBeenCalledTimes(2);
  });
});

describe('SectScene — doSendChannelMessage() failure', () => {
  it('shows a toast, keeps the draft, and does not refetch the channel', async () => {
    const { core, data, actions } = buildScene({ sect: makeSect(), channelInput: 'doomed' });
    core.cb.worldApi.sendSectMessage.mockRejectedValueOnce(new Error('network down'));

    await actions.doSendChannelMessage();

    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadChannel).not.toHaveBeenCalled();
    expect(core.channelInput).toBe('doomed'); // draft survives a failed send so the user can retry
    expect(core.channelSending).toBe(false);
  });

  it('does not render a second time once the scene is destroyed mid-flight', async () => {
    const { core, actions } = buildScene({ sect: makeSect(), channelInput: 'hi' });
    let resolveSend!: (v: { id: string; senderId: string; senderName: string; body: string; ts: number }) => void;
    core.cb.worldApi.sendSectMessage.mockReturnValueOnce(
      new Promise((r) => { resolveSend = r; }),
    );

    const pending = actions.doSendChannelMessage();
    core.render.mockClear();
    core.destroyed = true;
    resolveSend({ id: 'm1', senderId: 'me', senderName: 'Tester', body: 'hi', ts: 0 });
    await pending;

    expect(core.render).not.toHaveBeenCalled();
  });
});
