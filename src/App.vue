<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { message } from 'ant-design-vue';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore, type ActionResult, type RetryKind } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const batch = computed(() => store.currentBatch);
const pendingVersion = computed(() => store.pendingVersion);
const approvedVersion = computed(() => store.approvedVersion);
const retryItems = computed(() => store.retryItems);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });

const schema = toTypedSchema(
  z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }),
);
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');

const kindLabel: Record<RetryKind, string> = {
  'start-rollout': '开始灰度',
  'emergency-stop': '紧急停止',
  rollback: '回滚',
  approve: '审批',
  'rule-change': '修改规则',
  'rollout-change': '调整放量',
  schedule: '设置定时',
};

const currentApprovals = computed(() =>
  (plan.value?.approvals ?? []).filter((a) => a.version === pendingVersion.value),
);
const staleApproval = computed(
  () => approvedVersion.value !== null && pendingVersion.value !== null && approvedVersion.value < pendingVersion.value,
);

async function run(fn: () => Promise<ActionResult>, okMsg: string) {
  try {
    const r = await fn();
    if (r.ok) message.success(okMsg);
    else if (r.retried) message.warning(`写入失败：${r.error}。已保留原状态并加入重试队列`);
    else message.error(r.error ?? '操作失败');
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({
    id,
    name: values.name,
    key: values.key,
    enabled: false,
    rollout: 0,
    rules: { region: '全部', appVersion: '>= 1.0', authenticated: false },
    status: 'draft',
  });
  store.plans.push({
    id: `p-${Date.now()}`,
    flagId: id,
    scheduledAt: '2026-10-02T10:00',
    approvals: [],
    effective: null,
    lastBatchId: null,
    retryQueue: [],
    version: 1,
  });
  store.select(id);
  store.audit('创建开关', `${values.key} 草稿版本 1`);
  createOpen.value = false;
  resetForm();
});

function simulate() {
  if (active.value) simulation.value = store.simulateHit(user);
}

function statusColor(status?: string) {
  return status === 'rolling'
    ? 'green'
    : status === 'approved'
      ? 'blue'
      : status === 'stopped' || status === 'rolled-back'
        ? 'red'
        : 'gold';
}
function batchColor(status?: string) {
  return status === 'running' ? 'green' : status === 'stopped' ? 'red' : 'default';
}
function fmt(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-C')}`;
}

// 跨标签页同步：另一标签页写入后，本页重新水合（重开/同步后仍由版本守卫拒绝旧审批）
function onStorage(e: StorageEvent) {
  if (e.key === 'yf58-flag-state') store.rehydrate();
}
onMounted(() => window.addEventListener('storage', onStorage));
onUnmounted(() => window.removeEventListener('storage', onStorage));
</script>

