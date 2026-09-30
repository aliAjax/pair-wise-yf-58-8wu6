<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { message } from 'ant-design-vue';
import { REQUIRED_ROLES, STORAGE_KEY, useFlagStore, type Approval, type BatchState, type Result, type VersionStatus } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const version = computed(() => store.activeVersion);
const liveBatch = computed(() => store.activeBatch);
const approvedRoles = computed(() => version.value?.approvals.map((item) => item.role) ?? []);
const pendingVersion = computed(() => (version.value && (version.value.status === 'pending' || version.value.status === 'approved') ? version.value : undefined));
const versionsReversed = computed(() => (plan.value ? [...plan.value.versions].slice(-5).reverse() : []));
const simulation = ref<{ hit: boolean; reason: string; source: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const createOpen = ref(false);

const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => { store.createFlag(values.name, values.key); createOpen.value = false; resetForm(); });

function run(action: () => Result, okText: string) {
  const result = action();
  if (result.ok) message.success(okText);
  else if (result.level === 'warning') message.warning(result.reason ?? '操作已忽略');
  else message.error(result.reason ?? '操作被拒绝');
}
function simulate() { simulation.value = store.simulateHit(user); }
function syncLatest() { store.syncLatest(); message.success('已同步最新状态'); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }
function versionColor(status: VersionStatus) { return status === 'published' ? 'green' : status === 'approved' ? 'blue' : status === 'superseded' ? 'default' : 'gold'; }
function versionText(status: VersionStatus) { return status === 'published' ? '已发布' : status === 'approved' ? '已审批' : status === 'superseded' ? '已替换' : '待审批'; }
function batchColor(state: BatchState) { return state === 'rolling' ? 'green' : state === 'stopped' || state === 'rolled-back' ? 'red' : 'default'; }
function batchText(state: BatchState) { return state === 'rolling' ? '生效中' : state === 'stopped' ? '已停止' : state === 'rolled-back' ? '已回滚' : '已替换'; }

