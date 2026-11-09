import type { MinaService } from '../service/service';
import type { InteractionToken } from '../playback/coordinator';
export type SpeechResult = 'completed' | 'failed' | 'cancelled' | 'unknown';
/** 等待提示的最短可闻窗口，从下发时刻起算。 */
const ACKNOWLEDGE_PROTECTION_MS = 3000;
export function speechSegments(answer: string): string[] {
  let text = answer.replace(/```[\s\S]*?```/g, '（代码请查看对话记录）').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '（链接请查看对话记录）').replace(/[*#`_>]/g, '').trim();
  if (text.length > 1200)
    text = text.slice(0, 1160) + '。完整回答请查看对话记录。';
  const chunks: string[] = [];
  while (text) {
    let end = Math.min(200, text.length);
    if (text.length > 200) {
      const piece = text.slice(0, 200);
      const boundary = Math.max(piece.lastIndexOf('。'), piece.lastIndexOf('！'), piece.lastIndexOf('？'), piece.lastIndexOf('\n'));
      if (boundary >= 50)
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
  async speak(answer: string, token: InteractionToken, current = token.isCurrent): Promise<SpeechResult> {
    const segments = speechSegments(answer);
    if (!segments.length)
      return 'failed';
    for (const text of segments) {
      if (!current())
        return 'cancelled';
      const accepted = await this.devices.textToSpeech(token.account, token.device, text, current);
      if (!current())
        return 'cancelled';
      if (accepted === false)
        return 'failed';
      const started = Date.now();
      const protection = Math.max(3000, text.length / 4 * 1000);
      let idle = 0, sample = started;
      let observedPlaying = false;
      while (Date.now() - started < 90000) {
        if (!current())
          return 'cancelled';
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        if (!current())
          return 'cancelled';
        const status = await this.devices.getPlayState(token.account, token.device);
        if (!current())
          return 'cancelled';
        if (status.sampledAt && status.sampledAt > sample) {
          sample = status.sampledAt;
          if (status.status === 1)
            observedPlaying = true;
          if (Date.now() - started < protection)
            continue;
          // 超时回执后的 idle 也可能表示根本未起播，须先观察到本轮的新 playing。
          idle = (accepted === true || observedPlaying) && (status.status === 0 || status.status === 2) ? idle + 1 : 0;
          if (idle >= 2)
            break;
        }
      }
      if (idle < 2)
        return 'unknown';
    }
    return 'completed';
  }
}
