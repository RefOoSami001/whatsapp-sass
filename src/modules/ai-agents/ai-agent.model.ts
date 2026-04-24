import mongoose, { Schema, Document, Types } from 'mongoose';

/** How many past messages to keep for chat context. */
export type MemoryMessageLimit = number;

/** Typing indicator settings */
export interface ITypingIndicatorSettings {
  enabled: boolean;
  typingDurationMs: number; // How long to show "typing..." (100-3000ms)
}

/** One AI agent per WhatsApp session (unique sessionId). */
export interface IAiAgent extends Document {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  /** @deprecated Legacy per-user Gemini key; unused when using hosted OpenRouter. */
  geminiKeyEncrypted?: string;
  businessName: string;
  businessDescription: string;
  languagePreference: string;
  toneOfVoice: string;
  enabled: boolean;
  typingIndicator: ITypingIndicatorSettings;
  memoryMessageLimit: MemoryMessageLimit;
  temperature: number;
  /** @deprecated Ignored at runtime; OpenRouter uses a fixed server-side model list. */
  aiModel?: string;
  /** If set (non-empty), bot reacts to the customer's message with this emoji before replying. */
  reactionEmoji?: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const AiAgentSchema = new Schema<IAiAgent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, unique: true },
    geminiKeyEncrypted: { type: String, default: '' },
    businessName: { type: String, default: 'Business', maxlength: 500 },
    businessDescription: { type: String, default: '', maxlength: 8000 },
    languagePreference: { type: String, default: 'en', maxlength: 32 },
    toneOfVoice: { type: String, default: 'professional', maxlength: 80 },
    enabled: { type: Boolean, default: true },

    // Typing indicator settings
    typingIndicator: {
      type: {
        enabled: { type: Boolean, default: true },
        typingDurationMs: { type: Number, default: 1000, min: 100, max: 3000 },
      },
      default: { enabled: true, typingDurationMs: 1000 },
    },

    // Conversation history size
    memoryMessageLimit: { type: Number, default: 50, min: 1, max: 100 },
    temperature: { type: Number, default: 0.7, min: 0.0, max: 2.0 },
    aiModel: { type: String, default: 'google/gemma-4-26b-a4b-it:free' },
    reactionEmoji: { type: String, default: null, maxlength: 32 },
  },
  { timestamps: true }
);

AiAgentSchema.index({ userId: 1, updatedAt: -1 });

export const AiAgentModel = mongoose.model<IAiAgent>('AiAgent', AiAgentSchema);
