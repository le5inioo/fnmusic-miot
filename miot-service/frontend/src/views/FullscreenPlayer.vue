<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import { useSongCover } from '../covers';
import { extractCoverPalette, paletteFromMetadata, paletteStyle } from '../playerPalette';
import PlayerModePopup from './PlayerModePopup.vue';
import PlayerSpeedPopup from './PlayerSpeedPopup.vue';
import PlayerProgress from './PlayerProgress.vue';
import PlayerSleepTimerPopup from './PlayerSleepTimerPopup.vue';
import PlayerVolumePopup from './PlayerVolumePopup.vue';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import { closePage, navigation, notifyHostFavorite } from '../runtime';
import { get, messageOf, post, query } from '../api';
import type { SleepTimerStatus } from '../types';
import { confirmAction, notify, playerCommand, seekPlayer, setPlayMode, setPlaybackSpeed, setVolume, state } from '../store';

interface LyricLine { time: number; text: string }
interface LyricPayload { lyric?: string; tlyric?: string; rlyric?: string; lxlyric?: string }
const lyrics = ref<LyricLine[]>([]);
const lyricLoading = ref(false);
const lyricError = ref('');
let lyricGeneration = 0;
const isFavorite = ref(false);
const favoriteBusy = ref(false);
const sleepTimerBusy = ref(false);
const sleepTimer = ref<SleepTimerStatus>({ active: false, mode: 'time', remaining: 0, total: 0 });
const mobilePager = ref<HTMLElement | null>(null);
const mobilePage = computed(() => navigation.playerPage);
const desktopLyrics = ref<HTMLElement | null>(null);
const mobileLyrics = ref<HTMLElement | null>(null);
const songArtist = computed(() => {
  const song = state.player.current_song;
  return song ? song.artist?.trim() || '未知歌手' : '选择一首歌曲开始播放';
});
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let touchStartPage = 0;
let dragging = false;
let dragAxis: '' | 'x' | 'y' = '';
const dragOffset = ref(0);
// 最近一次翻页的目标页，用来掐断 watch(playerPage) 的回环调用，避免重复发起动画
let pagerTargetPage = 0;
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
// 分页完全由 transform 驱动，绕开原生 scroll/overscroll —— 移动 WebView 的触摸滚动
// 跑在合成器线程，JS 的 scrollTo 压不住进行中的 fling/橡皮筋，边界会卡住不回弹。
// 位移用百分比按页宽计算，窗口尺寸变化时自动适配，无需手动重算。
const mobileTrackStyle = computed<CSSProperties>(() => ({
  transform: `translate3d(calc(${-(navigation.playerPage || 0) * 100}% + ${dragOffset.value}px), 0, 0)`,
  transition: dragging || prefersReducedMotion() ? 'none' : 'transform .3s cubic-bezier(.22,.61,.36,1)',
}));
const activeLyric = computed(() => {
  const position = Number(state.player.position || 0);
  let index = -1;
  lyrics.value.forEach((line, i) => { if (line.time <= position) index = i; });
  return index;
});
// 桌面与移动 stage **同时**在 DOM 里（只靠媒体查询 `display:none` 切换），所以这里
// 刻意开两份、并用不同的 `w=`：
//   ① 尺寸本来就不同（桌面 frame 360px、移动 72vw/max 320px），各取 2x 更合理；
//   ② 更要紧的是别让两个 `<img>` 落到同一个 URL 上 —— 同 URL 的两个 img 共享
//      同一份缓存键，一方的失败/驱逐会连带毙掉另一方，排查也难（#86 的教训）。
const { src: cover, epoch: coverEpoch, onError: onCoverError, onLoad: onCoverLoad } = useSongCover(() => state.player.current_song, 768);
const { src: coverMobile, epoch: coverMobileEpoch, onError: onCoverMobileError, onLoad: onCoverMobileLoad } = useSongCover(() => state.player.current_song, 640);
const backgroundStyle = ref<CSSProperties>({});
let paletteGeneration = 0;

