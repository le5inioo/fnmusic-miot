import type { ConversationMessage } from '../types';
import type { ConfigManager } from '../config/manager';
import type { MusicCommandService } from '../music/service';
import type { AIChatService } from '../chat/service';
import type { PlaybackCoordinator } from '../playback/coordinator';
import { DEFAULT_CHAT_CONFIG, chatScope } from '../chat/types';
import { conversationQuery } from '../conversation/query';
import { canFallbackToChat, classifyVoiceIntent } from './intent';
/** 监听只提交任务；每设备最新消息使旧分析失效。 */
export class VoiceDispatcher {
  private versions = new Map<string, number>();
  private seen = new Map<string, number>();
  private closed = false;
  constructor(private config: ConfigManager, private music: MusicCommandService, private chat: AIChatService, private playback: PlaybackCoordinator) {
    playback.setOnDeviceControl?.((account, device) => this.invalidateDevice(account, device));
  }
  invalidateDevice(account: string, device: string): void {
    for (const [scope, version] of this.versions) {
      const [a, d] = JSON.parse(scope);
      if (this.playback.sameScope?.(a, d, account, device) || a === account && d === device)
        this.versions.set(scope, version + 1);
    }
    this.music.cancelPendingResume(account, device);
  }
  submit(message: ConversationMessage): void {
    if (this.closed)
      return;
    const text = conversationQuery(message);
    if (!text)
      return;
    const scope = chatScope(message.account_id, message.device_id);
    const id = `${scope}:${message.message.request_id || `${message.message.timestamp_ms}:${text}`}`;
    if (this.seen.has(id))
      return;
    this.seen.set(id, Date.now());
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.keys().next().value!);
    this.invalidateDevice(message.account_id, message.device_id);
    const version = (this.versions.get(scope) || 0) + 1;
    this.versions.set(scope, version);
    this.music.cancelPendingResume(message.account_id, message.device_id);
    const current = () => !this.closed && this.versions.get(scope) === version;
    void this.dispatch(message, text, current).catch(error => songloft.log.warn(`[VoiceDispatcher] failed=${String(error)}`));
  }
  private async dispatch(message: ConversationMessage, text: string, current: () => boolean): Promise<void> {
    const account = message.account_id, device = message.device_id;
    const config = await this.config.getChatConfig().catch(error => {
      songloft.log.warn(`[VoiceDispatcher] chat_config_failed=${String(error)}`);
      return DEFAULT_CHAT_CONFIG;
    });
    if (!current())
      return;
    const intent = classifyVoiceIntent(message, text);
    // 设备控制类口令已由小爱 / 米家原生执行并答复，不能再让自定义 LLM 抢答一次。
    // 旧配置没有这个字段时按 true 处理，升级即生效；面板可显式关闭。
    const bypass = config.bypass_native_commands !== false && intent.native;
    const active = this.chat.status(account, device);
    // 追问窗口与「正在回答」算同一轮 AI 对话，可以免触发词继续说。
    const inFollowup = active.followup_until > Date.now()
      || ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase);
    // 把开关的真实值一并打出：面板开关改的是本地值，只有点了保存（或 2.3.6 起的即时保存）
    // 后端才会变；导出诊断日志可直接核对，不用猜为什么「明明关了」还在回答。
    songloft.log.info(`[VoiceDispatcher] routing chat_enabled=${config.enabled} require_trigger=${config.require_trigger !== false} fallback=${config.fallback_enabled} bypass=${bypass} followup=${inFollowup} intent=${intent.reason} q="${text.substring(0, 80)}"`);
    if (config.enabled && /^(停止回答|退出对话|结束对话)[。！!\s]*$/.test(text)) {
      await this.chat.cancel(account, device, true, true);
      return;
    }
    if (config.enabled && /^(停止|停止播放|暂停播放|暂停音乐|暂停|停一下|pause|stop)[。！!\s]*$/.test(text) && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase)) {
      await this.chat.cancel(account, device, true, false);
      if (current())
        await this.music.handleMessage(message, { deferResume: true, current });
      return;
    }
    if (!current())
      return;
    const fixed = await this.music.fixedControlType?.(text, config.enabled && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase));
    if (fixed === 'set_volume' && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase)) {
      if (current())
        await this.music.syncVolumeOnly(account, device);
      return;
    }
    if (fixed || await this.music.hasFixedControl(text)) {
      if (!current())
        return;
      await this.chat.cancel(account, device, true, false);
      await this.music.handleMessage(message, { deferResume: true, current });
      return;
    }
    const trigger = config.trigger_words.find(word => text.startsWith(word));
    if (config.enabled && trigger && !bypass) {
      if (!current())
        return;
      const question = text.slice(trigger.length).replace(/^[，,：:\s]+/, '').trim();
      if (question)
        await this.chat.submit(account, device, question, true, current);
      return;
    }
    if (!current())
      return;
    // 新语音先停止旧回答，保留 followup 快照用于分流。
    const release = this.chat.interruptForRouting
      ? await this.chat.interruptForRouting(account, device)
      : await this.chat.cancel(account, device, false, false);
    try {
      if (!current())
        return;
      // 旧配置没有 require_trigger 时按 true 处理，升级即生效；关闭后恢复旧行为。
      const canChatFallback = () => canFallbackToChat({
        enabled: config.enabled,
        requireTrigger: config.require_trigger !== false,
        fallbackEnabled: config.fallback_enabled,
        hasTrigger: !!trigger,
        inFollowup,
        bypass,
      });
      // 已拦截的口令连 AI 口令分析都不必发（自定义 OpenAI 兼容连接通常两套 AI 共用）。
      const handled = await this.music.handleMessage(message, { deferResume: true, current, suppressAnalysisFailureHint: bypass ? () => true : canChatFallback, skipAIAnalysis: bypass });
      if (!current() || handled)
        return;
      if (bypass) {
        // 保留小爱自己的执行答复，不播报「未识别」提示、不启动 LLM、不追加 TTS。
        this.music.resumeUnmatched(account, device);
        return;
      }
      if (canChatFallback()) {
        await this.chat.submit(account, device, text, true, current);
        return;
      }
      this.music.resumeUnmatched(account, device);
    }
    finally {
      if (release)
        await release();
    }
  }
  invalidate(): void { this.versions.clear(); this.playback.invalidate(); }
  close(): void { this.closed = true; this.invalidate(); }
}
