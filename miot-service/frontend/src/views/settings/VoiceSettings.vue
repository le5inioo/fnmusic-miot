<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlIcon from '../../ui/SlIcon.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import VoiceSectionNav from './voice/VoiceSectionNav.vue';
import { del, post, pluginWebSocketUrl } from '../../api';
import {
  addWebhook,
  clearMemory,
  confirmAction,
  deleteWebhook,
  loadConversationMessages,
  loadMemory,
  loadVoiceData,
  managedDevices,
  messageOf,
  notify,
  refreshIndex,
  saveConfig,
  saveVoiceCommands,
  state,
} from '../../store';
import type { MemoryEntity, VoiceCommand } from '../../types';

const voicePanel = ref<VoicePanel>('listen');
const voicePanels: Array<{ id: VoicePanel; title: string; subtitle: string; icon: string }> = [
  { id: 'listen', title: '监听', subtitle: '对话与索引', icon: 'record_voice_over' },
  { id: 'commands', title: '口令', subtitle: '规则与测试', icon: 'mic' },
  { id: 'memory', title: '记忆', subtitle: '命中与歧义', icon: 'memory' },
  { id: 'intelligence', title: '搜索', subtitle: '飞牛音乐搜索', icon: 'auto_awesome' },
];

type VoicePanel = 'listen' | 'commands' | 'memory' | 'intelligence';

interface CommandTestResult {
  matched: boolean;
  source: 'ai' | 'rule' | 'none';
  commandType?: string;
  keyword?: string;
  argument?: string;
  search?: { kind: 'song' | 'playlist'; found: boolean; detail: string } | null;
  ai?: { action: string; confidence: string } | null;
  executed: boolean;
  note?: string;
}

const commandLabels: Record<string, string> = {
  play_playlist: '播放歌单',
  play_artist: '播放歌手',
  play_song: '播放歌曲',
  play_index: '播放指定序号',
  set_play_mode: '播放模式',
  set_volume: '音量控制',
  favorite: '收藏歌曲',
  next: '下一首',
  previous: '上一首',
  stop: '停止播放',
  sleep_timer: '定时停止',
  cancel_sleep_timer: '取消定时',
  query_sleep_timer: '查询定时',
};
const commandIcons: Record<string, string> = {
  play_playlist: 'queue_music',
  play_artist: 'artist',
  play_song: 'music_note',
  play_index: 'format_list_numbered',
  set_play_mode: 'repeat',
  set_volume: 'volume_up',
  favorite: 'favorite',
  next: 'skip_next',
  previous: 'skip_previous',
  stop: 'stop',
  sleep_timer: 'bedtime',
  cancel_sleep_timer: 'timer_off',
  query_sleep_timer: 'timer',
};
const parameterLabels: Record<string, string> = {
  random: '随机播放',
  single: '单曲循环',
  loop: '列表循环',
  order: '顺序播放',
  singlePlay: '单曲播放',
  absolute: '绝对音量',
  up: '增大音量',
  down: '减小音量',
  add: '收藏',
  remove: '取消收藏',
};
const pollInterval = ref(String(state.config.conversation_poll_interval));
const maxIndex = ref(String(state.config.max_song_index));
const maxMemory = ref(String(state.config.voice_memory_max_records));
const webhookName = ref('');
const webhookUrl = ref('');
const commandInputs = reactive<Record<string, string>>({});
const commandInputVersions = reactive<Record<string, number>>({});
const commandSaving = ref(false);
const commandTestQuery = ref('');
const commandTestResult = ref('');
const commandTestSuccess = ref(false);
const commandTestBusy = ref(false);
const voiceCommandsExpanded = ref(false);
const conversationMessagesExpanded = ref(false);
const memoryExpanded = ref(false);
const memoryLoaded = ref(false);
const memoryLoading = ref(false);
const expandedMemory = ref<string | null>(null);
let conversationSocket: WebSocket | null = null;
let conversationPoll: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await loadVoiceData();
  if (state.config.conversation_monitor_enabled) connectConversation();
});
onUnmounted(() => {
  conversationSocket?.close();
  if (conversationPoll) clearInterval(conversationPoll);
});

function commandKey(command: VoiceCommand, index: number): string {
  return `${command.type}:${command.param || ''}:${index}`;
}

function keywordsOf(command: VoiceCommand): string[] {
  if (command.keywords?.length) return command.keywords;
  if (command.patterns?.length) return command.patterns;
  return command.pattern ? [command.pattern] : [];
}

