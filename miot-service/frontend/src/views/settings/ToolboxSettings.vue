<script setup lang="ts">
import { computed, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlStatusChip from '../../ui/SlStatusChip.vue';
import SlEmptyState from '../../ui/SlEmptyState.vue';
import { currentDevice, deviceName, messageOf, notify, playerCommand, state } from '../../store';

const url = ref('https://lhttp.qtfm.cn/live/4915/64k.mp3');
const text = ref('');
const targetLabel = computed(() =>
  currentDevice.value ? deviceName(currentDevice.value) : '未选择设备',
);
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
</script>

<template>
  <div class="toolbox-target-card">
    <div>
      <span class="settings-header-eyebrow">当前操作目标</span><strong>{{ targetLabel }}</strong
      ><small>文字播报发送到这台设备；URL 播放会同步到它所在的设备分组。</small>
    </div>
    <SlStatusChip
      :label="currentDevice ? '已就绪' : '不可用'"
      :tone="currentDevice ? 'success' : 'warning'"
      :icon="currentDevice ? 'speaker' : 'warning'"
    />
  </div>
  <SectionCard
    title="URL 播放"
    icon="link"
    description="将音频 URL 推送到当前选中的设备或设备分组。URL 必须能从音箱所在网络访问。"
  >
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
  <SectionCard
    title="文字播报"
    icon="record_voice_over"
    description="使用当前设备的 TTS 播报文字。"
  >
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
      <div class="field-actions">
        <SlButton
          variant="text"
          label="清空记录"
          icon="delete_sweep"
          @click="state.operationLog = []"
        />
      </div>
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
        description="文字播报结果和操作失败信息会显示在这里。"
        icon="terminal"
      />
    </div>
  </SectionCard>
</template>
