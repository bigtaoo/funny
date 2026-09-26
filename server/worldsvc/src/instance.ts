// Process identity for a worldsvc that may run as more than one process (WORLDSVC_CONCURRENCY_AUDIT §12.7
// phase 1: the multi-process correctness prerequisites).
//
// Three things need to tell processes apart: metrics (a heartbeat or /admin/world/metrics snapshot is one
// process's view, and two of them must not be read as one), cross-process cache invalidation (a process
// must be able to ignore its own broadcasts), and the in-process id sequences (see `initialSeq`).
import { hostname } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';

/** `host:pid:nonce`. The nonce keeps two containers that both report pid 1 on a shared hostname apart. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

/**
 * Starting value for a per-process id counter (marchSeq / siegeSeq). The ids those counters feed are
 * `{world}:{owner}:{ms}:{seq}`, so two processes both starting at 0 would mint the SAME id for the same
 * owner in the same millisecond — and so would one process restarted within that millisecond window. A
 * random 40-bit start makes an overlap need the same owner, the same millisecond AND two counters landing
 * on the same value; the id's unique `_id` turns the remaining case into a failed insert, never a merge.
 * Stays well inside Number.MAX_SAFE_INTEGER after any realistic number of increments.
 */
export function initialSeq(): number {
  return randomInt(0, 2 ** 40);
}
