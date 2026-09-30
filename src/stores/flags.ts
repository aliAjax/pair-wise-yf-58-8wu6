import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export type BatchStatus = 'running' | 'stopped' | 'rolled-back';
export type RetryKind =
  | 'start-rollout'
  | 'emergency-stop'
  | 'rollback'
  | 'approve'
  | 'rule-change'
  | 'rollout-change'
  | 'schedule';
export type RetryStatus = 'failed' | 'succeeded';

export interface RuleSet {
  region: string;
  appVersion: string;
  authenticated: boolean;
}

export interface FeatureFlag {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  /** 草稿（待审）放量；灰度运行时以生效快照为准 */
  rollout: number;
  /** 草稿（待审）规则；可随时编辑，不影响运行中的批次 */
  rules: RuleSet;
  status: FlagStatus;
}

/** 审批记录：绑定到具体的发布计划版本 */
export interface Approval {
  role: string;
  at: string;
  version: number;
}

/** 生效快照：灰度开始时固化的不可变批次 */
export interface EffectiveSnapshot {
  batchId: string;
  version: number;
  rules: RuleSet;
  rollout: number;
  scheduledAt: string;
  startedAt: string;
  status: BatchStatus;
}

/** 重试项：写入失败后保留的重试意图（发件箱模式） */
export interface RetryItem {
  id: string;
  batchId: string | null;
  kind: RetryKind;
  payload: Record<string, unknown>;
  status: RetryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RolloutPlan {
  id: string;
  flagId: string;
  /** 当前草稿（待审）版本号 */
  version: number;
  scheduledAt: string;
  /** 审批记录，每条绑定一个版本 */
  approvals: Approval[];
  /** 当前运行中的批次快照；无则 null */
  effective: EffectiveSnapshot | null;
  lastBatchId: string | null;
  /** 写入失败的重试队列 */
  retryQueue: RetryItem[];
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface ActionResult {
  ok: boolean;
  retried?: boolean;
  error?: string;
}

interface State {
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  auditLogs: AuditRecord[];
  activeId: string;
  /** 一次性开关：下次业务写入模拟后端未确认 */
  injectWriteFailure: boolean;
  /** 调试用写入日志（不持久化） */
  writeLog: string[];
}

const STORAGE_KEY = 'yf58-flag-state';

const seed: State = {
  activeId: 'f1',
  flags: [
    {
      id: 'f1',
      name: '新版结算页',
      key: 'checkout-v2',
      enabled: false,
      rollout: 10,
      rules: { region: '上海', appVersion: '>= 8.2', authenticated: true },
      status: 'draft',
    },
    {
      id: 'f2',
      name: '推荐模型 B',
      key: 'recommend-model-b',
      enabled: true,
      rollout: 35,
      rules: { region: '全部', appVersion: '>= 8.0', authenticated: false },
      status: 'rolling',
    },
  ],
  plans: [
    {
      id: 'p1',
      flagId: 'f1',
      version: 3,
      scheduledAt: '2026-10-01T10:00',
      approvals: [],
      effective: null,
      lastBatchId: null,
      retryQueue: [],
    },
    {
      id: 'p2',
      flagId: 'f2',
      version: 1,
      scheduledAt: '2026-10-01T09:00',
      approvals: [
        { role: '产品负责人', at: '2026-09-30T09:00:00.000Z', version: 1 },
        { role: '研发负责人', at: '2026-09-30T09:01:00.000Z', version: 1 },
      ],
      effective: {
        batchId: 'b-seed-0001',
        version: 1,
        rules: { region: '全部', appVersion: '>= 8.0', authenticated: false },
        rollout: 35,
        scheduledAt: '2026-10-01T09:00',
        startedAt: '2026-09-30T09:05:00.000Z',
        status: 'running',
      },
      lastBatchId: 'b-seed-0001',
      retryQueue: [],
    },
  ],
  auditLogs: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' },
    { id: 'a3', at: '09:05', actor: '系统', action: '开始灰度', detail: '批次 b-seed-0001（v1）启用 35%，规则已固化为生效快照' },
  ],
  injectWriteFailure: false,
  writeLog: [],
};

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved) as Partial<State>;
    return {
      ...structuredClone(seed),
      ...parsed,
      // 一次性开关与调试日志不持久化，重开后复位
      injectWriteFailure: false,
      writeLog: [],
    };
  }
  return structuredClone(seed);
}

function hashUser(id: string): number {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
}