function cloneCommand(command: VoiceCommand): VoiceCommand {
  return { ...command, keywords: [...keywordsOf(command)] };
}

async function replaceCommand(index: number, update: (command: VoiceCommand) => void): Promise<boolean> {
  if (commandSaving.value) return false;
  const commands = state.voiceCommands.map(cloneCommand);
  update(commands[index]);
  commandSaving.value = true;
  try {
    await saveVoiceCommands(commands);
    return true;
  } catch (error) {
    notify(messageOf(error), 'error');
    return false;
  } finally {
    commandSaving.value = false;
  }
}

async function addKeyword(command: VoiceCommand, index: number): Promise<void> {
  const key = commandKey(command, index);
  const keyword = (commandInputs[key] || '').trim();
  if (!keyword) {
    notify('请输入口令词', 'warning');
    return;
  }
  if (keywordsOf(command).includes(keyword)) {
    notify('口令词已存在', 'warning');
    return;
  }
  if (await replaceCommand(index, (item) => item.keywords = [...keywordsOf(item), keyword])) {
    commandInputs[key] = '';
    commandInputVersions[key] = (commandInputVersions[key] || 0) + 1;
  }
}

async function removeKeyword(command: VoiceCommand, index: number, keywordIndex: number): Promise<void> {
  if (keywordsOf(command).length <= 1) {
    notify('每条命令至少保留一个口令词', 'warning');
    return;
  }
  await replaceCommand(index, (item) => item.keywords = keywordsOf(item).filter((_, i) => i !== keywordIndex));
}

async function setCommandEnabled(index: number, enabled: boolean): Promise<void> {
  await replaceCommand(index, (command) => command.enabled = enabled);
}

async function resetCommands(): Promise<void> {
  if (!(await confirmAction('恢复默认口令', '当前自定义口令词会被默认配置覆盖。', '恢复默认')).confirmed) return;
  commandSaving.value = true;
  try {
    await saveVoiceCommands([]);
    await loadVoiceData();
    notify('已恢复默认口令', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    commandSaving.value = false;
  }
}

async function setConversationEnabled(enabled: boolean): Promise<void> {
  const patch = enabled
    ? { conversation_monitor_enabled: true }
    : {
      conversation_monitor_enabled: false,
      voice_command_enabled: false,
      ai_config: { ...state.config.ai_config, enabled: false },
    };
  try {
    await saveConfig(patch);
    enabled ? connectConversation() : disconnectConversation();
  } catch { /* saveConfig presents the error */ }
}

async function setVoiceEnabled(enabled: boolean): Promise<void> {
  if (enabled && !state.config.conversation_monitor_enabled) {
    notify('请先开启对话监听', 'warning');
    return;
  }
  const patch = enabled
    ? { voice_command_enabled: true }
    : {
      voice_command_enabled: false,
      ai_config: { ...state.config.ai_config, enabled: false },
    };
  try { await saveConfig(patch); } catch { /* saveConfig presents the error */ }
}

function setSwitch(key: keyof typeof state.config, value: boolean): void {
  void saveConfig({ [key]: value } as never);
}

async function saveNumber(
  key: 'conversation_poll_interval' | 'max_song_index' | 'voice_memory_max_records',
  raw: string,
  min: number,
  max: number,
): Promise<void> {
  const value = Math.max(min, Math.min(max, Number.parseInt(raw, 10) || min));
  if (key === 'conversation_poll_interval') pollInterval.value = String(value);
  if (key === 'max_song_index') maxIndex.value = String(value);
  if (key === 'voice_memory_max_records') maxMemory.value = String(value);
  try {
    await saveConfig({ [key]: value });
    if (key === 'voice_memory_max_records' && memoryExpanded.value) await ensureMemoryLoaded(true);
  } catch { /* saveConfig presents the error */ }
}

function connectConversation(): void {
  disconnectConversation();
  if (typeof WebSocket === 'undefined') {
    conversationPoll = setInterval(() => void loadConversationMessages(), 4000);
    return;
  }
  try {
    conversationSocket = new WebSocket(pluginWebSocketUrl('/conversation/ws?limit=50'));
    conversationSocket.onopen = () => {
      if (conversationPoll) clearInterval(conversationPoll);
      conversationPoll = null;
    };
    conversationSocket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'snapshot') state.conversationMessages = frame.data || [];
        else if (frame.type === 'message') state.conversationMessages.unshift(frame.data);
      } catch { /* ignore malformed stream frame */ }
    };
    conversationSocket.onerror = () => conversationSocket?.close();
    conversationSocket.onclose = () => {
      conversationSocket = null;
      if (state.config.conversation_monitor_enabled && !conversationPoll) {
        conversationPoll = setInterval(() => void loadConversationMessages(), 4000);
      }
    };
  } catch {
    conversationPoll = setInterval(() => void loadConversationMessages(), 4000);
  }
}

