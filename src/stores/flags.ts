import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export type VersionStatus = 'pending' | 'approved' | 'published' | 'superseded';
export type BatchState = 'rolling' | 'stopped' | 'rolled-back' | 'superseded';

export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface Approval { role: string; at: string; }
export interface PlanVersion {
  version: number;
  rules: RuleSet;
  rollout: number;
  scheduledAt: string;
  status: VersionStatus;
  approvals: Approval[];
  createdAt: string;
  source: string;
}
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; status: FlagStatus; }
export interface RolloutPlan { id: string; flagId: string; versions: PlanVersion[]; }
export interface Batch {
  id: string;
  flagId: string;
  version: number;
  snapshot: { rules: RuleSet; rollout: number };
  startedAt: string;
  endedAt?: string;
  state: BatchState;
  operations: string[];
}
export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  idempotencyKey?: string;
  batchId?: string;
  version?: number;
}
export interface FailedWrite { id: string; at: string; reason: string; summary: string; snapshot: string; retries: number; }
export interface Result { ok: boolean; reason?: string; level?: 'error' | 'warning'; }

interface PersistedState {
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  batches: Batch[];
  audit: AuditRecord[];
  activeId: string;
  revision: number;
  writeSeq: number;
}
interface State extends PersistedState { failedWrites: FailedWrite[]; stale: boolean; storageFailure: boolean; }

export const REQUIRED_ROLES = ['产品负责人', '研发负责人'];
export const STORAGE_KEY = 'yf58-flag-state';
const FAILED_KEY = 'yf58-flag-failed-writes';

const now = () => new Date().toLocaleTimeString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const seed: PersistedState = {
  revision: 0,
  writeSeq: 0,
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, status: 'draft' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, status: 'rolling' }
  ],
  plans: [
    {
      id: 'p1',
      flagId: 'f1',
      versions: [
        { version: 1, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, rollout: 5, scheduledAt: '2026-10-01T10:00', status: 'superseded', approvals: [], createdAt: '09:02:11', source: '初始草稿' },
        { version: 2, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, rollout: 5, scheduledAt: '2026-10-01T10:00', status: 'superseded', approvals: [], createdAt: '09:08:40', source: '收紧地区与登录要求' },
        { version: 3, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, rollout: 10, scheduledAt: '2026-10-01T10:00', status: 'pending', approvals: [], createdAt: '09:10:25', source: '放量调整至 10%' }
      ]
    },
    {
      id: 'p2',
      flagId: 'f2',
      versions: [
        { version: 1, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, rollout: 35, scheduledAt: '2026-09-30T09:00', status: 'published', approvals: [{ role: '产品负责人', at: '08:40:02' }, { role: '研发负责人', at: '08:45:31' }], createdAt: '08:30:00', source: '初始版本' }
      ]
    }
  ],
  batches: [
    { id: 'b-seed-f2', flagId: 'f2', version: 1, snapshot: { rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, rollout: 35 }, startedAt: '08:50:00', state: 'rolling', operations: [] }
  ],
  audit: [
    { id: 'a1', at: '09:10:25', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22:08', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' },
    { id: 'a3', at: '08:50:00', actor: '值班人员', action: '开始放量', detail: 'recommend-model-b 批次 b-seed-f2 按 v1 生效快照启用 35%', batchId: 'b-seed-f2', version: 1 }
  ]
};

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState;
      return { ...clone(seed), ...parsed, revision: parsed.revision ?? 0, writeSeq: parsed.writeSeq ?? 0 };
    }
  } catch { /* 数据损坏时回退到种子数据 */ }
  return clone(seed);
}

function loadFailedWrites(): FailedWrite[] {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const raw = storage.getItem(FAILED_KEY);
      if (raw) return JSON.parse(raw) as FailedWrite[];
    } catch { /* 尝试下一个存储 */ }
  }
  return [];
}

