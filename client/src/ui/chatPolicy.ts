// Whether player-to-player chat is shown at all. Off only where the platform says so
// (IPlatform.watchChatDisabled — CrazyGames' `disableChat` setting, CRAZYGAMES_LAUNCH.md §4.2);
// every other platform never calls setChatDisabled, so chat stays on there.
//
// While off: the world tab and its world-map preview bar, the family/sect channels and every
// "Message" action are hidden. Friends, family, sect and mail themselves stay — they are not chat.

let disabled = false;

export function setChatDisabled(v: boolean): void { disabled = v; }

export function isChatDisabled(): boolean { return disabled; }
