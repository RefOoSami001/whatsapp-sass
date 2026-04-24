import mongoose, { Schema, Document, Types } from 'mongoose';

export type CampaignStatus =
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ICampaignMessage {
  text?: string;
  imageUrls: string[];
}

export interface ICampaignOptions {
  baseDelayMs: number;
  jitterMs: number;
  maxSendsPerHour?: number;
}

export interface ICampaign extends Document {
  _id: Types.ObjectId;
  publicId: string;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  status: CampaignStatus;
  scheduledAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  message: ICampaignMessage;
  options: ICampaignOptions;
  totalRecipients: number;
  pendingCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignMessageSchema = new Schema<ICampaignMessage>(
  {
    text: { type: String },
    imageUrls: { type: [String], default: [] },
  },
  { _id: false }
);

const CampaignOptionsSchema = new Schema<ICampaignOptions>(
  {
    baseDelayMs: { type: Number, required: true },
    jitterMs: { type: Number, required: true },
    maxSendsPerHour: { type: Number },
  },
  { _id: false }
);

const CampaignSchema = new Schema<ICampaign>(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    status: {
      type: String,
      enum: ['scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'],
      required: true,
    },
    scheduledAt: { type: Date },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    message: { type: CampaignMessageSchema, required: true },
    options: { type: CampaignOptionsSchema, required: true },
    totalRecipients: { type: Number, required: true },
    pendingCount: { type: Number, required: true },
    sentCount: { type: Number, required: true, default: 0 },
    failedCount: { type: Number, required: true, default: 0 },
    skippedCount: { type: Number, required: true, default: 0 },
    lastError: { type: String },
  },
  { timestamps: true }
);

CampaignSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });
CampaignSchema.index({ status: 1, scheduledAt: 1 });

export const CampaignModel = mongoose.model<ICampaign>('Campaign', CampaignSchema);