function evaluate(rules: RuleSet, rollout: number, user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
  if (rules.region !== '全部' && rules.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rules.region}）` };
  if (rules.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
  const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
  const hit = hash < rollout;
  return { hit, reason: hit ? `灰度桶 ${hash} < ${rollout}%` : `灰度桶 ${hash} ≥ ${rollout}%` };
}

const staleResult: Result = { ok: false, reason: '页面数据已过期：另一页面已提交修改，审批可能已失效。请同步最新状态后重试。' };

export const useFlagStore = defineStore('flags', {
  state: (): State => ({ ...loadPersisted(), failedWrites: loadFailedWrites(), stale: false, storageFailure: false }),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    activeVersion(): PlanVersion | undefined {
      const plan = this.activePlan;
      return plan && plan.versions.length ? plan.versions[plan.versions.length - 1] : undefined;
    },
    activeBatch(): Batch | undefined { return this.batches.find((item) => item.flagId === this.activeId && item.state === 'rolling'); },
    isActiveVersionApproved(): boolean {
      const version = this.activeVersion;
      return !!version && REQUIRED_ROLES.every((role) => version.approvals.some((item) => item.role === role));
    },
    versionOf: (state) => (flagId: string): PlanVersion | undefined => {
      const plan = state.plans.find((item) => item.flagId === flagId);
      return plan && plan.versions.length ? plan.versions[plan.versions.length - 1] : undefined;
    },
    batchesOf: (state) => (flagId: string): Batch[] => state.batches.filter((item) => item.flagId === flagId)
  },
  actions: {
    persist(): boolean {
      let storedRevision = 0;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) storedRevision = (JSON.parse(raw) as PersistedState).revision ?? 0;
      } catch { /* 读取失败按 0 处理 */ }
      // 乐观并发：另一标签页已写入更新数据时，拒绝覆盖并标记过期
      if (storedRevision !== this.revision) { this.stale = true; return false; }
      const payload: PersistedState = {
        flags: this.flags,
        plans: this.plans,
        batches: this.batches,
        audit: this.audit,
        activeId: this.activeId,
        revision: this.revision + 1,
        writeSeq: this.writeSeq + 1
      };
      const serialized = JSON.stringify(payload);
      try {
        if (this.storageFailure) throw new Error('模拟的存储故障（localStorage 写入被拒绝）');
        localStorage.setItem(STORAGE_KEY, serialized);
        this.revision = payload.revision;
        this.writeSeq = payload.writeSeq;
        return true;
      } catch (err) {
        // 写入失败：保留重试项和原状态快照，重启后仍可恢复；writeSeq 照样递增，保证重试队列严格有序
        this.writeSeq = payload.writeSeq;
        const flag = this.active;
        const version = this.activeVersion;
        this.failedWrites.push({
          id: uid('w'),
          at: now(),
          reason: err instanceof Error ? err.message : String(err),
          summary: flag && version ? `${flag.key} · v${version.version} · ${flag.status}` : '状态快照',
          snapshot: serialized,
          retries: 0
        });
        this.persistFailedQueue();
        return false;
      }
    },
    persistFailedQueue() {
      const raw = JSON.stringify(this.failedWrites);
      try { localStorage.setItem(FAILED_KEY, raw); return; } catch { /* 主存储不可用时降级到 sessionStorage */ }
      try { sessionStorage.setItem(FAILED_KEY, raw); } catch { /* 仅保留在内存中 */ }
    },
    guardFresh(): boolean {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw && ((JSON.parse(raw) as PersistedState).revision ?? 0) !== this.revision) { this.stale = true; return false; }
      } catch { /* 读取失败不阻塞操作 */ }
      return true;
    },
    syncLatest() {
      const persisted = loadPersisted();
      this.flags = persisted.flags;
      this.plans = persisted.plans;
      this.batches = persisted.batches;
      this.audit = persisted.audit;
      this.activeId = persisted.activeId;
      this.revision = persisted.revision;
      this.writeSeq = persisted.writeSeq;
      this.stale = false;
    },
    recordAudit(action: string, detail: string, actor = '当前操作人', extra?: { idempotencyKey?: string; batchId?: string; version?: number }) {
      // 幂等：同一幂等键的操作只记录一次
      if (extra?.idempotencyKey && this.audit.some((item) => item.idempotencyKey === extra.idempotencyKey)) return;
      const live = this.batches.find((item) => item.flagId === this.activeId && item.state === 'rolling');
      this.audit.unshift({
        id: uid('a'),
        at: now(),
        actor,
        action,
        detail,
        idempotencyKey: extra?.idempotencyKey,
        batchId: extra?.batchId ?? live?.id,
        version: extra?.version ?? live?.version
      });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },
    createFlag(name: string, key: string) {
      const id = uid('f');
      this.flags.push({ id, name, key, enabled: false, status: 'draft' });
      this.plans.push({
        id: uid('p'),
        flagId: id,
        versions: [{ version: 1, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, rollout: 0, scheduledAt: '2026-10-02T10:00', status: 'pending', approvals: [], createdAt: now(), source: '初始草稿' }]
      });
      this.activeId = id;
      this.recordAudit('创建开关', `${key} 草稿版本 v1`);
    },
    commitVersion(source: string, patch: { rules?: Partial<RuleSet>; rollout?: number; scheduledAt?: string }): PlanVersion | undefined {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || !plan.versions.length) return undefined;
      const prev = plan.versions[plan.versions.length - 1];
      // 旧版本上的审批绑定旧版本，新修改生成新的待审版本
      for (const item of plan.versions) if (item.status === 'pending' || item.status === 'approved') item.status = 'superseded';
      const version: PlanVersion = {
        version: prev.version + 1,
        rules: { ...clone(prev.rules), ...(patch.rules ?? {}) },
        rollout: patch.rollout ?? prev.rollout,
        scheduledAt: patch.scheduledAt ?? prev.scheduledAt,
        status: 'pending',
        approvals: [],
        createdAt: now(),
        source
      };
      plan.versions.push(version);
      if (flag.status !== 'rolling') flag.status = 'draft';
      return version;
    },
    updateRule(patch: Partial<RuleSet>): Result {
      if (!this.guardFresh()) return staleResult;
      const flag = this.active;
      const version = this.commitVersion('修改规则', { rules: patch });
      if (!flag || !version) return { ok: false, reason: '未选择开关' };
      const rolling = flag.status === 'rolling';
      this.recordAudit('修改规则', `${flag.key} 生成待审版本 v${version.version}${rolling ? '，当前批次仍按生效快照运行' : ''}`, '当前操作人', { version: version.version });
      return { ok: true };
    },
    setRollout(value: number): Result {
      if (!this.guardFresh()) return staleResult;
      const flag = this.active;
      const version = this.commitVersion('调整放量', { rollout: value });
      if (!flag || !version) return { ok: false, reason: '未选择开关' };
      this.recordAudit('调整放量', `${flag.key} 生成待审版本 v${version.version}（${value}%）`, '当前操作人', { version: version.version });
      return { ok: true };
    },
    schedule(value: string): Result {
      if (!this.guardFresh()) return staleResult;
      const flag = this.active;
      const version = this.commitVersion('设置定时', { scheduledAt: value });
      if (!flag || !version) return { ok: false, reason: '未选择开关' };
      if (flag.status !== 'rolling') flag.status = 'scheduled';
      this.recordAudit('设置定时', `${flag.key} v${version.version} 于 ${value} 生效`, '当前操作人', { version: version.version });
      return { ok: true };
    },
    approve(role: string): Result {
      if (!this.guardFresh()) return staleResult;
      const flag = this.active;
      const version = this.activeVersion;
      if (!flag || !version) return { ok: false, reason: '未选择开关' };
      if (version.approvals.some((item) => item.role === role)) {
        return { ok: false, level: 'warning', reason: `${role} 已审批过 v${version.version}，重复操作已忽略` };
      }
      version.approvals.push({ role, at: now() });
      if (REQUIRED_ROLES.every((item) => version.approvals.some((entry) => entry.role === item))) {
        version.status = 'approved';
        if (flag.status !== 'rolling') flag.status = 'approved';
      }
      this.recordAudit('审批发布', `${role} 批准 ${flag.key} v${version.version}（审批绑定该版本）`, role, {
        idempotencyKey: `approve:${flag.id}:v${version.version}:${role}`,
        version: version.version
      });
      return { ok: true };
    },
    startRollout(): Result {
      if (!this.guardFresh()) return { ok: false, reason: '发布被拒绝：页面数据已过期，审批可能已失效。请同步最新状态并重新确认审批。' };
      const flag = this.active;
      const version = this.activeVersion;
      if (!flag || !version) return { ok: false, reason: '未选择开关' };
      if (!this.isActiveVersionApproved) {
        return { ok: false, reason: `审批失效：v${version.version} 未通过双审批。审批绑定修改时的版本，规则变更后需重新审批。` };
      }
      const live = this.batches.find((item) => item.flagId === flag.id && item.state === 'rolling');
      if (live && live.version === version.version) {
        return { ok: false, level: 'warning', reason: `v${version.version} 已在灰度中（批次 ${live.id}），重复发布已忽略` };
      }
      if (live) {
        live.state = 'superseded';
        live.endedAt = now();
        this.recordAudit('批次替换', `${flag.key} 批次 ${live.id}（v${live.version}）被 v${version.version} 替换`, '当前操作人', { batchId: live.id, version: live.version });
      }
      // 冻结生效快照：灰度期间的命中模拟与审计记录都读取该快照
      const batch: Batch = {
        id: uid('b'),
        flagId: flag.id,
        version: version.version,
        snapshot: { rules: clone(version.rules), rollout: version.rollout },
        startedAt: now(),
        state: 'rolling',
        operations: []
      };
      this.batches.unshift(batch);
      version.status = 'published';
      flag.enabled = true;
      flag.status = 'rolling';
      this.recordAudit('开始放量', `${flag.key} 批次 ${batch.id} 按 v${version.version} 生效快照启用 ${batch.snapshot.rollout}%`, '值班人员', {
        idempotencyKey: `start:${batch.id}`,
        batchId: batch.id,
        version: version.version
      });
      return { ok: true };
    },
    emergencyStop(): Result {
      if (!this.guardFresh()) return staleResult;
      const flag = this.active;
      if (!flag) return { ok: false, reason: '未选择开关' };
      const batch = this.batches.find((item) => item.flagId === flag.id && item.state === 'rolling');
      if (!batch) return { ok: false, level: 'warning', reason: '当前没有进行中的批次，紧急停止已忽略' };
      if (batch.operations.includes('emergency-stop')) {
        return { ok: false, level: 'warning', reason: `批次 ${batch.id} 已执行过紧急停止，重复操作已忽略` };
      }
      batch.operations.push('emergency-stop');
      batch.state = 'stopped';
      batch.endedAt = now();
      flag.enabled = false;
      flag.status = 'stopped';
      this.recordAudit('紧急停止', `${flag.key} 批次 ${batch.id}（v${batch.version}）已立即关闭，仅处理当前批次`, '值班人员', {
        idempotencyKey: `emergency-stop:${batch.id}`,
        batchId: batch.id,
        version: batch.version
      });
      return { ok: true };
    },
    rollback(): Result {
      if (!this.guardFresh()) return staleResult;
      const flag = this.active;
      if (!flag) return { ok: false, reason: '未选择开关' };
      const batch = this.batches.find((item) => item.flagId === flag.id && (item.state === 'rolling' || item.state === 'stopped'));
      if (!batch) return { ok: false, level: 'warning', reason: '当前批次不可回滚（不存在或已回滚），操作已忽略' };
      if (batch.operations.includes('rollback')) {
        return { ok: false, level: 'warning', reason: `批次 ${batch.id} 已执行过回滚，重复操作已忽略` };
      }
      batch.operations.push('rollback');
      batch.state = 'rolled-back';
      batch.endedAt = now();
      flag.enabled = false;
      flag.status = 'rolled-back';
      this.recordAudit('执行回滚', `${flag.key} 批次 ${batch.id}（v${batch.version}）回滚至关闭状态，仅处理当前批次`, '值班人员', {
        idempotencyKey: `rollback:${batch.id}`,
        batchId: batch.id,
        version: batch.version
      });
      return { ok: true };
    },
    retryFailedWrites(): Result {
      if (!this.failedWrites.length) return { ok: false, level: 'warning', reason: '没有待重试的写入' };
      const remaining: FailedWrite[] = [];
      let applied = 0;
      for (const item of this.failedWrites) {
        let storedRevision = 0;
        let storedWriteSeq = 0;
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const stored = JSON.parse(raw) as PersistedState;
            storedRevision = stored.revision ?? 0;
            storedWriteSeq = stored.writeSeq ?? 0;
          }
        } catch { /* 按 0 处理 */ }
        const snapshot = JSON.parse(item.snapshot) as PersistedState;
        const snapshotRevision = snapshot.revision ?? 0;
        const snapshotWriteSeq = snapshot.writeSeq ?? 0;
        // 已存储的数据更新（revision 更大，或同 revision 下 writeSeq 不落后）时丢弃旧快照，避免覆盖他人的新数据
        if (storedRevision > snapshotRevision || (storedRevision === snapshotRevision && storedWriteSeq >= snapshotWriteSeq)) { applied += 1; continue; }
        try {
          if (this.storageFailure) throw new Error('模拟的存储故障（localStorage 写入被拒绝）');
          localStorage.setItem(STORAGE_KEY, item.snapshot);
          applied += 1;
        } catch { remaining.push({ ...item, retries: item.retries + 1 }); }
      }
      this.failedWrites = remaining;
      this.persistFailedQueue();
      if (remaining.length) return { ok: false, reason: `仍有 ${remaining.length} 条写入失败，已保留重试项和原状态` };
      this.syncLatest();
      this.recordAudit('写入恢复', `重试成功，${applied} 条失败变更已处理`);
      return { ok: true };
    },
    setStorageFailure(on: boolean) { this.storageFailure = on; },
    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || !plan.versions.length) return { hit: false, reason: '未选择开关', source: 'none' as const };
      const live = this.batches.find((item) => item.flagId === flag.id && item.state === 'rolling');
      // 灰度开始后：命中模拟读取生效快照，而不是正在编辑的草稿
      if (live) {
        const result = evaluate(live.snapshot.rules, live.snapshot.rollout, user);
        return { ...result, source: 'snapshot' as const, reason: `${result.reason}（读取生效快照：批次 ${live.id} · v${live.version}）` };
      }
      const version = plan.versions[plan.versions.length - 1];
      const result = evaluate(version.rules, version.rollout, user);
      const statusText: Record<VersionStatus, string> = { pending: '待审版本', approved: '已审批待发布', published: '已发布', superseded: '已替换' };
      return { ...result, source: 'draft' as const, reason: `${result.reason}（草稿模拟：v${version.version} ${statusText[version.status]}，当前无生效批次）` };
    }
  }
});
