import type { ConfigManager } from '../config/manager';
import type { MinaService } from '../service/service';
import { hasLostDeviceMedia, isDeviceIdle, isDeviceStatusKnown } from './device_state';

interface SmartResumeTask {
  accountId: string;
  deviceId: string;
  revision: number;
  startedAt: number;
  position: number;
}

const SMART_RESUME_INITIAL_DELAY_MS = 1000;
const SMART_RESUME_FAST_INTERVAL_MS = 1000;
const SMART_RESUME_FAST_QUERIES = 4;
const SMART_RESUME_NORMAL_INTERVAL_MS = 5000;

export class VoiceResumeCoordinator {
  private tasks = new Map<string, { task: SmartResumeTask; timer: ReturnType<typeof setTimeout> | null }>();
  constructor(private configManager: ConfigManager, private minaService: MinaService, private enabled: () => boolean) { }
  /** 取消待执行的语音恢复操作。 */
  cancel(accountId?: string, deviceId?: string): void {
    for (const [key, entry] of this.tasks) {
      if (accountId && entry.task.accountId !== accountId) continue;
      if (deviceId && entry.task.deviceId !== deviceId) continue;
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.tasks.delete(key);
    }
  }

  /**
   * 给小爱一秒启动播报，短窗口内读取新状态；旧任务在每次异步返回后核对身份。
   */
  schedule(pm: import('../player/manager').PlaylistManager, accountId: string, deviceId: string): void {
    this.cancel(accountId, deviceId);
    const task: SmartResumeTask = {
      accountId, deviceId,
      revision: pm.getPlaybackRevision(),
      startedAt: Date.now(),
      position: pm.getPosition(),
    };
    const key = JSON.stringify([accountId, deviceId]);
    const entry = { task, timer: null as ReturnType<typeof setTimeout> | null };
    entry.timer = setTimeout(() => {
      // 旧宿主立即复用到期句柄；取消任务时不能再清理它（#481/#514）。
      entry.timer = null;
      void this.smartResume(pm, task).catch(e => {
        songloft.log.warn('[VoiceEngine] Smart resume failed: ' + String(e));
      });
    }, SMART_RESUME_INITIAL_DELAY_MS);
    this.tasks.set(key, entry);
  }

