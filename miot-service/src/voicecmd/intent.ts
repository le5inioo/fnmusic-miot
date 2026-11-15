import type { ConversationMessage } from '../types';

export type VoiceIntentReason = 'question' | 'domain' | 'phrase' | 'native_reply' | 'none';

/** 一条轮询语音的意图分类，决定它能不能被交给 AI 对话代答。 */
export interface VoiceIntent {
  /** 已由小爱 / 米家原生处理的指令（设备控制、场景执行等），不应再让 LLM 抢答。 */
  native: boolean;
  /** 判定依据，写进日志便于复核误判。 */
  reason: VoiceIntentReason;
  /** 用户显式提问；即使带设备词也应尊重触发词。 */
  question: boolean;
}

// 疑问句 / 追问是第一道判据：设备控制口令是祈使句，不含疑问信号。
const QUESTION_RE = /[?？]|什么|为啥|为什么|怎么|怎样|如何|哪[里个些位]|谁|几点|几号|多少|是不是|有没有|能不能|可不可以|要不要|会不会|对不对|吗|呢|请问|问一下|告诉我|介绍一下|解释|讲讲|说说|查一下|帮我查/;

// 设备控制动作。刻意不含「播放 / 下一首 / 收藏」等音乐口令动词，音乐仍由规则链路优先处理。
const CONTROL_ACTION_RE = /打开|开启|开|关闭|关掉|关上|关|调高|调低|调大|调小|调到|调整|设置|设为|切换到|切换|启动|拉开|拉上|合上|升起|降下|点亮|熄灭|锁上|解锁|定时|延时|执行|运行|启用|禁用|拔掉|插上/;

// 设备 / 家居对象用类别词而非具体品牌型号，覆盖任意米家设备与自定义场景。
const CONTROL_TARGET_RE = /灯|灯光|空调|插座|插排|开关|窗帘|风扇|净化器|加湿器|除湿|扫地|机器人|电视|机顶盒|热水器|门锁|门禁|摄像头|浴霸|地暖|新风|电饭煲|洗衣机|冰箱|微波炉|烤箱|充电桩|设备|家电|家居|场景|模式|温度|湿度|亮度|色温|风速|风量|电源|路由器|网关|闹钟|提醒|计时|音箱|音量/;

// ubus nlp_result_get 路径会保留 domain / action；LATEST_ASK 路径没有，靠下面两条兜底。
const CONTROL_DOMAIN_RE = /miot|iot|smart|home|device|control|scene|switch|light|plug|aircon|curtain|appliance|智能|家居|设备|控制|场景/i;

// 小爱已执行完毕的确认语。必须同时带控制动词，避免把「好的，给你讲个笑话」误判成设备指令。
const NATIVE_CONFIRM_RE = /^(?:好的?|好嘞|没问题|收到|已经|已|为您|正在|马上|这就)/;

export function isQuestionLike(text: string): boolean {
  return QUESTION_RE.test(text);
}

/**
 * 判断这条轮询到的语音是否属于「已由小爱原生处理的设备控制类指令」。
 * 三条信号按可靠性排序：结构化意图 > 文本特征 > 云端执行确认。
 * 只要文本是提问就一律放行，保证「请问……」和追问窗口不受影响。
 */
export interface ChatRoutingInput {
  enabled: boolean;
  /** 旧配置缺字段时按 true 处理，升级即生效。 */
  requireTrigger: boolean;
  fallbackEnabled: boolean;
  /** 语音以触发词开头（触发词分支已先行返回，这里通常恒为 false）。 */
  hasTrigger: boolean;
  /** 处于上一轮 AI 回答的追问窗口或同一轮回答尚未结束。 */
  inFollowup: boolean;
  /** 已判定为小爱原生处理的设备控制指令。 */
  bypass: boolean;
}

/**
 * 规则/音乐口令都没命中时，是否允许把这条语音提交给 AI 对话。
 * requireTrigger 为 true 时，触发词是首次提问的硬门槛；fallbackEnabled
 * 只能决定「带触发词或追问时是否兜底」，不能单凭自己把任意语音送进 LLM。
 */
export function canFallbackToChat(input: ChatRoutingInput): boolean {
  if (!input.enabled || input.bypass) return false;
  const mayStart = !input.requireTrigger || input.hasTrigger || input.inFollowup;
  return mayStart && (input.fallbackEnabled || input.inFollowup);
}

export function classifyVoiceIntent(message: ConversationMessage, text: string): VoiceIntent {
  const query = (text || '').trim();
  if (!query)
    return { native: false, reason: 'none', question: false };
  if (isQuestionLike(query))
    return { native: false, reason: 'question', question: true };

  const first = message?.message?.response?.answer?.[0];

  // ① 结构化意图（ubus 路径）。音乐域不含这些词，不会被误判。
  const domain = `${first?.domain || ''} ${first?.action || ''}`;
  if (CONTROL_DOMAIN_RE.test(domain))
    return { native: true, reason: 'domain', question: false };

  // ② 文本特征：动作 + 设备 / 家居对象。
  if (CONTROL_ACTION_RE.test(query) && CONTROL_TARGET_RE.test(query))
    return { native: true, reason: 'phrase', question: false };

  // ③ 云端已播报执行确认：说明小爱已经处理完，插件不该再代答一次。
  const reply = (first?.content || '').trim();
  if (reply && reply.length <= 80 && NATIVE_CONFIRM_RE.test(reply) && CONTROL_ACTION_RE.test(reply))
    return { native: true, reason: 'native_reply', question: false };

  return { native: false, reason: 'none', question: false };
}