function onStorage(event: StorageEvent) { if (event.key === STORAGE_KEY) store.stale = true; }
onMounted(() => window.addEventListener('storage', onStorage));
onUnmounted(() => window.removeEventListener('storage', onStorage));
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar">
      <div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div>
      <a-space wrap>
        <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
        <a-tag v-if="store.stale" color="red">页面已过期</a-tag>
        <a-tag>rev {{ store.revision }}</a-tag>
        <span class="switch-label">模拟存储故障</span>
        <a-switch size="small" :checked="store.storageFailure" @change="(checked: boolean) => store.setStorageFailure(checked)" />
        <a-button type="primary" @click="createOpen = true">新建功能开关</a-button>
      </a-space>
    </a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-alert v-if="store.stale" type="error" show-icon class="mb" message="页面数据已过期，提交已被锁定" description="另一页面已提交新修改，继续按旧数据发布会绕过版本绑定的审批。请同步最新状态后再操作。">
        <template #action><a-button size="small" type="primary" @click="syncLatest">同步最新状态</a-button></template>
      </a-alert>
      <a-alert v-if="store.failedWrites.length" type="warning" show-icon class="mb" :message="`${store.failedWrites.length} 条写入失败，已保留重试项和原状态`" description="存储恢复后点击重试即可补写，期间的新修改会继续追加到重试队列。">
        <template #action><a-button size="small" type="primary" @click="run(() => store.retryFailedWrites(), '重试成功，失败项已清空')">重试写入</a-button></template>
      </a-alert>
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small">
            <a-list :data-source="store.flags" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                  <a-list-item-meta>
                    <template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template>
                    <template #description><code>{{ item.key }}</code> · v{{ store.versionOf(item.id)?.version }} · {{ store.versionOf(item.id)?.rollout }}%</template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>
          <a-card title="规则命中模拟" size="small" class="mt">
            <a-form layout="vertical">
              <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
              <a-row :gutter="8">
                <a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col>
              </a-row>
              <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
              <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
            </a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason">
              <template #icon><a-tag :color="simulation.source === 'snapshot' ? 'green' : 'gold'">{{ simulation.source === 'snapshot' ? '生效快照' : '草稿版本' }}</a-tag></template>
            </a-alert>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && version">
            <a-card size="small" class="mb" title="运行状态">
              <a-descriptions bordered size="small" :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="当前批次">
                  <a-space v-if="liveBatch" :size="4" wrap><code>{{ liveBatch.id }}</code><a-tag color="green">生效中</a-tag><span>v{{ liveBatch.version }} · {{ liveBatch.snapshot.rollout }}%</span></a-space>
                  <span v-else class="dim">无进行中的批次</span>
                </a-descriptions-item>
                <a-descriptions-item label="待审版本">
                  <a-space v-if="pendingVersion" :size="4" wrap><a-tag :color="versionColor(pendingVersion.status)">{{ versionText(pendingVersion.status) }}</a-tag><span>v{{ pendingVersion.version }} · {{ pendingVersion.source }} · 审批 {{ pendingVersion.approvals.length }}/{{ REQUIRED_ROLES.length }}</span></a-space>
                  <span v-else class="dim">无</span>
                </a-descriptions-item>
                <a-descriptions-item label="失败项">
                  <a-tag v-if="store.failedWrites.length" color="orange">{{ store.failedWrites.length }} 条待重试</a-tag>
                  <span v-else class="dim">无</span>
                </a-descriptions-item>
              </a-descriptions>
            </a-card>
            <a-card :title="`${active.name} · v${version.version}`" class="mb">
              <template #extra>
                <a-space>
                  <a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag>
                  <a-button danger @click="run(() => store.emergencyStop(), '已紧急停止当前批次')">紧急停止</a-button>
                  <a-button danger ghost @click="run(() => store.rollback(), '已回滚当前批次')">回滚</a-button>
                </a-space>
              </template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="当前版本"><a-tag :color="versionColor(version.status)">{{ versionText(version.status) }}</a-tag> v{{ version.version }}</a-descriptions-item>
                <a-descriptions-item :label="`审批（绑定 v${version.version}）`">{{ version.approvals.map((item) => `${item.role} ${item.at}`).join('、') || '待审批' }}</a-descriptions-item>
              </a-descriptions>
              <a-alert v-if="liveBatch" class="mt" type="success" show-icon :message="`生效快照：批次 ${liveBatch.id} · v${liveBatch.version} · ${liveBatch.snapshot.rollout}%`" :description="`快照规则：${liveBatch.snapshot.rules.region} / ${liveBatch.snapshot.rules.appVersion} / ${liveBatch.snapshot.rules.authenticated ? '需登录' : '免登录'}。灰度期间修改规则只生成待审版本，不影响该快照。`" />
              <a-divider>规则组合</a-divider>
              <a-form layout="vertical">
                <a-row :gutter="16">
                  <a-col :span="8"><a-form-item label="目标地区"><a-select :value="version.rules.region" :options="['全部','上海','北京','广东'].map((value) => ({ value, label: value }))" @change="(value: string) => run(() => store.updateRule({ region: value }), '已生成新的待审版本')" /></a-form-item></a-col>
                  <a-col :span="8"><a-form-item label="客户端版本"><a-input :value="version.rules.appVersion" @change="(event: Event) => run(() => store.updateRule({ appVersion: (event.target as HTMLInputElement).value }), '已生成新的待审版本')" /></a-form-item></a-col>
                  <a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="version.rules.authenticated" @change="(checked: boolean) => run(() => store.updateRule({ authenticated: checked }), '已生成新的待审版本')" /></a-form-item></a-col>
                </a-row>
              </a-form>
              <a-divider>逐步放量</a-divider>
              <a-slider :value="version.rollout" :min="0" :max="100" :step="5" @change="(value: number) => run(() => store.setRollout(value), '已生成新的待审版本')" />
              <div class="rollout-label">{{ version.rollout }}% 用户可命中（修改后生成待审版本）</div>
              <a-divider>定时生效</a-divider>
              <a-input type="datetime-local" class="schedule-input" :value="version.scheduledAt" @change="(event: Event) => run(() => store.schedule((event.target as HTMLInputElement).value), '已生成新的待审版本')" />
              <a-divider>审批与发布</a-divider>
              <a-space wrap>
                <a-button v-for="role in REQUIRED_ROLES" :key="role" :disabled="approvedRoles.includes(role)" @click="run(() => store.approve(role), `${role} 已审批 v${version?.version}`)">{{ role }}审批</a-button>
                <a-button type="primary" @click="run(() => store.startRollout(), '发布成功，生效快照已更新')">{{ liveBatch ? '发布新版本（替换当前批次）' : '开始灰度发布' }}</a-button>
              </a-space>
              <div v-if="!store.isActiveVersionApproved" class="hint">当前 v{{ version.version }} 审批 {{ version.approvals.length }}/{{ REQUIRED_ROLES.length }}：审批绑定修改时的版本，未通过双审批时发布将被拒绝。</div>
              <div v-if="liveBatch" class="hint">灰度进行中：命中模拟与审计记录读取批次 {{ liveBatch.id }} 的生效快照，改规则只生成待审版本。</div>
            </a-card>
            <a-card title="发布计划版本" size="small" class="mb">
              <a-list :data-source="versionsReversed" size="small">
                <template #renderItem="{ item }">
                  <a-list-item>
                    <a-list-item-meta>
                      <template #title><a-space :size="6" wrap><b>v{{ item.version }}</b><a-tag :color="versionColor(item.status)">{{ versionText(item.status) }}</a-tag><span>{{ item.source }}</span><span class="dim">{{ item.createdAt }}</span></a-space></template>
                      <template #description>
                        规则 {{ item.rules.region }} / {{ item.rules.appVersion }} / {{ item.rules.authenticated ? '需登录' : '免登录' }} · 放量 {{ item.rollout }}% · 定时 {{ item.scheduledAt }}<br />
                        审批：{{ item.approvals.map((entry: Approval) => `${entry.role} ${entry.at}`).join('、') || '待审批' }}
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                </template>
              </a-list>
            </a-card>
            <a-card title="灰度批次" size="small" class="mb">
              <a-empty v-if="!store.batchesOf(active.id).length" description="暂无批次" />
              <a-list v-else :data-source="store.batchesOf(active.id)" size="small">
                <template #renderItem="{ item }">
                  <a-list-item>
                    <a-space :size="6" wrap>
                      <code>{{ item.id }}</code>
                      <a-tag :color="batchColor(item.state)">{{ batchText(item.state) }}</a-tag>
                      <span>v{{ item.version }} · {{ item.snapshot.rollout }}%</span>
                      <span class="dim">开始 {{ item.startedAt }}<template v-if="item.endedAt"> · 结束 {{ item.endedAt }}</template></span>
                      <span v-if="item.operations.length" class="dim">已执行：{{ item.operations.join('、') }}</span>
                    </a-space>
                  </a-list-item>
                </template>
              </a-list>
            </a-card>
            <a-card v-if="store.failedWrites.length" title="失败项（写入失败，已保留原状态）" size="small" class="mb">
              <a-list :data-source="store.failedWrites" size="small">
                <template #renderItem="{ item }">
                  <a-list-item>
                    <a-list-item-meta>
                      <template #title><a-space :size="6" wrap><span>{{ item.at }}</span><span>{{ item.summary }}</span><a-tag color="orange">已重试 {{ item.retries }} 次</a-tag></a-space></template>
                      <template #description>{{ item.reason }}</template>
                    </a-list-item-meta>
                  </a-list-item>
                </template>
              </a-list>
              <a-button type="primary" class="mt" @click="run(() => store.retryFailedWrites(), '重试成功，失败项已清空')">重试写入</a-button>
            </a-card>
            <a-card title="审计记录">
              <a-timeline>
                <a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') ? 'red' : 'blue'">
                  <b>{{ item.at }} · {{ item.actor }}</b>
                  <p class="audit-line">{{ item.action }}：{{ item.detail }}</p>
                  <a-space :size="4">
                    <a-tag v-if="item.batchId">批次 {{ item.batchId }}</a-tag>
                    <a-tag v-if="item.version" color="blue">v{{ item.version }}</a-tag>
                  </a-space>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create">
      <a-form layout="vertical">
        <a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item>
        <a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item>
      </a-form>
    </a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.switch-label { color: #c7d2fe; font-size: 12px; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }
.mt { margin-top: 14px; }
.selected { background: #eef2ff; cursor: pointer; }
.rollout-label { color: #4338ca; font-weight: 700; }
.ant-list-item { cursor: pointer; }
.dim { color: #94a3b8; font-size: 12px; }
.hint { color: #b45309; font-size: 12px; margin-top: 8px; }
.audit-line { margin: 4px 0; }
.schedule-input { max-width: 320px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; } .content { padding: 16px; } }
</style>