/**
 * 先立即应用歌曲元数据生成的稳定配色，再异步替换成封面提取色。
 * generation 防止快速切歌时较慢的旧封面覆盖当前歌曲背景。
 */
async function refreshBackgroundPalette(): Promise<void> {
  const generation = ++paletteGeneration;
  const song = state.player.current_song;
  const fallback = paletteFromMetadata(song);
  backgroundStyle.value = paletteStyle(fallback);
  if (!song) return;

  const url = cover.value || coverMobile.value;
  if (!url) return;
  const extracted = await extractCoverPalette(url);
  if (generation !== paletteGeneration || state.player.current_song?.id !== song.id) return;
  if (extracted) backgroundStyle.value = paletteStyle(extracted);
}

function parseLrc(text: string): LyricLine[] {
  const output: LyricLine[] = [];
  const plain: string[] = [];
  const wordTimestamp = /\[\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\]/g;
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalized = line.replace(wordTimestamp, '');
    const matches = [...normalized.matchAll(timestamp)];
    const content = normalized
      .replace(timestamp, '')
      .replace(/<\d+,\d+>/g, '')
      .trim();
    if (!content) continue;
    plain.push(content);
    for (const match of matches) {
      const fraction = (match[3] || '').padEnd(3, '0').slice(0, 3);
      output.push({
        time: Number(match[1]) * 60 + Number(match[2]) + Number(fraction || 0) / 1000,
        text: content,
      });
    }
  }
  if (output.length) return output.sort((a, b) => a.time - b.time);
  return plain.map((line) => ({ time: Number.POSITIVE_INFINITY, text: line }));
}

async function loadSongLyrics(songId: number, generation: number, refresh = false): Promise<void> {
  lyricLoading.value = true;
  lyricError.value = '';
  try {
    const result = await get<LyricPayload>(`/lyric?song_id=${songId}${refresh ? '&refresh=1' : ''}`);
    if (generation !== lyricGeneration || state.player.current_song?.id !== songId) return;
    const text = String(result.lyric || result.lxlyric || result.tlyric || result.rlyric || '');
    lyrics.value = parseLrc(text);
  } catch {
    if (generation !== lyricGeneration || state.player.current_song?.id !== songId) return;
    lyricError.value = '歌词获取失败，请重试';
  } finally {
    if (generation === lyricGeneration) lyricLoading.value = false;
  }
}

async function retryLyrics(): Promise<void> {
  const songId = state.player.current_song?.id;
  if (!songId || lyricLoading.value) return;
  await loadSongLyrics(songId, lyricGeneration, true);
}

async function loadSongDetails(): Promise<void> {
  const generation = ++lyricGeneration;
  const songId = state.player.current_song?.id;
  lyrics.value = [];
  lyricError.value = '';
  lyricLoading.value = false;
  isFavorite.value = false;
  if (!songId) return;
  await Promise.allSettled([
    loadSongLyrics(songId, generation),
    get<{ is_favorited: boolean }>(`/player/favorite/status?song_id=${songId}`)
      .then(result => {
        if (generation === lyricGeneration && state.player.current_song?.id === songId) {
          isFavorite.value = result.is_favorited;
        }
      }),
  ]);
}

