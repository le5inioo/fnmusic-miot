<script setup lang="ts">
import { computed, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlStatusChip from '../../ui/SlStatusChip.vue';
import SlEmptyState from '../../ui/SlEmptyState.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import { hostPathPrefix } from '../../api';
import { currentDevice, deviceName, messageOf, notify, playerCommand, saveConfig, state } from '../../store';

const appVersion = __APP_VERSION__;

const url = ref('https://lhttp.qtfm.cn/live/4915/64k.mp3');
const text = ref('');
const targetLabel = computed(() => {
  const device = currentDevice.value;
  if (!device) return '未选择设备';
  // 型号优先取 model；小米音箱的 model 常为空，真正的型号在 hardware（如 OH2P）。
  // 两者都没有时不拼分隔符，避免出现「智能音箱 · 」。
  const model = device.model?.trim() || device.hardware?.trim() || '';
  return model ? `${deviceName(device)} · ${model}` : deviceName(device);
});
async function sendUrl() {
  if (!url.value.trim()) return;
  try {
    await playerCommand('/mina/play-url', { url: url.value.trim() });
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}
async function repeatText(content: string): Promise<boolean> {
  if (!content.trim()) return false;
  try {
    return await playerCommand('/mina/tts', { text: content.trim() });
  } catch {
    // playerCommand 已记录失败并展示错误提示。
    return false;
  }
}

async function sendText() {
  const draft = text.value;
  if ((await repeatText(draft)) && text.value === draft) text.value = '';
}

// ---- 调试与诊断 ----

const debugExporting = ref(false);

function setDebugLogEnabled(enabled: boolean): void {
  void saveConfig({ debug_log_enabled: enabled });
}

/** 导出控制层运行日志（服务端拼装文本，浏览器触发下载）。 */
async function exportDiagnostics(): Promise<void> {
  if (debugExporting.value) return;
  debugExporting.value = true;
  try {
    const token = window.SongloftPlugin?.getAuthToken?.() || '';
    const resp = await fetch(`${hostPathPrefix()}/diagnostics/logs?lines=2000`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) throw new Error(`导出失败 (${resp.status})`);
    const disposition = resp.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match ? match[1] : `fnmusic-miot-diag-${Date.now()}.log`;
    const blobUrl = URL.createObjectURL(await resp.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    notify('诊断日志已导出', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    debugExporting.value = false;
  }
}
</script>

<template>
  <div class="toolbox-target-card">
    <div>
      <span class="settings-header-eyebrow">当前操作目标</span><strong>{{ targetLabel }}</strong>
    </div>
    <SlStatusChip
      :label="currentDevice ? '已就绪' : '不可用'"
      :tone="currentDevice ? 'success' : 'warning'"
      :icon="currentDevice ? 'speaker' : 'warning'"
    />
  </div>
  <SectionCard title="URL 播放" icon="link">
    <div class="form-body">
      <div class="inline-fields">
        <SlInput
          v-model="url"
          type="url"
          placeholder="https://example.com/audio.mp3"
          aria-label="音频 URL"
          @submit="sendUrl"
        /><SlButton variant="filled" label="播放" icon="play_arrow" @click="sendUrl" />
      </div>
    </div>
  </SectionCard>
  <SectionCard title="文字播报" icon="record_voice_over">
    <div class="form-body">
      <div class="inline-fields">
        <SlInput
          v-model="text"
          placeholder="输入要播报的文字"
          aria-label="播报文字"
          @submit="sendText"
        /><SlButton
          variant="filled"
          label="播报"
          icon="campaign"
          :disabled="state.playerBusy || !currentDevice || !text.trim()"
          @click="sendText"
        />
      </div>
    </div>
  </SectionCard>
  <SectionCard title="操作结果" icon="terminal">
    <div class="form-body">
      <div v-for="item in state.operationLog" :key="item.id" class="list-item">
        <div class="list-item-copy">
          <strong class="list-item-title" :title="item.ttsText || item.message">{{
            item.ttsText || item.message
          }}</strong
          ><span class="list-item-subtitle" :title="item.message"
            >{{ item.time }}<template v-if="item.ttsText"> · {{ item.message }}</template></span
          >
        </div>
        <span class="chip" :class="item.success ? 'chip-success' : 'chip-error'">{{
          item.success ? '成功' : '失败'
        }}</span
        ><SlButton
          v-if="item.ttsText"
          variant="icon"
          label="重复播报"
          icon="refresh"
          title="向当前设备重复播报"
          :disabled="state.playerBusy || !currentDevice"
          @click="repeatText(item.ttsText)"
        />
      </div>
      <SlEmptyState
        v-if="!state.operationLog.length"
        compact
        title="暂无操作记录"
        class="toolbox-empty-state"
      />
      <div class="field-actions toolbox-log-actions">
        <SlButton
          variant="text"
          label="清空记录"
          icon="delete_sweep"
          @click="state.operationLog = []"
        />
      </div>
    </div>
  </SectionCard>
  <SectionCard title="调试与诊断" icon="bug_report" class="toolbox-debug-card">
    <div class="form-body">
      <SettingRow title="全局调试日志">
        <SlSwitch
          aria-label="全局调试日志"
          :model-value="state.config.debug_log_enabled"
          @update:model-value="setDebugLogEnabled"
        />
      </SettingRow>
      <div class="toolbox-export-row">
        <p class="field-help toolbox-export-hint">
          遇到BUG，先打开开关，再复现BUG，再导出日志。
        </p>
        <div class="field-actions toolbox-export-actions">
          <SlButton
            variant="outlined"
            label="导出日志"
            icon="download"
            :disabled="debugExporting"
            @click="exportDiagnostics"
          />
        </div>
      </div>
    </div>
  </SectionCard>
  <div class="toolbox-version">v{{ appVersion }}</div>
</template>
