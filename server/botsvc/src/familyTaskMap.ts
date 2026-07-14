// Family task → fixed action mapping (BOTSVC_DESIGN §6, B7). Bots do not parse task semantics; unknown
// task types resolve to 'skip' rather than forcing a guess. Adding a new task type is one row here,
// no scheduler/behavior changes required.
export type FamilyTaskAction = 'donate_resource' | 'start_battle' | 'upgrade_building' | 'skip';

const FAMILY_TASK_ACTION_MAP: Record<string, FamilyTaskAction> = {
  donate_resource_x: 'donate_resource',
  kill_monster_x: 'start_battle',
  upgrade_building_x: 'upgrade_building',
};

export function actionForFamilyTask(taskType: string): FamilyTaskAction {
  return FAMILY_TASK_ACTION_MAP[taskType] ?? 'skip';
}