function disconnectConversation(): void {
  conversationSocket?.close();
  conversationSocket = null;
  if (conversationPoll) clearInterval(conversationPoll);
  conversationPoll = null;
}

async function refreshConversation(): Promise<void> {
  await loadConversationMessages();
  notify('对话记录已刷新', 'success');
}

async function ensureMemoryLoaded(force = false): Promise<void> {
  if (memoryLoading.value) return;
  if (!force && memoryLoaded.value) return;
  memoryLoading.value = true;
  try {
    await loadMemory();
    memoryLoaded.value = true;
  } finally {
    memoryLoading.value = false;
  }
}

async function toggleMemoryExpanded(): Promise<void> {
  memoryExpanded.value = !memoryExpanded.value;
  if (memoryExpanded.value) {
    await ensureMemoryLoaded();
  }
}

async function addHook(): Promise<void> {
  if (!webhookUrl.value.trim()) return;
  try {
    await addWebhook(webhookName.value.trim(), webhookUrl.value.trim());
    webhookName.value = '';
    webhookUrl.value = '';
    notify('Webhook 已添加', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}

async function removeHook(id: string): Promise<void> {
  if (!(await confirmAction('删除 Webhook', '确定删除这个回调地址吗？', '删除', true)).confirmed) return;
  try { await deleteWebhook(id); } catch (error) { notify(messageOf(error), 'error'); }
}

function formatCommandResult(result: CommandTestResult, elapsedMs: number): string {
  const lines: string[] = [];
  if (!result.matched) {
    lines.push('未匹配到口令');
  } else {
    lines.push(`匹配来源：${result.source === 'ai' ? 'AI 分析' : '规则匹配'}`);
    if (result.commandType) lines.push(`命令：${commandLabels[result.commandType] || result.commandType}`);
    if (result.keyword) lines.push(`命中口令词：${result.keyword}`);
    if (result.argument) lines.push(`搜索参数：${result.argument}`);
    if (result.search) {
      lines.push(`${result.search.kind === 'playlist' ? '歌单' : '歌曲'}：${result.search.found ? '已找到' : '未找到'} ${result.search.detail}`);
    }
    if (result.ai) lines.push(`AI：${result.ai.action}，置信度 ${result.ai.confidence}`);
    lines.push(result.executed ? '已投放到当前设备执行' : '未执行');
  }
  if (result.note) lines.push(`说明：${result.note}`);
  lines.push(`耗时：${elapsedMs} ms`);
  return lines.join('\n');
}

async function testCommand(): Promise<void> {
  const query = commandTestQuery.value.trim();
  if (!query) return;
  if (!state.currentDeviceId) {
    notify('请先在首页选择设备', 'warning');
    return;
  }
  commandTestBusy.value = true;
  const startedAt = Date.now();
  try {
    const result = await post<CommandTestResult>('/voice-commands/test', {
      query,
      device_id: state.currentDeviceId,
      account_id: state.currentAccountId,
    });
    commandTestSuccess.value = result.matched;
    commandTestResult.value = formatCommandResult(result, Date.now() - startedAt);
  } catch (error) {
    commandTestSuccess.value = false;
    commandTestResult.value = messageOf(error);
  } finally {
    commandTestBusy.value = false;
  }
}

function memoryAliases(entity: MemoryEntity): Array<{ id?: string; query?: string; alias?: string }> {
  return entity.aliases || entity.records || [];
}

async function deleteMemoryEntity(key: string, title: string): Promise<void> {
  if (!(await confirmAction('删除语音记忆', `确定删除"${title}"的全部记忆吗？`, '删除', true)).confirmed) return;
  try {
    await del(`/memory/entity?canonicalKey=${encodeURIComponent(key)}`);
    await ensureMemoryLoaded(true);
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}

async function deleteMemoryRecord(id?: string): Promise<void> {
  if (!id) return;
  try {
    await del(`/memory?id=${encodeURIComponent(id)}`);
    await ensureMemoryLoaded(true);
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}
</script>

<template>
  <VoiceSectionNav v-model="voicePanel" :panels="voicePanels" />

  <div v-show="voicePanel === 'listen'" class="voice-panel" data-voice-panel="listen">
  <SectionCard title="对话监听" icon="record_voice_over">
    <template #actions>
      <span v-if="state.config.conversation_monitor_enabled" class="conversation-status-dots">
        <span class="status-dot" :class="conversationSocket ? 'is-ok' : 'is-info'" :title="conversationSocket ? 'WebSocket 已连接' : '轮询回落中'" />
        <span class="status-dot" :class="managedDevices.length ? 'is-ok' : 'is-warn'" :title="`${managedDevices.length} 台受管理设备`" />
      </span>
    </template>
    <SettingRow title="启用对话监听">
      <SlSwitch aria-label="启用对话监听" :model-value="state.config.conversation_monitor_enabled" @update:model-value="setConversationEnabled" />
    </SettingRow>
    <div class="form-body conversation-status-body">
      <div class="field-grid conversation-inline-fields">
        <div class="field conversation-inline-field">
          <label class="field-label">轮询间隔（秒）</label>
          <SlInput :model-value="pollInterval" type="number" @update:model-value="pollInterval = $event" @change="saveNumber('conversation_poll_interval', pollInterval, 1, 30)" />
        </div>
      </div>
      <div class="conversation-status-card">
        <div class="conversation-status-row">
          <button type="button" class="advanced-toggle conversation-history-toggle" @click="conversationMessagesExpanded = !conversationMessagesExpanded">
            <span>{{ conversationMessagesExpanded ? '收起最近对话记录' : '展开最近对话记录' }}</span>
            <SlIcon :name="conversationMessagesExpanded ? 'expand_less' : 'expand_more'" :size="20" />
          </button>
          <div class="field-actions"><SlButton variant="tonal" class="input-style-btn" label="刷新" icon="refresh" @click="refreshConversation" /></div>
        </div>
        <!-- 「开关打开但没勾任何设备」是最容易踩的坑：口令测试正常但对话监听永远拿不到消息
             （songloft-org/songloft-plugin-miot#104）——只轮询 managed 设备，未勾选就整台都不进池 -->
        <div v-if="state.config.conversation_monitor_enabled && !managedDevices.length" class="dependency-hint"><SlIcon name="warning" :size="18" /><span>未勾选受管理设备，监听不会工作；请到"设备设置"勾选。</span></div>
        <div v-if="conversationMessagesExpanded" class="sub-panel">
          <div v-for="item in state.conversationMessages" :key="String(item.id || item.timestamp)" class="list-item">
            <div class="list-item-copy"><strong class="list-item-title">{{ item.query || item.text || '未识别内容' }}</strong><span class="list-item-subtitle">{{ item.device_name || item.device_id || '设备' }} · {{ item.answer || '暂无回复' }}</span></div>
          </div>
          <div v-if="!state.conversationMessages.length" class="empty-state">暂无对话记录</div>
        </div>
      </div>
    </div>
    <div class="form-body">
      <h3 class="card-title">Webhook 回调</h3>
      <div class="inline-fields webhook-fields"><SlInput v-model="webhookName" placeholder="名称（可选）" aria-label="Webhook 名称" /><SlInput v-model="webhookUrl" placeholder="https://..." aria-label="Webhook URL" /><SlButton variant="filled" label="添加" @click="addHook" /></div>
      <div v-for="hook in state.webhooks" :key="hook.id" class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ hook.name || hook.url }}</strong><span class="list-item-subtitle">{{ hook.url }}</span></div><SlButton variant="icon" icon="delete" title="删除 Webhook" @click="removeHook(hook.id)" /></div>
    </div>
  </SectionCard>

  <SectionCard title="歌曲索引" icon="database">
    <div class="form-body">
      <div class="status-panel status-panel-inset index-status-row"><div class="status-chips"><span class="chip" :class="state.indexStatus.ready || state.indexStatus.is_ready ? 'chip-success' : 'chip-warning'">{{ state.indexStatus.ready || state.indexStatus.is_ready ? '索引就绪' : '索引未就绪' }}</span><span class="chip">{{ state.indexStatus.song_count || 0 }} 首歌曲</span><span class="chip">{{ state.indexStatus.playlist_count || 0 }} 个歌单</span></div></div>
      <div class="field index-refresh-field"><label class="field-label">最大索引歌曲数</label><div class="index-refresh-row"><SlInput :model-value="maxIndex" type="number" @update:model-value="maxIndex = $event" @change="saveNumber('max_song_index', maxIndex, 1000, 100000)" /><div class="field-actions"><SlButton variant="tonal" class="input-style-btn" label="刷新" icon="refresh" @click="refreshIndex" /></div></div></div>
    </div>
  </SectionCard>
  </div>

  <div v-show="voicePanel === 'commands'" class="voice-panel" data-voice-panel="commands">
  <SectionCard title="语音口令" icon="mic">
    <SettingRow title="启用语音口令" :subtitle="state.config.conversation_monitor_enabled ? '' : '需要先开启对话监听'">
      <SlSwitch aria-label="启用语音口令" :model-value="state.config.voice_command_enabled" :disabled="!state.config.conversation_monitor_enabled" @update:model-value="setVoiceEnabled" />
    </SettingRow>
    <div v-if="!state.config.conversation_monitor_enabled" class="dependency-hint"><SlIcon name="warning" :size="18" /><span>需要先开启"对话监听"才能使用语音口令。</span></div>
    <div class="form-body">
      <button type="button" class="advanced-toggle" @click="voiceCommandsExpanded = !voiceCommandsExpanded">
        <span>{{ voiceCommandsExpanded ? '收起语音口令配置' : '展开语音口令配置' }}</span>
        <SlIcon :name="voiceCommandsExpanded ? 'expand_less' : 'expand_more'" :size="20" />
      </button>
      <div v-if="voiceCommandsExpanded" class="voice-command-list">
        <div v-for="(command, index) in state.voiceCommands" :key="commandKey(command, index)" class="voice-command-group">
          <div class="voice-command-header">
            <SlIcon :name="commandIcons[command.type] || 'label'" :size="20" />
            <strong>{{ commandLabels[command.type] || command.type }}</strong>
            <span v-if="command.param" class="command-param">{{ parameterLabels[command.param] || command.param }}</span>
            <SlSwitch :model-value="command.enabled !== false" :disabled="commandSaving" :aria-label="`启用${commandLabels[command.type] || command.type}`" @update:model-value="setCommandEnabled(index, $event)" />
          </div>
          <div class="command-keywords">
            <span v-for="(keyword, keywordIndex) in keywordsOf(command)" :key="`${keyword}-${keywordIndex}`" class="command-keyword">
              <span>{{ keyword }}</span>
              <button type="button" title="删除口令词" :aria-label="`删除口令词 ${keyword}`" :disabled="commandSaving" @click="removeKeyword(command, index, keywordIndex)"><SlIcon name="close" :size="14" /></button>
            </span>
          </div>
          <div class="command-add-row">
            <SlInput :model-value="commandInputs[commandKey(command, index)] || ''" :input-key="commandInputVersions[commandKey(command, index)] || 0" placeholder="添加口令词" aria-label="添加口令词" @update:model-value="commandInputs[commandKey(command, index)] = $event" @submit="addKeyword(command, index)" />
            <SlButton variant="icon" icon="add" title="添加口令词" :disabled="commandSaving" @click="addKeyword(command, index)" />
          </div>
        </div>
        <div v-if="!state.voiceCommands.length" class="empty-state">暂无语音口令</div>
        <div class="field-actions"><SlButton variant="filled" block label="恢复默认" icon="restart_alt" :disabled="commandSaving" @click="resetCommands" /></div>
      </div>
      <div v-else class="collapsed-summary">
        <span class="collapsed-hint"><SlIcon name="info" :size="18" /><span>触发后先播完小爱回复再切歌，有短暂延迟。</span></span>
      </div>
    </div>
    <div class="command-test-panel">
      <strong>口令测试</strong>
      <div class="inline-fields command-test-fields"><SlInput v-model="commandTestQuery" placeholder="例如：我今天想听周杰伦的晴天" aria-label="口令测试输入" @submit="testCommand" /><SlButton variant="tonal" class="input-style-btn command-test-btn" label="测试" icon="play_arrow" :disabled="commandTestBusy || !state.currentDeviceId" @click="testCommand" /></div>
      <pre v-if="commandTestResult" class="result-pre" :class="commandTestSuccess ? 'result-success' : 'result-error'">{{ commandTestResult }}</pre>
    </div>
  </SectionCard>
  </div>

  <div v-show="voicePanel === 'memory'" class="voice-panel" data-voice-panel="memory">
  <SectionCard title="语音记忆" icon="memory">
    <SettingRow title="启用语音记忆"><SlSwitch aria-label="启用语音记忆" :model-value="state.config.voice_memory_enabled" @update:model-value="setSwitch('voice_memory_enabled', $event)" /></SettingRow>
    <div class="form-body">
      <button type="button" class="advanced-toggle" @click="toggleMemoryExpanded">
        <span>{{ memoryExpanded ? '收起语音记忆' : '展开语音记忆' }}</span>
        <SlIcon :name="memoryExpanded ? 'expand_less' : 'expand_more'" :size="20" />
      </button>
      <div v-if="memoryExpanded" class="sub-panel memory-list">
        <div class="field memory-limit-field"><label class="field-label">记忆上限(10-5000)</label><div class="memory-limit-row"><SlInput :model-value="maxMemory" type="number" @update:model-value="maxMemory = $event" @change="saveNumber('voice_memory_max_records', maxMemory, 10, 5000)" /><div class="field-actions"><SlButton variant="tonal" class="input-style-btn" label="刷新" icon="refresh" @click="ensureMemoryLoaded(true)" /><SlButton variant="tonal" class="input-style-btn" label="清空" icon="delete_sweep" @click="clearMemory" /></div></div></div>
        <div class="status-chips"><span class="chip">已保存 {{ state.memoryStats.recordCount || state.memoryStats.queryCount || 0 }} 条</span><span class="chip">已学习 {{ state.memoryStats.entityCount || 0 }} 首</span><span class="chip">本地命中 {{ state.memoryStats.localHitCount || state.memoryStats.hitCount || 0 }} 次</span></div>
        <div class="memory-list-body">
          <div v-for="entity in state.memoryEntities" :key="String(entity.canonicalKey || entity.canonical_key)" class="memory-entity">
            <div class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ entity.songName || '未命名歌曲' }}{{ entity.artist ? ` · ${entity.artist}` : '' }}</strong><span class="list-item-subtitle">{{ memoryAliases(entity).length }} 种说法</span></div><SlButton variant="icon" :icon="expandedMemory === String(entity.canonicalKey || entity.canonical_key) ? 'expand_less' : 'expand_more'" title="展开记忆" @click="expandedMemory = expandedMemory === String(entity.canonicalKey || entity.canonical_key) ? null : String(entity.canonicalKey || entity.canonical_key)" /><SlButton variant="icon" icon="delete" title="删除歌曲记忆" @click="deleteMemoryEntity(String(entity.canonicalKey || entity.canonical_key), entity.songName || '歌曲')" /></div>
            <div v-if="expandedMemory === String(entity.canonicalKey || entity.canonical_key)" class="memory-aliases">
              <div v-for="(alias, index) in memoryAliases(entity)" :key="alias.id || index" class="memory-alias-row"><span>{{ alias.query || alias.alias || '未命名说法' }}</span><SlButton v-if="alias.id" variant="icon" icon="close" title="删除这条记忆" @click="deleteMemoryRecord(alias.id)" /></div>
            </div>
          </div>
          <div v-if="!state.memoryEntities.length" class="empty-state">暂无可聚合的歌曲记忆</div>
          <div v-if="state.memoryUnclassified.length" class="field-help">未归类记忆 {{ state.memoryUnclassified.length }} 条</div>
          <div v-if="state.memoryAmbiguous.length" class="field-help">最近歧义 {{ state.memoryAmbiguous.length }} 条</div>
        </div>
      </div>
      <div v-else class="collapsed-summary">
        <span class="chip">记忆数据按需加载</span>
      </div>
    </div>
  </SectionCard>
  </div>

  <div v-show="voicePanel === 'intelligence'" class="voice-panel" data-voice-panel="intelligence">
  <SectionCard title="飞牛音乐搜索" icon="search">
    <SettingRow title="音乐库搜索"><SlSwitch aria-label="音乐库搜索" :model-value="state.config.fnmusic_local_search_enabled" @update:model-value="setSwitch('fnmusic_local_search_enabled', $event)" /></SettingRow>
    <SettingRow title="联网搜索"><SlSwitch aria-label="联网搜索" :model-value="state.config.fnmusic_online_search_enabled" @update:model-value="setSwitch('fnmusic_online_search_enabled', $event)" /></SettingRow>
  </SectionCard>

  </div>
</template>
