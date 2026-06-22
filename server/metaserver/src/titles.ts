// 称号授予 DB 写辅助（S10，TITLE_DESIGN §2）。
// grantTitle 纯函数在 @nw/shared；本模块负责把计算结果原子写 MongoDB。
// 幂等：$addToSet 保证同 titleId 重复调用安全。
import type { Collections } from '@nw/shared';
import { grantTitle } from '@nw/shared';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:titles');

/**
 * 把 titleId 授予指定玩家：
 *   1. 读当前 titles[] + equipped.title
 *   2. 用 grantTitle 纯函数计算新状态
 *   3. $addToSet 写 titles；若自动佩戴变更则同步 $set equipped.title
 *
 * 幂等：已拥有则提前返回。玩家 save 不存在时跳过（首次登录惰性创建后再授）。
 */
export async function grantTitleToPlayer(
  cols: Collections,
  accountId: string,
  titleId: string,
  now: number,
): Promise<void> {
  const doc = await cols.saves.findOne({ _id: accountId }, {
    projection: { 'save.titles': 1, 'save.equipped': 1 },
  });
  if (!doc) {
    log.warn('grantTitleToPlayer: no save found, skip', { accountId, titleId });
    return;
  }

  const prevTitles: string[] = (doc.save as { titles?: string[] }).titles ?? [];
  if (prevTitles.includes(titleId)) return; // 已有，幂等返回

  const prevEquipped: string | undefined = (doc.save.equipped as Record<string, string> | undefined)?.['title'];
  const { equippedTitle } = grantTitle(prevTitles, prevEquipped, titleId);

  const setFields: Record<string, unknown> = { 'save.updatedAt': now };
  if (equippedTitle !== prevEquipped) {
    setFields['save.equipped.title'] = equippedTitle;
  }

  await cols.saves.updateOne(
    { _id: accountId },
    { $addToSet: { 'save.titles': titleId } as Record<string, unknown>, $set: setFields },
  );
  log.info('grantTitleToPlayer: granted', { accountId, titleId, equippedTitle });
}
