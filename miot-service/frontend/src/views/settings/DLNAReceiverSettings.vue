<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { get, put } from '../../api';
import { messageOf, notify, state } from '../../store';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSwitch from '../../ui/SlSwitch.vue';

interface ReceiverStatus {
  enabled: boolean; name: string; base_url: string; enabled_ids: string[];
  running: boolean; host_supported: boolean; error: string;
  receivers: Array<{ id: string; enabled: boolean; available: boolean; account_id: string; device_id: string; name: string; running: boolean; state: string; error: string; group_id: string; members: Array<{ account_id: string; device_id: string }> }>;
}
const form = reactive({ enabled: false, name: 'Miot 小爱音箱', base_url: '', enabled_ids: [] as string[] });
const status = ref<ReceiverStatus | null>(null);
const saving = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
function playbackLabel(value: string): string { return ({ PLAYING: '播放中', PAUSED_PLAYBACK: '已暂停', STOPPED: '已停止', NO_MEDIA_PRESENT: '等待投放' } as Record<string, string>)[value] || value; }
// 每个接收器的运行状态文案，统一收到「保存接收器设置」按钮之前显示；
// 多个接收器时带上名称前缀，避免几条状态混在一起看不出归属。
function receiverStateText(receiver: ReceiverStatus['receivers'][number]): string {
  if (receiver.running) return playbackLabel(receiver.state);
  if (!receiver.enabled) return '插件入口已关闭';
  if (!status.value?.enabled) return '总开关已关闭';
  return receiver.available ? '未运行' : '不可用';
}
const statusTexts = computed(() => {
  const receivers = status.value?.receivers || [];
  const many = receivers.length > 1;
  return receivers.map((receiver) => many ? `${receiver.name}：${receiverStateText(receiver)}` : receiverStateText(receiver));
});
let revision = 0;
async function refresh(initial = false) {
  const current = revision;
  try {
    const result = await get<ReceiverStatus>('/receiver/config');
    if (disposed || current !== revision) return;
    status.value = result;
    error.value = result.error;
    if (initial) {
      form.enabled = result.enabled;
      form.enabled_ids = result.enabled_ids.slice();
      form.name = result.name;
      form.base_url = result.base_url || state.config.server_host;
    }
  } catch (cause) { if (!disposed && current === revision) error.value = messageOf(cause); }
  if (!disposed && current === revision) timer = setTimeout(() => { void refresh(); }, 5000);
}
function selectReceiver(id: string, enabled: boolean): void {
  form.enabled_ids = enabled ? [...new Set([...form.enabled_ids, id])] : form.enabled_ids.filter(value => value !== id);
}
async function save() {
  revision++;
  if (timer !== null) clearTimeout(timer);
  saving.value = true;
  try {
    const result = await put<ReceiverStatus>('/receiver/config', { ...form });
    if (disposed) return;
    status.value = result;
    error.value = status.value.error;
    notify(form.enabled ? 'DLNA 接收器已开启' : 'DLNA 接收器已关闭', 'success');
  } catch (cause) { if (!disposed) { error.value = messageOf(cause); notify(error.value, 'error'); } }
  finally { saving.value = false; if (!disposed) timer = setTimeout(() => { void refresh(); }, 5000); }
}
onMounted(() => { void refresh(true); });
onUnmounted(() => { disposed = true; if (timer !== null) clearTimeout(timer); });
</script>

<template>
  <SectionCard title="DLNA 接收器" icon="speaker_group">
    <SettingRow title="插件 DLNA 总开关">
      <SlSwitch v-model="form.enabled" :disabled="saving || (!status?.host_supported && !form.enabled)" aria-label="启用 DLNA 接收器" />
    </SettingRow>
    <SettingRow title="接收器名称前缀">
      <SlInput v-model="form.name" :disabled="saving" aria-label="DLNA 接收器名称" />
    </SettingRow>
    <SettingRow title="服务器局域网地址">
      <SlInput v-model="form.base_url" :disabled="saving" placeholder="http://192.168.1.10:58091" aria-label="DLNA 服务器地址" />
    </SettingRow>
    <div class="form-body">
      <p v-if="status && !status.host_supported" role="alert">请升级 Miot 宿主以支持 DLNA 接收。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="status && !status.receivers.length">暂无可用的音箱或分组，请先启用音箱管理。</p>
      <div v-for="receiver in status?.receivers || []" :key="receiver.id" class="receiver-status">
        <SettingRow :title="receiver.name">
          <SlSwitch :model-value="form.enabled_ids.includes(receiver.id)" :disabled="saving || !status?.host_supported || (!receiver.available && !form.enabled_ids.includes(receiver.id))" :aria-label="`为 ${receiver.name} 启用插件 DLNA`" @update:model-value="selectReceiver(receiver.id, $event)" />
        </SettingRow>
        <p v-if="receiver.group_id">分组 · {{ receiver.members.length }} 台音箱；进度和查询音量以首台音箱为参考。</p>
        <p v-if="receiver.error" role="alert">{{ receiver.error }}</p>
      </div>
      <div class="receiver-save-row">
        <span v-if="statusTexts.length" class="receiver-save-status" role="status">{{ statusTexts.join(' · ') }}</span>
        <SlButton :disabled="saving || !status" variant="filled" :label="saving ? '正在保存…' : '保存接收器设置'" @click="save" />
      </div>
    </div>
  </SectionCard>
</template>

<style scoped>
.receiver-save-row { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 10px 12px; }
.receiver-save-row :deep(.sl-button) { flex: 0 0 auto; width: auto; }
.receiver-save-status { min-width: 0; color: var(--md-on-surface-variant, #666); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
</style>
