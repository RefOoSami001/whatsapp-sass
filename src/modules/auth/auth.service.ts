import bcrypt from 'bcryptjs';
import { AppError } from '../../common/errors.js';
import { UserRepository } from '../users/user.repository.js';
import { signToken } from './jwt.js';

export class AuthService {
  constructor(private readonly users: UserRepository) {}

  async register(email: string, password: string) {
    const existing = await this.users.findByEmail(email);
    if (existing) throw new AppError('EMAIL_IN_USE', 'Email already registered', 409);
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.users.create(email, passwordHash);
    const token = signToken({ sub: user._id.toString(), email: user.email });
    return { token, user: { id: user._id.toString(), email: user.email } };
  }

  async login(email: string, password: string) {
    const user = await this.users.findByEmail(email);
    if (!user) throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    const token = signToken({ sub: user._id.toString(), email: user.email });
    return { token, user: { id: user._id.toString(), email: user.email } };
  }
}
