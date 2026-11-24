<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlStatusChip from '../../ui/SlStatusChip.vue';
import { hostRequest } from '../../api';
import { clearPortSetupPending, messageOf, notify, state } from '../../store';

interface PortConfig {
  success: boolean;
  control_port: number;
  console_port: number;
  gateway_port: number;
  default_control_port: number;
  default_console_port: number;
  server_host: string;
  pending: boolean;
  reason: string;
  from_version: string;
  version: string;
  restart_supported: boolean;
  env_file: string;
}

interface ApplyResult {
  success: boolean;
  changed: boolean;
  restart: boolean;
  restart_mode: string;
  restart_delay_seconds: number;
  control_port: number;
  console_port: number;
  console_changed: boolean;
  previous_console_port: number;
}

const loading = ref(true);
const saving = ref(false);
const suggestBusy = ref(false);
const error = ref('');
const config = ref<PortConfig | null>(null);

const controlInput = ref('');
const consoleInput = ref('');

// 应用端口后：服务重启提示与（仅限局域网直连场景的）新地址跳转。
const applied = ref<ApplyResult | null>(null);
const previousConsolePort = ref(0);

const isDirectTcp = computed(() => {
  const p = Number(window.location.port);
  return p > 0 && p === previousConsolePort.value;
});
const newConsoleUrl = computed(() => {
  if (!applied.value || !isDirectTcp.value) return '';
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return `${proto}//${host}:${applied.value.console_port}/`;
});

async function loadConfig(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const cfg = await hostRequest<PortConfig>('GET', '/ports/config');
    config.value = cfg;
    controlInput.value = String(cfg.control_port);
    consoleInput.value = String(cfg.console_port);
  } catch (err) {
    error.value = messageOf(err);
  } finally {
    loading.value = false;
  }
}

const pending = computed(() => state.portSetupPending || !!config.value?.pending);

const validationError = computed(() => {
  const c = Number(controlInput.value);
  const n = Number(consoleInput.value);
  if (!Number.isInteger(c) || !Number.isInteger(n)) return '端口必须是 1024~65535 之间的整数';
  if (c < 1024 || c > 65535 || n < 1024 || n > 65535) return '端口必须在 1024~65535 之间';
  if (c === n) return '控制层端口与控制台端口不能相同';
  const gw = config.value?.gateway_port || 6688;
  if (c === gw || n === gw) return `端口不能与飞牛音乐网关端口 ${gw} 相同`;
  if (c === 8774 || n === 8774) return '8774 为系统预留端口，请换一个';
  return '';
});

const canSave = computed(() => !saving.value && !validationError.value && !!config.value);

async function suggestPorts(): Promise<void> {
  if (suggestBusy.value) return;
  suggestBusy.value = true;
  error.value = '';
  try {
    const res = await hostRequest<{ control_port: number; console_port: number }>(
      'GET',
      '/ports/suggest',
    );
    controlInput.value = String(res.control_port);
    consoleInput.value = String(res.console_port);
    notify('已填入两个可用的随机端口', 'success');
  } catch (err) {
    error.value = messageOf(err);
  } finally {
    suggestBusy.value = false;
  }
}

async function applyPorts(): Promise<void> {
  if (!canSave.value) return;
  if (validationError.value) {
    error.value = validationError.value;
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const res = await hostRequest<ApplyResult>('POST', '/ports/apply', {
      control_port: Number(controlInput.value),
      console_port: Number(consoleInput.value),
    });
    previousConsolePort.value = res.previous_console_port;
    applied.value = res;
    state.portSetupPending = false;
    clearPortSetupPending();
    if (config.value) config.value = { ...config.value, pending: false };
    if (res.changed) {
      notify('端口已保存，服务正在重启', 'success');
    } else {
      notify('端口未变化，无需重启', 'info');
    }
  } catch (err) {
    error.value = messageOf(err);
  } finally {
    saving.value = false;
  }
}

async function keepDefault(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await hostRequest('POST', '/ports/setup-done');
    state.portSetupPending = false;
    clearPortSetupPending();
    if (config.value) config.value = { ...config.value, pending: false };
    notify('已保持默认端口', 'success');
  } catch (err) {
    error.value = messageOf(err);
  } finally {
    saving.value = false;
  }
}

function openNewConsole(): void {
  if (newConsoleUrl.value) window.location.href = newConsoleUrl.value;
}
function reloadPage(): void {
  window.location.reload();
}

onMounted(loadConfig);
</script>

