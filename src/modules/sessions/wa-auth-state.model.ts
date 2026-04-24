import mongoose, { Schema, Document, Types } from 'mongoose';

/** Stores Baileys creds blob and per-key signal material for a session (MongoDB, not filesystem). */
export interface IWaAuthState extends Document {
  sessionId: Types.ObjectId;
  credsJson: string;
  updatedAt: Date;
}

const WaAuthStateSchema = new Schema<IWaAuthState>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, unique: true },
    credsJson: { type: String, required: true, default: '{}' },
  },
  { timestamps: true }
);

export const WaAuthStateModel = mongoose.model<IWaAuthState>('WaAuthState', WaAuthStateSchema);

export interface IWaAuthKey extends Document {
  sessionId: Types.ObjectId;
  keyType: string;
  keyId: string;
  valueJson: string;
}

const WaAuthKeySchema = new Schema<IWaAuthKey>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    keyType: { type: String, required: true },
    keyId: { type: String, required: true },
    valueJson: { type: String, required: true },
  },
  { timestamps: true }
);

WaAuthKeySchema.index({ sessionId: 1, keyType: 1, keyId: 1 }, { unique: true });

export const WaAuthKeyModel = mongoose.model<IWaAuthKey>('WaAuthKey', WaAuthKeySchema);
