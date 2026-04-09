import type { ChatMessage, NormalizedPrompt } from './types.js';

export function normalizeMessages(messages: ChatMessage[]): NormalizedPrompt {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages 不能为空');
  }

  const systemParts = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean);

  const nonSystemMessages: Array<{ role: 'user' | 'assistant'; content: string; name?: string }> =
    messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content.trim(),
        name: typeof message.name === 'string' ? message.name.trim() || undefined : undefined,
      }))
      .filter((message) => Boolean(message.content));

  if (nonSystemMessages.length === 0) {
    throw new Error('至少需要一条非 system 消息');
  }

  const latestUserMessage = [...nonSystemMessages]
    .reverse()
    .find((message) => message.role === 'user')?.content;

  if (!latestUserMessage) {
    throw new Error('至少需要一条 user 消息');
  }

  const trailingUserMessages: Array<{ role: 'user'; content: string; name?: string }> =
    nonSystemMessages
      .filter((message) => message.role === 'user')
      .map((message) => ({
        role: 'user',
        content: message.content,
        name: message.name,
      }));

  return {
    system: systemParts.join('\n\n') || undefined,
    latestUserMessage,
    trailingUserMessages,
    trailingUserBlock: trailingUserMessages
      .map((message) => `${message.name ? `${message.name}: ` : ''}${message.content}`)
      .join('\n\n'),
    nonSystemMessages,
    fullMessagesBlock: nonSystemMessages
      .map((message) => {
        const label = message.name ? `${message.role}:${message.name}` : message.role;
        return `${label}:\n${message.content}`;
      })
      .join('\n\n'),
    historyCount: nonSystemMessages.length,
    hasSystem: systemParts.length > 0,
  };
}
