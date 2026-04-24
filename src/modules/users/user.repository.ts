import { UserModel, type IUser } from './user.model.js';

export class UserRepository {
  async findByEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase().trim() });
  }

  async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  async create(email: string, passwordHash: string): Promise<IUser> {
    return UserModel.create({ email: email.toLowerCase().trim(), passwordHash });
  }
}
