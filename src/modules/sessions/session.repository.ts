import { randomUUID } from 'crypto';
import { SessionModel, type ISession, type SessionConnectionStatus } from './session.model.js';
import type { Types } from 'mongoose';

export class SessionRepository {
  async create(userId: Types.ObjectId, label?: string): Promise<ISession> {
    return SessionModel.create({
      userId,
      publicId: randomUUID(),
      label,
      status: 'disconnected',
    });
  }

  async findByPublicId(publicId: string): Promise<ISession | null> {
    return SessionModel.findOne({ publicId });
  }

  async findByPublicIdForUser(publicId: string, userId: Types.ObjectId): Promise<ISession | null> {
    return SessionModel.findOne({ publicId, userId });
  }

  async findByIdForUser(sessionId: Types.ObjectId, userId: Types.ObjectId): Promise<ISession | null> {
    return SessionModel.findOne({ _id: sessionId, userId });
  }

  async listForUser(userId: Types.ObjectId): Promise<ISession[]> {
    return SessionModel.find({ userId }).sort({ updatedAt: -1 });
  }

  /** Sessions that should reconnect after a process restart (in-memory sockets are always empty on boot). */
  async findAllByStatuses(statuses: SessionConnectionStatus[]): Promise<ISession[]> {
    return SessionModel.find({ status: { $in: statuses } }).sort({ updatedAt: -1 });
  }

  async updateById(
    id: Types.ObjectId,
    patch: Partial<Pick<ISession, 'status' | 'phoneNumber' | 'lastError' | 'qrCode'>>
  ): Promise<void> {
    await SessionModel.updateOne({ _id: id }, { $set: patch });
  }

  async deleteById(id: Types.ObjectId): Promise<void> {
    await SessionModel.deleteOne({ _id: id });
  }
}
