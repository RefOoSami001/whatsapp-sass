import { OpenRouter } from '@openrouter/sdk';
import type { IMemoryMessage } from '../messages/conversation-memory.model.js';
import { logger } from '../../common/logger.js';
import type { AppConfig } from '../../config/env.js';

export type AgentPromptProfile = {
  businessName: string;
  businessDescription: string;
  languagePreference: string;
  toneOfVoice: string;
  temperature: number;
};


export const OPENROUTER_MODEL_FALLBACKS: readonly string[] = [
// 'openrouter/elephant-alpha',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'minimax/minimax-m2.5:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'z-ai/glm-4.5-air:free',
  'arcee-ai/trinity-large-preview:free',
  'stepfun/step-3.5-flash:free',
  'openai/gpt-oss-20b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'openai/gpt-oss-120b:free',
];

function buildSystemPrompt(p: AgentPromptProfile): string {
  return `

=== ROLE ===
You are a WhatsApp sales assistant.
Use ONLY the provided business info. Do NOT invent anything.
=== BUSINESS ===
Name: ${p.businessName}
=== LANGUAGE & STYLE ===
- Language: ${p.languagePreference}
- Tone: ${p.toneOfVoice}
- Keep responses SHORT (max 1–5 sentences)
- No robotic replies
- No long explanations
- use emojis when appropriate
- Avoid formal language, be casual and relatable

=== CORE BEHAVIOR ===
- Respond ONLY to the latest user message
- Never repeat the same response wording
- Vary phrasing naturally
- Keep conversation flowing like a real human

=== BUSINESS DESCRIPTION ===
${p.businessDescription || 'N/A'}

=== IMAGE RULE ===
- When user asks to see a product → send ONLY 1 relevant image link
- Do NOT send multiple links
- Then ask a follow-up question

=== CONVERSATION FLOW ===
1. **Greeting**: If user greets → respond with greeting ONLY

2. **Product Selection**:
   - Ask about products naturally
   - Show available options
   - Guide user to choose

=== MEMORY ===
- Remember what the user has told you
- Don't ask for information already provided
- Reference previous choices in conversation

=== GOAL ===
Help customers choose products through natural conversation.
`.trim();
}

function assistantContentToString(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text?: string }).text ?? '')
          : ''
      )
      .filter(Boolean)
      .join('')
      .trim();
  }
  return '';
}

function buildChatMessages(
  systemPrompt: string,
  history: IMemoryMessage[],
  userMessage: string
) {
  const messages = [{ role: 'system', content: systemPrompt }] as any[];

  for (const m of history) {
    if (!m.text?.trim()) continue;

    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.text });
    }
  }

  // 🔥 مهم: منع تكرار نفس الرسالة
  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || last.text !== userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

export class OpenRouterService {
  private client: OpenRouter | null = null;

  constructor(private readonly getConfig: () => AppConfig) {}

  private getClient(): OpenRouter {
    const cfg = this.getConfig();
    if (!cfg.OPENROUTER_API_KEY?.trim()) {
      throw new Error('OPENROUTER_API_KEY_NOT_CONFIGURED');
    }

    if (!this.client) {
      this.client = new OpenRouter({
        apiKey: cfg.OPENROUTER_API_KEY.trim(),
      });
    }

    return this.client;
  }

  async generateReply(params: {
    agent: AgentPromptProfile;
    history: IMemoryMessage[];
    userMessage: string;
  }): Promise<string> {
    const fallback =
      "Sorry 😅 I couldn't respond right now. Please try again.";

    let cfg: AppConfig;
    try {
      cfg = this.getConfig();
    } catch {
      return fallback;
    }

    if (!cfg.OPENROUTER_API_KEY?.trim()) {
      return fallback;
    }

    const systemPrompt = buildSystemPrompt(params.agent);
    const messages = buildChatMessages(
      systemPrompt,
      params.history,
      params.userMessage
    );

    const client = this.getClient();

    const modelsToTry = [...OPENROUTER_MODEL_FALLBACKS];

    for (const model of modelsToTry) {
      try {
        const completion = await client.chat.send({
          chatRequest: {
            model,
            messages,
            stream: false,
            temperature: params.agent.temperature,
            maxTokens: 50000,
          },
        });

        const raw = completion?.choices?.[0]?.message?.content;
        const text = assistantContentToString(raw);

        if (text) {
          logger.info({ model }, 'OpenRouter: reply generated with model');
          return text;
        }
      } catch (e) {
        logger.warn({ model, err: String(e) }, 'Model failed, trying next');
        continue;
      }
    }

    logger.warn('All models failed');
    return fallback;
  }
}