// 全屏播放器里的"删除当前歌曲"入口。临时歌单（id<0，语音"播放歌手X"生成的一次性队列）
// 不落库，按下删除会没意义——这时按钮不可用。要删的是"当前正播那首"，取自 player.current_song
// 而不是 selectedPlaylistId 对应的列表（用户可能开着另一个歌单在看）。
const currentPlaylistId = computed(() => {
  const id = Number(state.player.playlist_id);
  return Number.isFinite(id) ? id : 0;
});
const canRemoveCurrent = computed(() => currentPlaylistId.value > 0 && !!state.player.current_song);
async function removeCurrentSong(): Promise<void> {
  const song = state.player.current_song;
  const playlistId = currentPlaylistId.value;
  if (!song || playlistId <= 0) return;
  const result = await confirmAction(
    '删除当前歌曲',
    `确定从当前歌单删除《${song.title || '未知歌曲'}》吗？`,
    '删除',
    true,
    { label: '同时从曲库中永久删除歌曲文件', initial: false },
  );
  if (!result.confirmed) return;
  try {
    // removeSongFromPlaylist 读的是 selectedPlaylistId，而全屏播放器里正播的那份
    // 不一定是当前选中的歌单；这里直接调后端并接手错误提示。
    await post('/player/song/remove', {
      playlist_id: playlistId,
      song_id: song.id,
      from_library: result.checked,
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    });
    // 若删的正是当前所选歌单里那首，也要同步筛掉，否则列表还残留一条已消失的歌。
    if (String(playlistId) === state.selectedPlaylistId) {
      state.songs = state.songs.filter((item) => item.id !== song.id);
    }
    notify(result.checked ? '已从歌单和曲库删除' : '已从歌单删除', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}

async function toggleFavorite(): Promise<void> {
  const id = state.player.current_song?.id;
  if (!id || favoriteBusy.value) return;
  const previous = isFavorite.value;
  const next = !previous;
  isFavorite.value = next;
  favoriteBusy.value = true;
  try {
    const result = await post<{ is_favorited: boolean }>('/player/favorite/toggle', {
      song_id: id,
      action: next ? 'add' : 'remove',
    });
    isFavorite.value = result.is_favorited;
    notify(result.is_favorited ? '已收藏' : '已取消收藏', 'success', 1800);
    notifyHostFavorite(id, result.is_favorited);
  } catch (error) {
    isFavorite.value = previous;
    notify(messageOf(error), 'error');
  } finally {
    favoriteBusy.value = false;
  }
}

async function loadSleepTimer(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId) {
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
    return;
  }
  try {
    sleepTimer.value = await get<SleepTimerStatus>(`/voice-commands/sleep-timer${query({
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    })}`);
  } catch {
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
  }
}

async function setSleepTimer(mode: 'time' | 'songs', value: number): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId || sleepTimerBusy.value) return;
  sleepTimerBusy.value = true;
  try {
    sleepTimer.value = await post<SleepTimerStatus>('/voice-commands/sleep-timer', {
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
      mode,
      value,
    });
    navigation.playerPopup = '';
    notify(mode === 'time' ? `将在 ${value} 分钟后停止` : `将在播放 ${value} 首后停止`, 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    sleepTimerBusy.value = false;
  }
}

async function cancelSleepTimer(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId || sleepTimerBusy.value) return;
  sleepTimerBusy.value = true;
  try {
    await post<{ cancelled: boolean }>('/voice-commands/sleep-timer/cancel', {
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    });
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
    navigation.playerPopup = '';
    notify('已取消延迟停止', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    sleepTimerBusy.value = false;
  }
}

function close(): void {
  navigation.playerPopup = '';
  closePage();
}

/**
 * 把分页落到指定页（transform 平滑归位，形成“向左滑入歌词 / 向右滑回封面”的动效）。
 * 归位只发生在明确动作里（touchend / 点指示器 / 分页状态变化）。
 */
function settleMobilePage(index: number): void {
  const target = Math.max(0, Math.min(1, index));
  pagerTargetPage = target;
  navigation.playerPage = target;
  dragOffset.value = 0;
  // dragging=false 会让 transition 生效，transform 从拖动中的位置平滑归位到整页。
  dragging = false;
}

function showMobilePage(index: number): void {
  // settleMobilePage 回写 playerPage 会触发 watch → 再进这里；目标没变就别重启一遍动画。
  if (index === pagerTargetPage) return;
  settleMobilePage(index);
}

function startMobileSwipe(event: TouchEvent): void {
  const touch = event.touches[0];
  if (!touch) return;
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchStartTime = Date.now();
  touchStartPage = navigation.playerPage || 0;
  dragging = true;   // 关掉 transition，进入跟手模式
  dragAxis = '';
  dragOffset.value = 0;
}

