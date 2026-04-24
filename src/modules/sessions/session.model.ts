import mongoose, { Schema, Document, Types } from 'mongoose';

export type SessionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'connected'
  | 'error';

export interface ISession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  publicId: string;
  label?: string;
  status: SessionConnectionStatus;
  phoneNumber?: string;
  lastError?: string;
  qrCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    publicId: { type: String, required: true, unique: true, index: true },
    label: { type: String },
    status: {
      type: String,
      enum: ['disconnected', 'connecting', 'qr_pending', 'connected', 'error'],
      default: 'disconnected',
    },
    phoneNumber: { type: String },
    lastError: { type: String },
    qrCode: { type: String },
  },
  { timestamps: true }
);

SessionSchema.index({ userId: 1, publicId: 1 });

export const SessionModel = mongoose.model<ISession>('Session', SessionSchema);
