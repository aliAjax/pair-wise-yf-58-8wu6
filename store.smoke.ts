/* 冒烟测试：验证版本绑定审批、跨页过期拒绝、生效快照、幂等停止/回滚、失败重试与重启恢复 */
import { createPinia } from 'pinia';
import { useFlagStore, STORAGE_KEY } from './src/stores/flags';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map
  };
}
const sharedLocal = makeStorage(); // 两个标签页共享同一个 localStorage
(globalThis as Record<string, unknown>).localStorage = sharedLocal;
(globalThis as Record<string, unknown>).sessionStorage = makeStorage();

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name}`, extra ?? ''); }
}

// ---- 场景一：两个标签页同时打开 ----
const tabA = useFlagStore(createPinia()); // 值班人页面
const tabB = useFlagStore(createPinia()); // 另一页面
check('两个标签页加载相同初始版本', tabA.activeVersion?.version === 3 && tabB.activeVersion?.version === 3);

// 标签页 A：产品、研发双审批 v3
check('A 产品审批成功', tabA.approve('产品负责人').ok);
check('A 研发审批成功', tabA.approve('研发负责人').ok);
check('A 重复审批被忽略', !tabA.approve('产品负责人').ok);
check('v3 通过双审批', tabA.isActiveVersionApproved);

// 标签页 B：批准后另一页同步到最新，再改规则 → 生成 v4 待审版本（旧审批随之失效）
check('B 过期时修改同样被拒绝', !tabB.updateRule({ region: '广东' }).ok);
tabB.syncLatest();
check('B 修改规则成功', tabB.updateRule({ region: '北京' }).ok);
check('B 生成 v4 待审版本', tabB.activeVersion?.version === 4 && tabB.activeVersion?.status === 'pending');
check('v4 审批为空（审批绑定旧版本 v3）', tabB.activeVersion?.approvals.length === 0);

// 标签页 A：仍按旧批准操作 → 过期拒绝
const staleEdit = tabA.updateRule({ region: '广东' });
check('A 过期页面修改规则被拒绝', !staleEdit.ok);
const staleStart = tabA.startRollout();
check('A 过期页面发布被拒绝', !staleStart.ok && (staleStart.reason ?? '').includes('过期'), staleStart.reason);
check('A 被标记为过期', tabA.stale);

// A 同步最新状态后：v4 未审批，发布仍被拒绝（审批失效）
tabA.syncLatest();
check('A 同步后不再过期', !tabA.stale);
const invalidStart = tabA.startRollout();
check('A 按旧审批发布被拒绝并提示审批失效', !invalidStart.ok && (invalidStart.reason ?? '').includes('审批失效'), invalidStart.reason);

// ---- 场景二：重新审批 v4 后开始灰度，快照生效 ----
tabA.approve('产品负责人');
tabA.approve('研发负责人');
check('v4 重新双审批后发布成功', tabA.startRollout().ok);
const batch = tabA.activeBatch;
check('生成当前批次', !!batch && batch.state === 'rolling');
check('批次快照冻结 v4 规则（北京）', batch?.snapshot.rules.region === '北京');
check('开关进入灰度', tabA.active?.status === 'rolling' && tabA.active?.enabled);

// 灰度中改规则：只生成待审版本，快照不变
check('灰度中修改规则成功', tabA.updateRule({ region: '上海' }).ok);
check('灰度中生成 v5 待审版本', tabA.activeVersion?.version === 5 && tabA.activeVersion?.status === 'pending');
check('当前批次快照不受影响（仍北京）', tabA.activeBatch?.snapshot.rules.region === '北京');
check('开关仍在灰度', tabA.active?.status === 'rolling');

// 命中模拟读取生效快照
const missHit = tabA.simulateHit({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
check('模拟按快照规则判定（上海不命中北京快照）', !missHit.hit && missHit.source === 'snapshot' && missHit.reason.includes('生效快照'), missHit.reason);
const snapHit = tabA.simulateHit({ id: 'user-1042', region: '北京', appVersion: '8.3.0', authenticated: true });
check('快照模拟命中逻辑正常', snapHit.source === 'snapshot');

// 审计记录携带批次与版本（读取生效快照上下文）
const editAudit = tabA.audit.find((item) => item.action === '修改规则');
check('灰度期审计记录关联当前批次', editAudit?.batchId === batch?.id && editAudit?.version === 5, editAudit);

// ---- 场景三：紧急停止/回滚只处理当前批次且幂等 ----
check('紧急停止成功', tabA.emergencyStop().ok);
check('批次已停止', tabA.activeBatch === undefined);
const dupStop = tabA.emergencyStop();
check('重复紧急停止被忽略', !dupStop.ok && (dupStop.reason ?? '').includes('重复') || (dupStop.reason ?? '').includes('没有进行中'));
check('紧急停止只记录一次审计', tabA.audit.filter((item) => item.action === '紧急停止').length === 1);

check('停止后可回滚当前批次', tabA.rollback().ok);
const dupRollback = tabA.rollback();
check('重复回滚被忽略', !dupRollback.ok);
check('回滚只记录一次审计', tabA.audit.filter((item) => item.action === '执行回滚').length === 1);
check('回滚后开关关闭', tabA.active?.enabled === false && tabA.active?.status === 'rolled-back');

// 停止后模拟回到草稿（待审版本）
const draftHit = tabA.simulateHit({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
check('停止后模拟读取待审草稿', draftHit.source === 'draft' && draftHit.reason.includes('v5'), draftHit.reason);

// ---- 场景四：写入失败保留重试项与原状态，重启后恢复 ----
tabA.setStorageFailure(true);
check('故障下修改规则仍返回成功（内存已改）', tabA.updateRule({ region: '广东' }).ok);
check('写入失败进入重试队列', tabA.failedWrites.length === 1, tabA.failedWrites.length);
check('失败项保留原状态快照', tabA.failedWrites[0]?.snapshot.includes('广东'));
tabA.setRollout(50);
check('连续失败累积重试项', tabA.failedWrites.length === 2);

tabA.setStorageFailure(false);
check('存储恢复后重试成功', tabA.retryFailedWrites().ok);
check('重试后队列清空', tabA.failedWrites.length === 0);

// 模拟重启：新 store 从持久化恢复
const tabC = useFlagStore(createPinia());
check('重启后恢复最新版本（广东 v7）', tabC.activeVersion?.rules.region === '广东' && tabC.activeVersion?.version === 7, tabC.activeVersion?.version);
check('重启后恢复 50% 放量', tabC.activeVersion?.rollout === 50);
check('重启后审计包含写入恢复', tabC.audit.some((item) => item.action === '写入恢复'));

// 故障中重启：失败队列独立持久化，重启后仍可见
tabC.setStorageFailure(true);
tabC.updateRule({ region: '北京' });
check('故障中产生新失败项', tabC.failedWrites.length === 1);
const tabD = useFlagStore(createPinia()); // 模拟重启
check('重启后能分清失败项', tabD.failedWrites.length === 1);
check('重启后能分清当前批次', tabD.batches.length > 0 && tabD.batches[0]?.state === 'rolled-back');
check('重启后能分清待审版本', tabD.activeVersion?.status === 'pending');
check('重启后重试成功', tabD.retryFailedWrites().ok && tabD.failedWrites.length === 0);
const tabE = useFlagStore(createPinia());
check('重试补写的内容已持久化', tabE.activeVersion?.rules.region === '北京');

// 全局审计幂等键无重复
const keys = tabE.audit.map((item) => item.idempotencyKey).filter(Boolean);
check('审计幂等键无重复', new Set(keys).size === keys.length);
check('持久化包含 revision 字段', (JSON.parse(sharedLocal.getItem(STORAGE_KEY) ?? '{}') as { revision?: number }).revision !== undefined);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