function moveMobileSwipe(event: TouchEvent): void {
  if (!dragging) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  if (!dragAxis) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;   // 死区，避免微小抖动误判方向
    dragAxis = Math.abs(dx) >= Math.abs(dy) * 0.7 ? 'x' : 'y';
  }
  if (dragAxis !== 'x') return;   // 纵向手势交给歌词页原生滚动 / 封面页忽略
  // 边界阻尼：到头后跟手位移打折，给出“拉不动”的反馈；松手仍会归位到整页，绝不会卡在越界位置。
  let offset = dx;
  if ((touchStartPage === 0 && dx > 0) || (touchStartPage === 1 && dx < 0)) offset = dx * 0.3;
  dragOffset.value = offset;
}

function finishMobileSwipe(event: TouchEvent): void {
  if (!dragging) return;
  const dx = dragAxis === 'x' ? dragOffset.value : 0;
  const elapsed = Math.max(1, Date.now() - touchStartTime);
  const speed = Math.abs(dx) / elapsed;
  const width = mobilePager.value?.clientWidth || 1;
  // 灵敏判定：位移够页宽的 18%，或一次快速轻扫（≥10px 且够快）就翻页。
  const enoughDistance = Math.abs(dx) >= width * 0.18;
  const quickFlick = Math.abs(dx) >= 10 && speed >= 0.25;
  let target = touchStartPage;
  if (enoughDistance || quickFlick) target += dx < 0 ? 1 : -1;
  settleMobilePage(target);
}

