<script setup lang="ts">
import { computed, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import SlDisclosure from '../../ui/SlDisclosure.vue';
import { messageOf, notify, saveConfig, state } from '../../store';
import { post } from '../../api';
import type { SelectOption } from '../../types';

const transition = ref(String(state.config.song_transition_offset));
const announcementDelay = ref(String(state.config.play_announcement_delay));
const clearingFailures = ref(false);

async function clearPlaybackFailures() {
  if (clearingFailures.value) return;
  clearingFailures.value = true;
  try {
    const { cleared } = await post<{ cleared: number }>('/player/failures/clear');
    notify(cleared > 0 ? `已清除 ${cleared} 条播放失败标记，可重新播放` : '没有需要清除的播放失败标记', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    clearingFailures.value = false;
  }
}
const coverOptions: Array<SelectOption & { image: string }> = [
  { value: '1674532961410650324', label: 'LOFT·海隅', image: 'https://p1.music.126.net/_zoAgg0syiZnUDov2H7Drw==/109951162812527373.jpg' },
  { value: '3032977774822294038', label: '仲夏涟漪', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000P52RF0ePrMh_1.jpg' },
  { value: '2821554561643067278', label: '所念皆星河', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003mtKhW0DFTMt_3.jpg' },
  { value: '703059981413384476', label: '月夜', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000002OGzkK12zb2D_1.jpg' },
  { value: '2182123779048604035', label: '橘子海', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000001wIZl83iCjqo_1.jpg' },
];
const coverSelectOptions = computed(() => coverOptions.map(({ value, label }) => ({ value, label })));
const coverPreview = computed(() => coverOptions.find((option) => option.value === String(state.config.default_cover_id))?.image || coverOptions[0].image);

async function saveNumber(key: 'song_transition_offset' | 'play_announcement_delay' | 'smart_resume_timeout' | 'conversation_poll_interval' | 'max_song_index' | 'external_search_timeout' | 'voice_memory_max_records', raw: string, min: number, max: number) {
  const parsed = Number.parseInt(raw, 10);
  const value = Math.max(min, Math.min(max, Number.isNaN(parsed) ? min : parsed));
  if (key === 'song_transition_offset') transition.value = String(value);
  if (key === 'play_announcement_delay') announcementDelay.value = String(value);
  try { await saveConfig({ [key]: value }); } catch (error) { notify(messageOf(error), 'error'); }
}
function setSwitch(key: keyof typeof state.config, value: boolean) { void saveConfig({ [key]: value } as never); }
</script>

<template>
  <SectionCard title="音频格式" icon="audio_file">
    <SettingRow title="统一转为 MP3"><SlSwitch aria-label="统一转为 MP3" :model-value="state.config.force_mp3" @update:model-value="setSwitch('force_mp3', $event)" /></SettingRow>
    <SettingRow title="电台转为 MP3"><SlSwitch aria-label="电台转为 MP3" :model-value="state.config.radio_force_mp3" @update:model-value="setSwitch('radio_force_mp3', $event)" /></SettingRow>
    <SettingRow title="统一歌曲音量"><SlSwitch aria-label="统一歌曲音量" :model-value="state.config.volume_normalize" @update:model-value="setSwitch('volume_normalize', $event)" /></SettingRow>
  </SectionCard>

  <SectionCard title="切歌过渡" icon="swap_horiz">
    <div class="form-body"><SlInput v-model="transition" type="number" aria-label="切歌偏移秒数" @change="saveNumber('song_transition_offset', transition, -30, 30)" /><p class="field-help">负数提前、正数延后，0 自然播完（-30~30s）。</p></div>
  </SectionCard>

  <SectionCard title="播放恢复" icon="refresh">
    <SettingRow title="整点报时后续播">
      <SlSwitch aria-label="整点报时后续播" :model-value="state.config.hourly_chime_resume_enabled" @update:model-value="setSwitch('hourly_chime_resume_enabled', $event)" />
      <SlButton variant="icon" class="clear-failures-btn" icon="refresh" :icon-size="18" title="清除播放失败标记" :disabled="clearingFailures" @click="clearPlaybackFailures" />
    </SettingRow>
  </SectionCard>

  <SectionCard title="触屏歌词与封面" icon="lyrics">
    <SettingRow title="触屏音箱显示歌词"><SlSwitch aria-label="触屏音箱显示歌词" :model-value="state.config.touchscreen_lyrics_enabled" @update:model-value="setSwitch('touchscreen_lyrics_enabled', $event)" /></SettingRow>
    <div v-if="state.config.touchscreen_lyrics_enabled" class="dependency-hint"><SlIcon name="info" :size="18" /><span>逐首匹配云端曲库，冷门或自制歌曲可能匹配不到，时间轴也可能不同步。</span></div>
    <div class="form-body"><div class="field"><label class="field-label">封面缺失兜底图</label><div class="inline-fields"><SlSelect :model-value="String(state.config.default_cover_id || coverOptions[0].value)" :options="coverSelectOptions" aria-label="封面缺失兜底图" searchable search-placeholder="搜索封面" @update:model-value="saveConfig({ default_cover_id: $event })" /><img :src="coverPreview" alt="封面缺失兜底图预览" style="width:56px;height:56px;object-fit:cover;border-radius:8px" /></div></div></div>
  </SectionCard>

  <SlDisclosure title="高级语音衔接" icon="record_voice_over">
    <SettingRow title="语音搜索先播报提示文字"><SlSwitch aria-label="语音搜索先播报提示文字" :model-value="state.config.interrupt_tts_hint_enabled" @update:model-value="setSwitch('interrupt_tts_hint_enabled', $event)" /></SettingRow>
    <div v-if="state.config.interrupt_tts_hint_enabled" class="form-body"><div class="field"><label class="field-label">提示文字</label><SlInput :model-value="state.config.interrupt_tts_hint_text" aria-label="搜索提示文字" @update:model-value="state.config.interrupt_tts_hint_text = $event" @change="saveConfig({ interrupt_tts_hint_text: state.config.interrupt_tts_hint_text })" /></div></div>
    <SettingRow title="播放前播报歌曲名称"><SlSwitch aria-label="播放前播报歌曲名称" :model-value="state.config.play_announcement_enabled" @update:model-value="setSwitch('play_announcement_enabled', $event)" /></SettingRow>
    <div v-if="state.config.play_announcement_enabled" class="form-body"><div class="field"><label class="field-label">触发范围</label><SlSelect :model-value="state.config.play_announcement_scope || 'voice'" :options="[{ value: 'voice', label: '仅语音口令' }, { value: 'all', label: '语音口令 + 网页操作' }]" aria-label="播放公告触发范围" @update:model-value="state.config.play_announcement_scope = $event; saveConfig({ play_announcement_scope: $event })" /><p class="field-help">选择哪些操作会触发播放公告。</p></div><div class="field"><label class="field-label">公告模板</label><SlInput :model-value="state.config.play_announcement_template" aria-label="播放公告模板" @update:model-value="state.config.play_announcement_template = $event" @change="saveConfig({ play_announcement_template: state.config.play_announcement_template })" /><p class="field-help">可用占位符：{artist}、{song}。</p></div><div class="field"><label class="field-label">公告等待时间（秒）</label><SlInput :model-value="announcementDelay" type="number" aria-label="公告等待时间" @update:model-value="announcementDelay = $event" @change="saveNumber('play_announcement_delay', announcementDelay, 0, 30)" /></div></div>
  </SlDisclosure>
</template>
