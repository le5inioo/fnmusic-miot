import type { MinaService } from '../service/service';
import type { InteractionToken } from '../playback/coordinator';
export type SpeechResult = 'completed' | 'failed' | 'cancelled' | 'unknown';
/** 等待提示的最短可闻窗口，从下发时刻起算。 */
const ACKNOWLEDGE_PROTECTION_MS = 3000;
/**
 * TTS 分段。
 *
 * 关键约束（2.3.12）：MiIO TTS 命令通道（siid=7/aiid=3）对超长文本会静默失败——
 * 协议层仍返回 code=0，但设备端不播。实测 152/183 字（约 450+/500+ UTF-8 字节）
 * 不出声，而 73 字（约 220 字节）正常。故单段上限设为 60 字（约 180 字节），
 * 远低于设备限制，并在句末标点处切分，保证每段都能真正播出。
 */
const TTS_SEGMENT_MAX_CHARS = 60;
export function speechSegments(answer: string): string[] {
  let text = answer.replace(/```[\s\S]*?```/g, '（代码请查看对话记录）').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '（链接请查看对话记录）').replace(/[*#`_>]/g, '').trim();
  if (text.length > 1200)
    text = text.slice(0, 1160) + '。完整回答请查看对话记录。';
  const chunks: string[] = [];
  while (text) {
    let end = Math.min(TTS_SEGMENT_MAX_CHARS, text.length);
    if (text.length > TTS_SEGMENT_MAX_CHARS) {
      const piece = text.slice(0, TTS_SEGMENT_MAX_CHARS);
      // 在靠后的句末标点/换行处切，避免断句；找不到就用硬上限。
      const boundary = Math.max(piece.lastIndexOf('。'), piece.lastIndexOf('！'), piece.lastIndexOf('？'), piece.lastIndexOf('；'), piece.lastIndexOf('\n'));
      if (boundary >= 20)
        end = boundary + 1;
    }
    chunks.push(text.slice(0, end));
    text = text.slice(end).trim();
  }
  return chunks;
}
export class SpeechService {
  constructor(private devices: MinaService) { }
  async acknowledge(token: InteractionToken, current = token.isCurrent): Promise<void> {
    if (!current())
      return;
    const started = Date.now();
    try {
      const accepted = await this.devices.textToSpeech(token.account, token.device, '收到，正在思考。', current);
      if (accepted !== false && current()) {
        // 短提示仅保留启动保护；最终回答仍须新采样确认结束才能恢复音乐。
        // 窗口从下发时刻起算：云端往返这一两秒提示音已在播，不该再整段叠加（#119）。
        const remaining = ACKNOWLEDGE_PROTECTION_MS - (Date.now() - started);
        if (remaining > 0)
          await new Promise<void>(resolve => setTimeout(resolve, remaining));
      }
      else if (current())
        songloft.log.warn(`[AIChat] task=${token.id} waiting_feedback_failed`);
    }
    catch (error) {
      songloft.log.warn(`[AIChat] task=${token.id} waiting_feedback_failed=${String(error)}`);
    }
  }
  async stop(token: InteractionToken): Promise<void> {
    const result = await this.devices.stopForInteraction(token.account, token.device, token.isCurrent);
    if (token.isCurrent() && result !== 'stopped')
      throw new Error('无法确认回答已停止，保持音乐暂停');
  }
  /**
   * 逐段播报完整回答。
   *
   * 2.3.12 重写收尾判定（根因：MiIO TTS 通道与播放状态通道不互通）：
   * 这台设备的 TTS 走 MiIO 命令通道（siid=7/aiid=3），而 getPlayState 读的是
   * mediaplayer —— 两条通道不通，TTS 播报时 status 一直是 0，程序却按 4 字/秒
   * 死等 protection（183 字≈46 秒）才进下一段，表现为「很久才播下一段」。
   *
   * 新策略：
   * 1. TTS 回执非 false（true / null）即视为已下发——MiIO 命令成功就代表播出，
   *    不再以 getPlayState 是否观察到 playing 作为确认前提。
   * 2. 按字数估算朗读时长作为「保守兜底等待」，但用本地时钟计，取一个贴合真语速的
   *    值（约 5 字/秒 + 1 秒缓冲），不再叠加固定 60 秒冗余；单段上限 60 字后，
   *    每段兜底也就十几秒。
   * 3. 若 getPlayState 确实观察到本轮 playing 再转空闲，可提前结束（真播完信号），
   *    不必等满估算时长。
   * 4. 任一段收尾都不中止整轮：单段失败/未确认只记录，继续播后续段。
   */
  async speak(answer: string, token: InteractionToken, current = token.isCurrent): Promise<SpeechResult> {
    const segments = speechSegments(answer);
    if (!segments.length)
      return 'failed';
    let confirmedCount = 0, unconfirmedCount = 0;
    for (let index = 0; index < segments.length; index++) {
      const text = segments[index];
      if (!current()) {
        songloft.log.info(`[AIChat] task=${token.id} speech_cancelled_at=${index + 1}/${segments.length}`);
        return 'cancelled';
      }
      const accepted = await this.devices.textToSpeech(token.account, token.device, text, current);
      if (!current()) {
        songloft.log.info(`[AIChat] task=${token.id} speech_cancelled_at=${index + 1}/${segments.length}`);
        return 'cancelled';
      }
      // 只有明确回执 false（全部端点失败）才是真失败；null = 3012 超时、可能已播出，继续收尾。
      if (accepted === false) {
        songloft.log.warn(`[AIChat] task=${token.id} speech_dispatch_failed_at=${index + 1}/${segments.length}`);
        unconfirmedCount++;
        continue;
      }
      const started = Date.now();
      // TTS 已下发，视为播出；等待时长贴合真实朗读语速（约 4 字/秒 + 1 秒缓冲），
      // 既不会因 status 恒 0 而空转死等，也不会早于实际播完就下发下一段造成打断。
      // 单段 ≤60 字，故兜底 ≤13 秒。
      const estimate = Math.max(2000, Math.ceil(text.length / 4) * 1000 + 1000);
      const maxWait = estimate + 15000;
      let observedPlaying = false, confirmed = false;
      let idle = 0, lastTick = started;
      while (Date.now() - started < maxWait) {
        if (!current()) {
          songloft.log.info(`[AIChat] task=${token.id} speech_cancelled_at=${index + 1}/${segments.length}`);
          return 'cancelled';
        }
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        if (!current()) {
          songloft.log.info(`[AIChat] task=${token.id} speech_cancelled_at=${index + 1}/${segments.length}`);
          return 'cancelled';
        }
        // 估算时长到点即确认播出，不再依赖状态信号（MiIO 通道下 status 恒为 0）。
        if (Date.now() - started >= estimate) {
          confirmed = true;
          break;
        }
        const status = await this.devices.getPlayState(token.account, token.device);
        if (!current()) {
          songloft.log.info(`[AIChat] task=${token.id} speech_cancelled_at=${index + 1}/${segments.length}`);
          return 'cancelled';
        }
        const tick = status.sampledAt && status.sampledAt > lastTick ? status.sampledAt : Date.now();
        if (tick <= lastTick)
          continue;
        lastTick = tick;
        if (status.status === 1) {
          observedPlaying = true;
          idle = 0;
          continue;
        }
        // 观察到本轮 playing 后转空闲 = 真播完，提前结束。
        if ((status.status === 0 || status.status === 2) && observedPlaying) {
          idle++;
          if (idle >= 2) {
            confirmed = true;
            break;
          }
        }
      }
      if (confirmed)
        confirmedCount++;
      else
        unconfirmedCount++;
      songloft.log.info(`[AIChat] task=${token.id} speech_segment=${index + 1}/${segments.length} ` +
        `len=${text.length} accepted=${String(accepted)} played=${observedPlaying} ` +
        `confirmed=${confirmed} waited_ms=${Date.now() - started}`);
    }
    songloft.log.info(`[AIChat] task=${token.id} speech_segments_done=${segments.length} confirmed=${confirmedCount} unconfirmed=${unconfirmedCount}`);
    // 任一段确认播出即认为整轮播报成功，恢复音乐；全部未确认才上报 unknown。
    // 任何情况下都不再因单段失败丢弃后续段。
    if (!confirmedCount && unconfirmedCount)
      return 'unknown';
    return 'completed';
  }
}