async function centerActiveLyric(): Promise<void> {
  if (navigation.page !== 'player') return;
  await nextTick();
  for (const panel of [desktopLyrics.value, mobileLyrics.value]) {
    if (!panel || panel.clientHeight <= 0) continue;
    const active = panel.querySelector<HTMLElement>('.lyric-line.active');
    if (!active) continue;
    const top = active.offsetTop - panel.clientHeight / 2 + active.offsetHeight / 2;
    try {
      panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch {
      panel.scrollTop = Math.max(0, top);
    }
  }
}

onMounted(() => {
  void loadSongDetails();
  void loadSleepTimer();
});
onUnmounted(() => {
  lyricGeneration += 1;
  paletteGeneration += 1;
});
watch(() => state.player.current_song?.id, loadSongDetails);
watch([() => state.player.current_song?.id, cover, coverMobile], refreshBackgroundPalette, { immediate: true });
watch(() => [state.currentAccountId, state.currentDeviceId], loadSleepTimer);
watch(activeLyric, centerActiveLyric);
watch(() => navigation.playerPage, showMobilePage);
</script>

<template>
  <div class="fullscreen-player page-view" :style="backgroundStyle">
    <div class="fullscreen-ambient" aria-hidden="true">
      <img v-if="cover || coverMobile" class="fullscreen-ambient-cover" :src="cover || coverMobile" alt="" />
      <div class="fullscreen-ambient-tint"></div>
      <div class="fullscreen-ambient-glow"></div>
      <div class="fullscreen-theme-gradient"></div>
    </div>
    <header class="fullscreen-topbar">
      <SlButton variant="icon" icon="keyboard_arrow_down" class="fullscreen-collapse-button" title="收起播放器" @click="close" />
      <span class="fullscreen-topbar-title">正在播放</span>
      <span class="fullscreen-topbar-spacer" aria-hidden="true"></span>
    </header>
    <main class="fullscreen-inner">
      <div class="fullscreen-layout">
        <div class="fullscreen-stage">
          <div class="fullscreen-desktop-stage">
            <section class="fullscreen-cover-column" aria-label="当前歌曲">
              <div class="fullscreen-cover-frame">
                <img v-if="cover" :key="coverEpoch" class="fullscreen-cover" :src="cover" :alt="state.player.current_song?.title || '歌曲封面'" @error="onCoverError" @load="onCoverLoad" />
                <div v-else class="fullscreen-cover player-cover-empty"><SlIcon name="music_note" :size="44" player-icon /></div>
              </div>
              <div class="fullscreen-song-meta fullscreen-song-meta-desktop">
                <span class="fullscreen-song-title">{{ state.player.current_song?.title || '暂无播放' }}</span>
                <span class="fullscreen-song-artist">{{ songArtist }}</span>
                <span v-if="state.player.current_song?.album" class="fullscreen-song-album">{{ state.player.current_song.album }}</span>
              </div>
            </section>
            <section ref="desktopLyrics" class="lyrics fullscreen-lyrics-panel" aria-label="歌词">
              <template v-if="lyrics.length">
                <div v-for="(line, index) in lyrics" :key="`${line.time}-${index}`" class="lyric-line" :class="{ active: index === activeLyric }">{{ line.text }}</div>
              </template>
              <div v-else class="lyrics-empty">
                <span role="status">{{ lyricLoading ? '正在获取歌词…' : lyricError || '暂无歌词，请确认已安装并启用歌词搜索插件' }}</span>
                <SlButton v-if="state.player.current_song" variant="text" label="重新获取歌词" :disabled="lyricLoading" @click="retryLyrics" />
              </div>
            </section>
          </div>

          <div class="fullscreen-mobile-stage">
            <div
              ref="mobilePager"
              class="fullscreen-mobile-pager"
              @touchstart.passive="startMobileSwipe"
              @touchmove.passive="moveMobileSwipe"
              @touchend="finishMobileSwipe"
              @touchcancel="finishMobileSwipe"
            >
              <div class="fullscreen-mobile-track" :style="mobileTrackStyle">
                <section class="fullscreen-mobile-slide fullscreen-cover-slide" aria-label="歌曲封面">
                  <div class="fullscreen-cover-frame">
                    <img v-if="coverMobile" :key="coverMobileEpoch" class="fullscreen-cover" :src="coverMobile" :alt="state.player.current_song?.title || '歌曲封面'" @error="onCoverMobileError" @load="onCoverMobileLoad" />
                    <div v-else class="fullscreen-cover player-cover-empty"><SlIcon name="music_note" :size="44" player-icon /></div>
                  </div>
                </section>
                <section ref="mobileLyrics" class="fullscreen-mobile-slide lyrics fullscreen-lyrics-panel" aria-label="歌词">
                  <template v-if="lyrics.length">
                    <div v-for="(line, index) in lyrics" :key="`${line.time}-${index}`" class="lyric-line" :class="{ active: index === activeLyric }">{{ line.text }}</div>
                  </template>
                  <div v-else class="lyrics-empty">
                    <span role="status">{{ lyricLoading ? '正在获取歌词…' : lyricError || '暂无歌词，请确认已安装并启用歌词搜索插件' }}</span>
                    <SlButton v-if="state.player.current_song" variant="text" label="重新获取歌词" :disabled="lyricLoading" @click="retryLyrics" />
                  </div>
                </section>
              </div>
            </div>
            <div class="fullscreen-page-indicator" aria-label="播放器页面">
              <button type="button" :class="{ active: mobilePage === 0 }" aria-label="显示封面" @click="showMobilePage(0)"></button>
              <button type="button" :class="{ active: mobilePage === 1 }" aria-label="显示歌词" @click="showMobilePage(1)"></button>
              <span class="fullscreen-swipe-hint">{{ mobilePage === 0 ? '左滑看歌词' : '右滑看封面' }}</span>
            </div>
          </div>
        </div>

        <div class="fullscreen-playback">
          <div class="fullscreen-song-meta fullscreen-song-meta-mobile">
            <span class="fullscreen-song-title">{{ state.player.current_song?.title || '暂无播放' }}</span>
            <span class="fullscreen-song-artist">{{ songArtist }}</span>
          </div>
          <PlayerProgress
            :position="Number(state.player.position || 0)"
            :duration="Number(state.player.duration || 0)"
            :disabled="state.playerBusy"
            @seek="seekPlayer"
          />

          <div class="fullscreen-controls fullscreen-controls-desktop">
            <SlButton variant="icon" icon="skip_previous" player-icon :icon-size="26" class="player-control-button" title="上一首" :disabled="state.playerBusy" @click="playerCommand('/player/previous')" />
            <SlButton
              class="control-primary"
              variant="filled"
              player-icon
              :icon-size="32"
              :icon="state.player.is_playing ? 'pause' : 'play_arrow'"
              :title="state.player.is_playing ? '暂停' : '播放'"
              :disabled="state.playerBusy"
              @click="playerCommand('/player/toggle')"
            />
            <SlButton variant="icon" icon="skip_next" player-icon :icon-size="26" class="player-control-button" title="下一首" :disabled="state.playerBusy" @click="playerCommand('/player/next')" />
          </div>

          <div class="fullscreen-controls fullscreen-controls-mobile">
            <PlayerModePopup
              :model-value="state.player.play_mode || 'order'"
              popup-id="full-mode"
              :disabled="state.playerBusy"
              @change="setPlayMode"
            />
            <SlButton variant="icon" icon="skip_previous" player-icon :icon-size="38" class="player-control-button" title="上一首" :disabled="state.playerBusy" @click="playerCommand('/player/previous')" />
            <SlButton
              class="control-primary"
              variant="filled"
              player-icon
              :icon-size="46"
              :icon="state.player.is_playing ? 'pause' : 'play_arrow'"
              :title="state.player.is_playing ? '暂停' : '播放'"
              :disabled="state.playerBusy"
              @click="playerCommand('/player/toggle')"
            />
            <SlButton variant="icon" icon="skip_next" player-icon :icon-size="38" class="player-control-button" title="下一首" :disabled="state.playerBusy" @click="playerCommand('/player/next')" />
            <SlButton
              class="player-favorite-button"
              variant="icon"
              player-icon
              :icon="isFavorite ? 'favorite' : 'favorite_border'"
              :title="isFavorite ? '取消收藏' : '收藏'"
              :class="{ 'player-control-active': isFavorite }"
              :disabled="favoriteBusy || !state.player.current_song"
              @click="toggleFavorite"
            />
          </div>

          <div class="fullscreen-tools">
            <SlButton
              class="fullscreen-tool-desktop player-favorite-button"
              variant="icon"
              player-icon
              :icon="isFavorite ? 'favorite' : 'favorite_border'"
              :title="isFavorite ? '取消收藏' : '收藏'"
              :class="{ 'player-control-active': isFavorite }"
              :disabled="favoriteBusy || !state.player.current_song"
              @click="toggleFavorite"
            />
            <PlayerModePopup
              class="fullscreen-tool-desktop"
              :model-value="state.player.play_mode || 'order'"
              popup-id="full-mode-desktop"
              :disabled="state.playerBusy"
              @change="setPlayMode"
            />
            <PlayerSpeedPopup
              :model-value="Number(state.player.speed || 1)"
              popup-id="full-speed"
              :disabled="state.playerBusy"
              @change="setPlaybackSpeed"
            />
            <PlayerVolumePopup
              :model-value="Number(state.player.volume || 0)"
              popup-id="full-volume"
              :disabled="state.playerBusy"
              @change="setVolume"
            />
            <PlayerSleepTimerPopup
              :status="sleepTimer"
              popup-id="full-sleep-timer"
              :disabled="!state.currentAccountId || !state.currentDeviceId"
              :busy="sleepTimerBusy"
              :is-live="!!state.player.current_song?.is_live"
              @refresh="loadSleepTimer"
              @set="setSleepTimer"
              @cancel="cancelSleepTimer"
            />
            <!-- 唯独这个按钮不带 player-icon：material-icons-player.otf 是子集字体，
                 只含播放器语义图标（play/pause/skip/volume/…），不含 delete 字形；
                 强行用会 fallback 成字面文本渲染不出图标。走 Miot UI Icons 的 delete
                 (0xE92E)，与 SongRow 的删除按钮字形一致。 -->
            <SlButton variant="icon" icon="delete" class="player-tool-button player-tool-danger" title="从歌单删除" :disabled="!canRemoveCurrent" @click="removeCurrentSong" />
            <SlButton variant="icon" icon="stop" player-icon class="player-tool-button player-tool-stop" title="停止播放" :disabled="state.playerBusy" @click="playerCommand('/player/stop')" />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