  /**
   * 等待小爱 TTS 播报结束后重新推送当前歌曲 URL
   */
  private async smartResume(pm: import('../player/manager').PlaylistManager, task: SmartResumeTask): Promise<void> {
    const isTaskCurrent = () => this.enabled() && this.tasks.get(JSON.stringify([task.accountId, task.deviceId]))?.task === task;
    const isCurrent = () => isTaskCurrent() && pm.isPlaying() && pm.getPlaybackRevision() === task.revision;
    if (!isCurrent()) return;
    const config = await this.configManager.getConfig();
    if (!isCurrent()) return;
    const timeoutSec = Math.max(5, Math.min(120, config.smart_resume_timeout ?? 30));
    const maxWaitMs = timeoutSec * 1000;
    let deviceBecameIdle = false;
    let mediaContextLost = false;
    let deviceTakenOver = false;
    let deviceRestarted = false;
    let resumePosition = task.position;
    let fastQueries = 0;
    let idleConfirmationQueries = 0;
    let idleHits = 0;
    let lastPosition = -1;
    let lastSampleAt = -1;
    let lastStatus = -1;
    let progressStalled = false;
    let deviceReportsProgress = false;
    let playingWithoutPosition = false;

    while (Date.now() - task.startedAt < maxWaitMs) {
      if (!isCurrent()) return;
      // 快速窗口耗尽后，首次发现 idle 仍可加一次确认，避免已说完又等五秒。
      const confirmIdle = idleHits === 1 && idleConfirmationQueries < 1;
      const fast = fastQueries < SMART_RESUME_FAST_QUERIES || confirmIdle;
      if (fastQueries < SMART_RESUME_FAST_QUERIES) fastQueries++;
      else if (confirmIdle) idleConfirmationQueries++;
      const st = await this.minaService.getPlayState(task.accountId, task.deviceId, fast ? { verify: true } : {});
      if (!isCurrent()) return;
      const sampleAt = st.sampledAt ?? Date.now();
      if (st.status < 0) {
        // 查询失败不是「播报结束」。停止快速回读，遵守 Mina 的失败退避。
        fastQueries = SMART_RESUME_FAST_QUERIES;
        idleHits = 0;
        lastPosition = -1;
        lastStatus = -1;
        progressStalled = false;
        playingWithoutPosition = false;
      } else if (sampleAt >= task.startedAt && sampleAt > lastSampleAt) {
        lastSampleAt = sampleAt;
        lastStatus = st.status;
        playingWithoutPosition = st.status === 1 && st.hasPosition === false;
        if (st.hasPosition && Number.isFinite(st.position) && st.position >= 0) deviceReportsProgress = true;
        const stream = pm.matchResumeDeviceStream({ ...st, status: 1 });
        const positionRegressed = st.hasPosition && pm.hasDevicePositionRegressed(st.position, resumePosition);
        // 某些固件在实际播放时连续误报 paused/stopped；进度推进时只校准，不再发 play（#449）。
        if (isDeviceStatusKnown(st.status) && stream !== 'foreign' && st.hasPosition) {
          if (lastPosition >= 0 && st.position - lastPosition + 1e-6 >= 0.1) {
            if (stream === 'ours' && (pm.isDeviceAtRestartPosition(st.position, resumePosition) ||
              pm.isDeviceAtRestartPosition(lastPosition, resumePosition))) {
              deviceRestarted = true;
              songloft.log.warn(`[VoiceEngine] Device restarted media after voice interaction: position=${st.position}s resumePosition=${resumePosition}s`);
              break;
            }
            if (!positionRegressed || stream === 'ours') {
              songloft.log.info('[VoiceEngine] Device auto-resumed, progress confirmed; resetting timer only');
              pm.resetAutoNextTimer(st.position * pm.getPlaybackSpeed() + pm.getStreamSeekOffsetSec());
              return;
            }
          }
          // 身份不明且位置回退不能证明重播，也不能据此把插件进度同步到开头。
          progressStalled = lastPosition >= 0 && st.position >= lastPosition &&
            (!positionRegressed || stream === 'ours');
          lastPosition = st.position;
        } else {
          lastPosition = -1;
          progressStalled = false;
        }
        // L15A 直链模式在媒体被语音打断后返回 status=3，不能当作仍在播放或查询失败。
        if (isDeviceIdle(st.status)) {
          idleHits++;
          progressStalled = false;
          if (st.hasPosition && stream === 'ours') {
            // 固件在暂停/停止后可能把位置清零；保留打断锚点，仅接受更靠后的同曲位置。
            resumePosition = Math.max(resumePosition, st.position * pm.getPlaybackSpeed() + pm.getStreamSeekOffsetSec());
          }
          // 两次新采样确认，给延迟启动的播报留出窗口，缓存不能累积命中。
          if (idleHits >= 2) {
            deviceBecameIdle = true;
            mediaContextLost = hasLostDeviceMedia(st);
            break;
          }
        } else if (st.status === 1) {
          idleHits = 0;
          if (stream === 'foreign') {
            // 外来媒体可能就是正在播报的小爱回答，先等结束，不能立刻重推打断。
            deviceTakenOver = true;
            lastPosition = -1;
            progressStalled = false;
          }
        } else {
          idleHits = 0;
          lastPosition = -1;
          lastStatus = -1;
          progressStalled = false;
        }
      } else {
        // 旧的成功状态不能授权超时后重推；无进度兜底必须有本轮新的状态证据。
        playingWithoutPosition = false;
      }
      const remainingMs = maxWaitMs - (Date.now() - task.startedAt);
      if (remainingMs <= 0) break;
      const interval = fastQueries < SMART_RESUME_FAST_QUERIES || (idleHits === 1 && idleConfirmationQueries < 1)
        ? SMART_RESUME_FAST_INTERVAL_MS : SMART_RESUME_NORMAL_INTERVAL_MS;
      await new Promise(r => setTimeout(r, Math.min(interval, remainingMs)));
    }

    if (!isCurrent()) return;
    if (!deviceBecameIdle && !deviceRestarted &&
      (lastStatus < 0 || (!deviceTakenOver && !progressStalled && !playingWithoutPosition))) {
      // 查询失败、旧采样不能证明播报结束，保留原来的计时兜底。成功返回状态但不支持位置的设备，
      // 等配置的播报窗口后重推保存位置；不能只恢复计时器并让音箱无声到下一首（#481）。
      songloft.log.warn('[VoiceEngine] Smart resume timed out without playback evidence; restoring timer only');
      // 保存锚点可能只有本地外推位置，不能把它当作设备真实上报的进度（#124）。
      pm.resetAutoNextTimer(resumePosition, deviceReportsProgress);
      return;
    }

    if (playingWithoutPosition && !deviceBecameIdle) {
      songloft.log.warn('[VoiceEngine] Speech timeout with status-only playback; replaying saved position');
    }

    if (deviceBecameIdle && !deviceTakenOver && !mediaContextLost) {
      const resumed = await pm.resumePlayback({ positionSec: resumePosition, isCurrent: isTaskCurrent });
      if (resumed) {
        songloft.log.info('[VoiceEngine] Resume command sent after voice interaction; verification pending');
        return;
      }
      if (!isCurrent()) return;
    }

    // 被接管或超时仍无进度：带挂起时的位置重推，不把整个播报等待时间算成已听内容。
    // 失败推送自身只停一次定时器；版本再变化说明已有新操作，不能替它收尾。
    const replayRevision = pm.getPlaybackRevision() + 1;
    const replayPosition = pm.getSafeResumePosition(resumePosition);
    const ok = await pm.replayCurrent(replayPosition, isTaskCurrent);
    if (ok) {
      songloft.log.info(`[VoiceEngine] Playback restored via replay after voice interaction seek=${replayPosition.toFixed(1)}s`);
    } else if (isTaskCurrent() && pm.getPlaybackRevision() === replayRevision && pm.isPlaying() && pm.isVoiceSuspended()) {
      songloft.log.warn('[VoiceEngine] Failed to restore playback after voice interaction');
      await pm.stop(false);
    }
  }

}
