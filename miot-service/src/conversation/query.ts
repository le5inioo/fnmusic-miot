import type { ConversationMessage } from '../types';

/** 保留原始口令；意图文本可能已被云端去掉触发词或改写。 */
export function conversationQuery(message: ConversationMessage): string {
  const answer = message.message?.response?.answer?.[0];
  return answer?.question?.trim() || answer?.intention?.query?.trim() || '';
}