<template>
  <div class="port-settings">
    <SectionCard
      v-if="pending"
      title="首次端口设置引导"
      icon="info"
      tone="warning"
      flat
      description="首次安装或升级后确认端口；可保持默认，或手动填写/自动填充。"
    >
      <template #actions>
        <SlStatusChip label="待设置" tone="warning" icon="warning" />
      </template>
      <div class="field-actions guide-actions">
        <SlButton
          variant="filled"
          label="保持默认并跳过引导"
          icon="check"
          :disabled="saving"
          @click="keepDefault"
        />
      </div>
    </SectionCard>

    <SectionCard title="修改端口" icon="swap_horiz">
      <div class="form-body">
        <div class="port-fields">
          <label class="port-field">
            <span class="port-field-label">控制层端口</span>
            <SlInput
              v-model="controlInput"
              type="number"
              aria-label="控制层端口"
              :disabled="loading || saving"
              @submit="applyPorts"
            />
          </label>
          <label class="port-field">
            <span class="port-field-label">控制台端口</span>
            <SlInput
              v-model="consoleInput"
              type="number"
              aria-label="控制台端口"
              :disabled="loading || saving"
              @submit="applyPorts"
            />
          </label>
          <SlButton
            class="port-suggest-btn"
            variant="tonal"
            label="自动填充"
            icon="auto_awesome"
            :disabled="loading || saving || suggestBusy"
            @click="suggestPorts"
          />
          <SlButton
            class="port-save-btn"
            variant="filled"
            label="保存并应用"
            icon="save"
            :disabled="!canSave"
            @click="applyPorts"
          />
        </div>
        <p v-if="error" class="field-error">{{ error }}</p>
        <p v-if="validationError" class="field-error">{{ validationError }}</p>
      </div>
    </SectionCard>

    <SectionCard
      v-if="applied"
      title="已提交"
      icon="check"
      :tone="applied.changed ? 'default' : 'default'"
      :description="applied.changed ? `服务正在以新端口重启（约 ${applied.restart_delay_seconds} 秒后生效）。` : '端口未变化，无需重启。'"
    >
      <div class="form-body">
        <SettingRow title="控制层端口" :subtitle="`新值 ${applied.control_port}`">
          <SlStatusChip :label="String(applied.control_port)" tone="success" />
        </SettingRow>
        <SettingRow title="控制台端口" :subtitle="`新值 ${applied.console_port}`">
          <SlStatusChip :label="String(applied.console_port)" tone="success" />
        </SettingRow>
        <p class="field-help">
          主入口为系统 socket，不受端口变更影响；稍等几秒刷新即可。
        </p>
        <div v-if="applied.changed" class="field-actions">
          <SlButton
            v-if="isDirectTcp"
            variant="filled"
            label="在新地址打开控制台"
            icon="open_in_new"
            @click="openNewConsole"
          />
          <SlButton
            v-else
            variant="outlined"
            label="刷新页面"
            icon="refresh"
            @click="reloadPage"
          />
        </div>
      </div>
    </SectionCard>

  </div>
</template>

<style scoped>
.port-settings { display: flex; flex-direction: column; gap: 16px; min-width: 0; max-width: 100%; }
/* 桌面端两个端口输入框 + 「自动填充」+「保存并应用」四者等宽一排；用 grid 的 minmax(0,…)
   保证永不超出容器宽度（旧版 flex + nowrap + 固定 120px 输入框在手机上必然溢出）。 */
.port-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: end; min-width: 0; }
.port-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.port-field-label { font-size: 13px; color: var(--md-on-surface-variant, #555); }
.port-suggest-btn, .port-save-btn { min-width: 0; width: 100%; }
/* 「自动填充」保留原有圆角与边框样式，只把配色改成与「保存并应用」一致。 */
.port-suggest-btn.sl-button-tonal {
  background: var(--md-primary);
  color: var(--md-on-primary);
  border-color: var(--md-primary);
}
.guide-actions { margin-top: 2px; padding: 0 8px; justify-content: flex-start; }
.field-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.field-help { font-size: 12px; color: var(--md-on-surface-variant, #666); margin: 8px 0 0; line-height: 1.5; }
.field-error { font-size: 13px; color: #d32f2f; margin: 8px 0 0; }

/* 窄屏（手机）：两个端口输入框一行，两个按钮紧随其后并排一行，避免横向滚动。 */
@media (max-width: 599px) {
  .port-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
</style>
