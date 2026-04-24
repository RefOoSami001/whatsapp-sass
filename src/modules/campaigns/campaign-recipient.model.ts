import mongoose, { Schema, Document, Types } from 'mongoose';

export type CampaignRecipientStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';

export interface ICampaignRecipient extends Document {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  index: number;
  to: string;
  status: CampaignRecipientStatus;
  error?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignRecipientSchema = new Schema<ICampaignRecipient>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    index: { type: Number, required: true },
    to: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'sent', 'failed', 'skipped'],
      required: true,
    },
    error: { type: String },
    sentAt: { type: Date },
  },
  { timestamps: true }
);

CampaignRecipientSchema.index({ campaignId: 1, index: 1 }, { unique: true });
CampaignRecipientSchema.index({ campaignId: 1, status: 1 });

export const CampaignRecipientModel = mongoose.model<ICampaignRecipient>(
  'CampaignRecipient',
  CampaignRecipientSchema
);
