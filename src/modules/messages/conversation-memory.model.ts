import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IMemoryMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: Date;
  remoteJid?: string;
}

export interface IConversationMemory extends Document {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  remoteJid: string;
  messages: IMemoryMessage[];
  updatedAt: Date;
}

const MemoryMsgSchema = new Schema<IMemoryMessage>(
  {
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
    remoteJid: { type: String },
  },
  { _id: false }
);

const ConversationMemorySchema = new Schema<IConversationMemory>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true },
    remoteJid: { type: String, required: true },
    messages: { type: [MemoryMsgSchema], default: [] },
  },
  { timestamps: true }
);

ConversationMemorySchema.index({ sessionId: 1, remoteJid: 1 }, { unique: true });

export const ConversationMemoryModel = mongoose.model<IConversationMemory>(
  'ConversationMemory',
  ConversationMemorySchema
);