<template>
  <a-config-provider>
    <a-layout class="app-shell">
      <a-layout-header class="topbar">
        <div>
          <div class="eyebrow">FEATURE FLAG / PORT 62023</div>
          <h1>{{ $t('title') }}</h1>
        </div>
        <a-space wrap>
          <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
          <a-tooltip title="开启后，下一次业务写入会模拟后端未确认：原状态保留，操作进入重试队列">
            <a-switch
              :checked="store.injectWriteFailure"
              checked-children="模拟写入失败：开"
              un-checked-children="模拟写入失败：关"
              @change="(v: boolean) => (store.injectWriteFailure = v)"
            />
          </a-tooltip>
          <a-button @click="store.externalEdit">模拟另一标签页改规则</a-button>
          <a-button @click="store.rehydrate">模拟重开（重新水合）</a-button>
          <a-button type="primary" @click="createOpen = true">新建功能开关</a-button>
        </a-space>
      </a-layout-header>

      <a-layout-content class="content">
        <a-alert
          v-if="!online"
          type="warning"
          show-icon
          message="离线状态"
          description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。"
          class="mb"
        />

        <a-row :gutter="[18, 18]">
          <a-col :xs="24" :lg="7">
            <a-card title="功能开关" size="small">
              <a-list :data-source="store.flags" bordered>
                <template #renderItem="{ item }">
                  <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                    <a-list-item-meta>
                      <template #title>
                        <a-space>
                          <span>{{ item.name }}</span>
                          <a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag>
                        </a-space>
                      </template>
                      <template #description>
                        <code>{{ item.key }}</code> · 草稿 {{ item.rollout }}%
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                </template>
              </a-list>
            </a-card>

            <a-card title="规则命中模拟" size="small" class="mt">
              <a-alert
                v-if="active?.status === 'rolling'"
                type="info"
                show-icon
                message="灰度进行中：命中模拟读取生效快照，不受待审草稿影响"
                class="mb"
              />
              <a-form layout="vertical">
                <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
                <a-row :gutter="8">
                  <a-col :span="12">
                    <a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item>
                  </a-col>
                  <a-col :span="12">
                    <a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item>
                  </a-col>
                </a-row>
                <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
                <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
              </a-form>
              <a-alert
                v-if="simulation"
                class="mt"
                :type="simulation.hit ? 'success' : 'info'"
                show-icon
                :message="simulation.hit ? '命中新功能' : '未命中'"
                :description="simulation.reason"
              />
            </a-card>
          </a-col>

          <a-col :xs="24" :lg="17">
            <template v-if="active && plan">
              <!-- 当前批次（生效快照） -->
              <a-card class="mb" size="small">
                <template #title>当前批次（生效快照）</template>
                <template #extra>
                  <a-space>
                    <a-tag v-if="batch" :color="batchColor(batch.status)">{{ batch.status }}</a-tag>
                    <a-tag v-else color="default">无运行中批次</a-tag>
                    <a-button
                      danger
                      :disabled="!batch || batch.status !== 'running'"
                      @click="run(() => store.emergencyStop(), '紧急停止已执行（仅当前批次）')"
                    >
                      紧急停止
                    </a-button>
                    <a-button
                      danger
                      ghost
                      :disabled="!batch || batch.status === 'rolled-back'"
                      @click="run(() => store.rollback(), '回滚已执行（仅当前批次）')"
                    >
                      回滚
                    </a-button>
                  </a-space>
                </template>
                <a-descriptions v-if="batch" bordered :column="{ xs: 1, md: 3 }" size="small">
                  <a-descriptions-item label="批次 ID"><code>{{ batch.batchId }}</code></a-descriptions-item>
                  <a-descriptions-item label="来源版本">v{{ batch.version }}</a-descriptions-item>
                  <a-descriptions-item label="生效放量">{{ batch.rollout }}%</a-descriptions-item>
                  <a-descriptions-item label="目标地区">{{ batch.rules.region }}</a-descriptions-item>
                  <a-descriptions-item label="客户端版本">{{ batch.rules.appVersion }}</a-descriptions-item>
                  <a-descriptions-item label="登录要求">{{ batch.rules.authenticated ? '是' : '否' }}</a-descriptions-item>
                  <a-descriptions-item label="定时生效">{{ batch.scheduledAt }}</a-descriptions-item>
                  <a-descriptions-item label="开始时间">{{ fmt(batch.startedAt) }}</a-descriptions-item>
                  <a-descriptions-item label="当前状态">
                    <a-tag :color="batchColor(batch.status)">{{ batch.status }}</a-tag>
                  </a-descriptions-item>
                </a-descriptions>
                <a-empty v-else description="暂无运行中的批次；开始灰度后将在此固化生效快照" />
                <div class="idempotent-hint">紧急停止 / 回滚仅处理当前批次，重复点击不会重复写入审计记录。</div>
              </a-card>

              <!-- 待审版本 -->
              <a-card class="mb" size="small">
                <template #title>待审版本</template>
                <template #extra>
                  <a-space>
                    <a-tag color="purple">草稿 v{{ pendingVersion }}</a-tag>
                    <a-tag v-if="approvedVersion !== null" color="blue">已批准 v{{ approvedVersion }}</a-tag>
                    <a-tag v-else color="default">未批准</a-tag>
                  </a-space>
                </template>
                <a-alert
                  v-if="staleApproval"
                  type="error"
                  show-icon
                  class="mb"
                  message="审批已失效"
                  :description="`页面批准的是 v${approvedVersion}，当前草稿为 v${pendingVersion}。另一标签页已修改规则，旧审批绑定的版本已过期，拒绝发布。`"
                />
                <a-descriptions bordered :column="{ xs: 1, md: 3 }" size="small">
                  <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                  <a-descriptions-item label="草稿放量">{{ active.rollout }}%</a-descriptions-item>
                  <a-descriptions-item label="审批状态" :span="2">
                    <a-space wrap>
                      <a-tag v-for="a in currentApprovals" :key="a.role" color="green">
                        {{ a.role }} · v{{ a.version }}
                      </a-tag>
                      <span v-if="currentApprovals.length === 0" class="muted">待审批</span>
                    </a-space>
                  </a-descriptions-item>
                </a-descriptions>
                <a-divider class="tight" />
                <a-space wrap>
                  <a-button
                    :disabled="currentApprovals.some((a) => a.role === '产品负责人')"
                    @click="run(() => store.approve('产品负责人'), '产品负责人已批准当前版本')"
                  >
                    产品审批
                  </a-button>
                  <a-button
                    :disabled="currentApprovals.some((a) => a.role === '研发负责人')"
                    @click="run(() => store.approve('研发负责人'), '研发负责人已批准当前版本')"
                  >
                    研发审批
                  </a-button>
                  <a-button
                    type="primary"
                    :disabled="active.status !== 'approved'"
                    @click="run(() => store.startRollout(), '灰度已开始，生效快照已固化')"
                  >
                    开始灰度发布
                  </a-button>
                  <span class="muted">审批绑定版本；规则一旦修改，版本自增、旧审批失效。</span>
                </a-space>
              </a-card>

              <!-- 规则与放量 -->
              <a-card class="mb" size="small" title="规则组合与放量（修改即生成待审版本）">
                <a-form layout="vertical">
                  <a-row :gutter="16">
                    <a-col :span="8">
                      <a-form-item label="目标地区">
                        <a-select
                          :value="active.rules.region"
                          :options="['全部', '上海', '北京', '广东'].map((v) => ({ value: v, label: v }))"
                          @change="(v: string) => run(() => store.updateRule({ region: v }), '规则已修改，生成待审版本')"
                        />
                      </a-form-item>
                    </a-col>
                    <a-col :span="8">
                      <a-form-item label="客户端版本">
                        <a-input
                          :value="active.rules.appVersion"
                          @change="(e: Event) => run(() => store.updateRule({ appVersion: (e.target as HTMLInputElement).value }), '规则已修改，生成待审版本')"
                        />
                      </a-form-item>
                    </a-col>
                    <a-col :span="8">
                      <a-form-item label="登录要求">
                        <a-switch
                          :checked="active.rules.authenticated"
                          @change="(v: boolean) => run(() => store.updateRule({ authenticated: v }), '规则已修改，生成待审版本')"
                        />
                      </a-form-item>
                    </a-col>
                  </a-row>
                </a-form>
                <a-divider class="tight" />
                <div class="rollout-label">逐步放量（草稿）：{{ active.rollout }}%</div>
                <a-slider
                  :value="active.rollout"
                  :min="0"
                  :max="100"
                  :step="5"
                  @change="(v: number) => run(() => store.setRollout(v), '放量已调整，生成待审版本')"
                />
                <a-divider class="tight" />
                <a-space wrap>
                  <span class="muted">定时生效（草稿）：</span>
                  <a-input
                    type="datetime-local"
                    :value="plan.scheduledAt"
                    @change="(e: Event) => run(() => store.schedule((e.target as HTMLInputElement).value), '定时已设置，生成待审版本')"
                  />
                </a-space>
              </a-card>

              <!-- 失败项（重试队列） -->
              <a-card class="mb" size="small">
                <template #title>失败项（写入重试队列）</template>
                <template #extra>
                  <a-tag :color="retryItems.length ? 'red' : 'default'">{{ retryItems.length }} 项待重试</a-tag>
                </template>
                <a-alert
                  v-if="retryItems.length === 0"
                  type="success"
                  show-icon
                  message="无失败项"
                  description="所有业务写入均已确认。开启右上角「模拟写入失败」后执行停止/回滚，可观察失败项如何保留原状态并入队。"
                />
                <a-list
                  v-else
                  :data-source="retryItems"
                  bordered
                  size="small"
                >
                  <template #renderItem="{ item }">
                    <a-list-item
                      :actions="[
                        h('a', { onClick: () => run(() => store.retry(item), '重试成功，失败项已补执行') }, '重试'),
                        h('a', { onClick: () => store.dismissRetry(item) }, '丢弃'),
                      ]"
                    >
                      <a-list-item-meta>
                        <template #title>
                          <a-space>
                            <a-tag color="red">{{ kindLabel[item.kind as RetryKind] }}</a-tag>
                            <code v-if="item.batchId">{{ item.batchId }}</code>
                            <a-tag color="orange">第 {{ item.attempts }} 次</a-tag>
                          </a-space>
                        </template>
                        <template #description>
                          <div>{{ item.lastError }}</div>
                          <div class="muted">{{ fmt(item.updatedAt) }}</div>
                        </template>
                      </a-list-item-meta>
                    </a-list-item>
                  </template>
                </a-list>
              </a-card>

              <!-- 审计记录 -->
              <a-card title="审计记录（读取生效快照）" size="small">
                <a-timeline>
                  <a-timeline-item
                    v-for="item in store.auditLogs"
                    :key="item.id"
                    :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('失败') ? 'red' : 'blue'"
                  >
                    <b>{{ item.at }} · {{ item.actor }}</b>
                    <p>{{ item.action }}：{{ item.detail }}</p>
                  </a-timeline-item>
                </a-timeline>
              </a-card>
            </template>
          </a-col>
        </a-row>
      </a-layout-content>

      <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create">
        <a-form layout="vertical">
          <a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name">
            <a-input v-model:value="name" />
          </a-form-item>
          <a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key">
            <a-input v-model:value="key" />
          </a-form-item>
        </a-form>
      </a-modal>
    </a-layout>
  </a-config-provider>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #f4f6fb;
  font-family: Inter, 'PingFang SC', sans-serif;
}
.app-shell {
  min-height: 100vh;
  background: transparent;
}
.topbar {
  height: auto;
  min-height: 88px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 32px;
  color: white;
  background: linear-gradient(120deg, #111827, #312e81);
}
.topbar h1 {
  color: white;
  margin: 3px 0;
  font-size: 25px;
}
.eyebrow {
  color: #a5b4fc;
  font-size: 11px;
  letter-spacing: 0.13em;
}
.content {
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
  padding: 24px;
}
.mb {
  margin-bottom: 18px;
}
.mt {
  margin-top: 14px;
}
.selected {
  background: #eef2ff;
  cursor: pointer;
}
.rollout-label {
  color: #4338ca;
  font-weight: 700;
}
.ant-list-item {
  cursor: pointer;
}
.muted {
  color: #94a3b8;
}
.tight {
  margin: 12px 0;
}
.idempotent-hint {
  margin-top: 10px;
  color: #64748b;
  font-size: 12px;
}
@media (max-width: 720px) {
  .topbar {
    padding: 18px;
    flex-direction: column;
    align-items: flex-start;
  }
  .content {
    padding: 16px;
  }
}
</style>