function now(): string {
  return new Date().toISOString();
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),

  getters: {
    active(state): FeatureFlag | undefined {
      return state.flags.find((item) => item.id === state.activeId);
    },
    activePlan(state): RolloutPlan | undefined {
      return state.plans.find((item) => item.flagId === state.activeId);
    },
    /** 当前运行中的批次（生效快照） */
    currentBatch(state): EffectiveSnapshot | null {
      return state.plans.find((item) => item.flagId === state.activeId)?.effective ?? null;
    },
    /** 待审版本号 */
    pendingVersion(state): number | null {
      return state.plans.find((item) => item.flagId === state.activeId)?.version ?? null;
    },
    /** 已完成双审批的版本号（取最高），无则 null */
    approvedVersion(state): number | null {
      const plan = state.plans.find((item) => item.flagId === state.activeId);
      if (!plan) return null;
      const byVersion = new Map<number, Set<string>>();
      for (const a of plan.approvals) {
        if (!byVersion.has(a.version)) byVersion.set(a.version, new Set());
        byVersion.get(a.version)!.add(a.role);
      }
      let best: number | null = null;
      for (const [v, roles] of byVersion) {
        if (roles.has('产品负责人') && roles.has('研发负责人')) {
          if (best === null || v > best) best = v;
        }
      }
      return best;
    },
    /** 失败重试项 */
    retryItems(state): RetryItem[] {
      return state.plans.find((item) => item.flagId === state.activeId)?.retryQueue ?? [];
    },
  },

  actions: {
    persist() {
      const { flags, plans, auditLogs, activeId } = this.$state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ flags, plans, auditLogs, activeId }));
    },

    /** 模拟重开：从 localStorage 重新水合 */
    rehydrate() {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<State>;
        this.$state = { ...structuredClone(seed), ...parsed, injectWriteFailure: false, writeLog: [] };
      }
    },

    pushAudit(action: string, detail: string, actor = '当前操作人') {
      this.auditLogs.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString('zh-CN'), actor, action, detail });
    },

    audit(action: string, detail: string, actor = '当前操作人') {
      this.pushAudit(action, detail, actor);
      this.persist();
    },

    select(id: string) {
      this.activeId = id;
      this.persist();
    },

    /** 模拟后端写入；injectWriteFailure 为 true 时抛错（一次性） */
    async write(kind: RetryKind, payload: Record<string, unknown>) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (this.injectWriteFailure) {
        this.injectWriteFailure = false;
        throw new Error('模拟写入失败：后端未确认（原状态已保留）');
      }
      this.writeLog = [...this.writeLog.slice(-19), `${new Date().toLocaleTimeString('zh-CN')} ${kind} 已确认`];
    },

    /**
     * 统一执行器：校验 → 快照 → 变更 → 写入 → 审计。
     * - 校验错误（审批失效等）直接抛出，不入重试队列。
     * - 写入失败：回滚到变更前状态，重试项入队，保留原状态。
     */
    async _execute(
      kind: RetryKind,
      payload: Record<string, unknown>,
      opts: {
        batchId?: string | null;
        validate?: () => void;
        mutate: () => void;
        audit: () => void;
        bump?: boolean;
      },
    ): Promise<ActionResult> {
      opts.validate?.();
      // 仅快照业务状态（避开 reactive Proxy，保证可克隆）
      const before = {
        flags: JSON.parse(JSON.stringify(this.flags)),
        plans: JSON.parse(JSON.stringify(this.plans)),
        auditLogs: JSON.parse(JSON.stringify(this.auditLogs)),
        activeId: this.activeId,
      };
      try {
        opts.mutate();
        if (opts.bump) this.bumpVersion();
        await this.write(kind, payload);
        opts.audit();
        this.persist();
        return { ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // 保留原状态：整体回滚业务状态（$patch 保持响应式）
        this.$patch(before);
        this.injectWriteFailure = false;
        // 重试项入队（发件箱）
        this.enqueueRetry(kind, payload, opts.batchId ?? null, error);
        this.pushAudit('写入失败', `${kind} 写入未确认：${error}；已保留原状态并入重试队列`);
        this.persist();
        return { ok: false, retried: true, error };
      }
    },

    /** 任何修改都生成新的发布计划版本，并清空旧版本审批 */
    bumpVersion() {
      const plan = this.activePlan;
      if (!plan) return;
      plan.version += 1;
      plan.approvals = [];
      if (this.active?.status === 'approved') this.active.status = 'draft';
    },

    isVersionApproved(version: number): boolean {
      const plan = this.activePlan;
      if (!plan) return false;
      const roles = new Set(plan.approvals.filter((a) => a.version === version).map((a) => a.role));
      return roles.has('产品负责人') && roles.has('研发负责人');
    },

    /** 另一标签页修改规则（演示并发修改）：版本自增；本页保留绑定到旧版本的审批与状态（已失效） */
    externalEdit() {
      const plan = this.activePlan;
      if (!plan) return;
      const prev = plan.version;
      plan.version += 1;
      // 不清空审批、不改状态：模拟旧页面仍保留绑定到旧版本的审批与状态
      this.pushAudit(
        '外部修改',
        `另一标签页修改了规则，计划版本 v${prev} → v${plan.version}；本页保留的 v${prev} 审批已失效`,
      );
      this.persist();
    },

    updateRule(rule: Partial<RuleSet>): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      const payload = { rule };
      return this._execute('rule-change', payload, {
        batchId: this.activePlan.effective?.batchId ?? null,
        mutate: () => {
          this.active!.rules = { ...this.active!.rules, ...rule };
        },
        bump: true,
        audit: () =>
          this.audit('修改规则', `生成待审版本 v${this.activePlan!.version}：${JSON.stringify(this.active!.rules)}`),
      });
    },

    setRollout(value: number): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      return this._execute('rollout-change', { value }, {
        batchId: this.activePlan.effective?.batchId ?? null,
        mutate: () => {
          this.active!.rollout = value;
        },
        bump: true,
        audit: () => this.audit('调整放量', `待审版本 v${this.activePlan!.version} 放量 → ${value}%`),
      });
    },

    schedule(value: string): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      return this._execute('schedule', { value }, {
        batchId: this.activePlan.effective?.batchId ?? null,
        mutate: () => {
          this.activePlan!.scheduledAt = value;
        },
        bump: true,
        audit: () => this.audit('设置定时', `待审版本 v${this.activePlan!.version} 定时 → ${value}`),
      });
    },

    approve(role: string): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      const plan = this.activePlan;
      const exists = plan.approvals.some((a) => a.role === role && a.version === plan.version);
      if (exists) return Promise.resolve({ ok: true });
      return this._execute('approve', { role }, {
        batchId: plan.effective?.batchId ?? null,
        mutate: () => {
          plan.approvals = [...plan.approvals, { role, at: now(), version: plan.version }];
          this.active!.status = this.isVersionApproved(plan.version) ? 'approved' : 'draft';
        },
        audit: () => this.audit('审批发布', `${role} 已批准 v${plan.version}`, role),
      });
    },

    startRollout(): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      const plan = this.activePlan;
      const batchId = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const snapshot: EffectiveSnapshot = {
        batchId,
        version: plan.version,
        rules: { ...this.active.rules },
        rollout: this.active.rollout,
        scheduledAt: plan.scheduledAt,
        startedAt: now(),
        status: 'running',
      };
      return this._execute('start-rollout', { batchId }, {
        batchId,
        validate: () => {
          if (!this.isVersionApproved(plan.version)) {
            const staleVersions = [...new Set(plan.approvals.map((a) => a.version))].filter((v) => v < plan.version);
            if (staleVersions.length > 0) {
              throw new Error(
                `审批已失效：页面批准的是 v${Math.max(...staleVersions)}，当前草稿为 v${plan.version}，请重新审批后再发布`,
              );
            }
            throw new Error('当前草稿版本尚未完成产品/研发审批，拒绝发布');
          }
        },
        mutate: () => {
          plan.effective = snapshot;
          plan.lastBatchId = batchId;
          this.active!.enabled = true;
          this.active!.status = 'rolling';
        },
        audit: () =>
          this.audit(
            '开始灰度',
            `批次 ${batchId}（v${plan.version}）启用 ${this.active!.rollout}%，规则已固化为生效快照`,
          ),
      });
    },

    emergencyStop(): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      const plan = this.activePlan;
      const batch = plan.effective;
      if (!batch) return Promise.resolve({ ok: false, error: '无运行中的批次' });
      // 幂等：已停止则不再重复记录
      if (batch.status === 'stopped') return Promise.resolve({ ok: true });
      if (batch.status === 'rolled-back') return Promise.resolve({ ok: false, error: '批次已回滚，无法停止' });
      return this._execute('emergency-stop', { batchId: batch.batchId }, {
        batchId: batch.batchId,
        mutate: () => {
          plan.effective!.status = 'stopped';
          this.active!.enabled = false;
          this.active!.status = 'stopped';
        },
        audit: () => this.audit('紧急停止', `批次 ${batch.batchId} 已立即关闭（仅处理当前批次）`),
      });
    },

    rollback(): Promise<ActionResult> {
      if (!this.active || !this.activePlan) return Promise.resolve({ ok: false, error: '无活动开关' });
      const plan = this.activePlan;
      const batch = plan.effective;
      if (!batch) return Promise.resolve({ ok: false, error: '无运行中的批次' });
      // 幂等：已回滚则不再重复记录
      if (batch.status === 'rolled-back') return Promise.resolve({ ok: true });
      return this._execute('rollback', { batchId: batch.batchId }, {
        batchId: batch.batchId,
        mutate: () => {
          plan.effective!.status = 'rolled-back';
          this.active!.enabled = false;
          this.active!.status = 'rolled-back';
        },
        audit: () => this.audit('执行回滚', `批次 ${batch.batchId} 已回滚至关闭（仅处理当前批次）`),
      });
    },

    enqueueRetry(kind: RetryKind, payload: Record<string, unknown>, batchId: string | null, error: string) {
      const plan = this.activePlan;
      if (!plan) return;
      const ts = now();
      const existing = plan.retryQueue.find(
        (r) => r.kind === kind && r.batchId === batchId && r.status === 'failed',
      );
      if (existing) {
        existing.attempts += 1;
        existing.lastError = error;
        existing.updatedAt = ts;
        return;
      }
      plan.retryQueue.push({
        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        batchId,
        kind,
        payload,
        status: 'failed',
        attempts: 1,
        lastError: error,
        createdAt: ts,
        updatedAt: ts,
      });
    },

    async dispatch(item: RetryItem): Promise<ActionResult> {
      switch (item.kind) {
        case 'start-rollout':
          return await this.startRollout();
        case 'emergency-stop':
          return await this.emergencyStop();
        case 'rollback':
          return await this.rollback();
        case 'approve':
          return await this.approve(String(item.payload.role));
        case 'rule-change':
          return await this.updateRule(item.payload.rule as Partial<RuleSet>);
        case 'rollout-change':
          return await this.setRollout(Number(item.payload.value));
        case 'schedule':
          return await this.schedule(String(item.payload.value));
      }
    },

    async retry(item: RetryItem): Promise<ActionResult> {
      if (!this.activePlan) return { ok: false, error: '无发布计划' };
      let result: ActionResult;
      try {
        result = await this.dispatch(item);
      } catch (e) {
        // 校验类错误（如批次已失效）：累计 attempts，保留失败项
        const error = e instanceof Error ? e.message : String(e);
        item.attempts += 1;
        item.lastError = error;
        item.updatedAt = now();
        this.persist();
        return { ok: false, retried: true, error };
      }
      if (!result.ok) return result; // _execute 已重新入队并累计 attempts，保留失败项
      this.activePlan.retryQueue = this.activePlan.retryQueue.filter((r) => r.id !== item.id);
      this.audit('重试成功', `${item.kind} 已补执行（批次 ${item.batchId ?? '—'}）`);
      return { ok: true };
    },

    dismissRetry(item: RetryItem) {
      if (!this.activePlan) return;
      this.activePlan.retryQueue = this.activePlan.retryQueue.filter((r) => r.id !== item.id);
      this.persist();
    },

    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active || !this.activePlan) return { hit: false, reason: '无活动开关' };
      const plan = this.activePlan;
      const batch = plan.effective;
      const running = this.active.status === 'rolling' && batch && batch.status === 'running';

      if (running) {
        // 灰度开始后：命中模拟读取生效快照
        const rule = batch!.rules;
        const rollout = batch!.rollout;
        if (rule.region !== '全部' && rule.region !== user.region) {
          return { hit: false, reason: `未命中生效快照：地区不匹配（快照要求 ${rule.region}）` };
        }
        if (rule.authenticated && !user.authenticated) {
          return { hit: false, reason: '未命中生效快照：要求已登录用户' };
        }
        const hash = hashUser(user.id);
        const hit = hash < rollout;
        return {
          hit,
          reason: `生效快照批次 ${batch!.batchId}（v${batch!.version}）：灰度桶 ${hash} ${hit ? '<' : '≥'} ${rollout}%`,
        };
      }

      // 未在灰度运行：读取草稿
      if (!this.active.enabled) return { hit: false, reason: '开关未启用（无运行中的批次）' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) {
        return { hit: false, reason: `地区不匹配（要求 ${rule.region}）` };
      }
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = hashUser(user.id);
      const hit = hash < this.active.rollout;
      return { hit, reason: `灰度桶 ${hash} ${hit ? '<' : '≥'} ${this.active.rollout}%` };
    },
  },
});
