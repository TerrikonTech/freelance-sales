import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { DatabaseService } from './database.service';

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService) {}

  async setupStatus() {
    const result = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    return { required: Number(result.rows[0].count) === 0 };
  }

  async setup(token: string, password: string) {
    const status = await this.setupStatus();
    if (!status.required) throw new ConflictException('Настройка уже выполнена');
    if (!token || token !== process.env.SETUP_TOKEN) throw new UnauthorizedException('Неверный setup token');
    if (password.length < 12) throw new ConflictException('Пароль должен содержать минимум 12 символов');
    const passwordHash = await hash(password, 12);
    const result = await this.db.query<{ id: string; email: string }>(
      'INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email',
      ['admin@local', passwordHash],
    );
    return this.issue(result.rows[0]);
  }

  async login(password: string) {
    const result = await this.db.query<{ id: string; email: string; password_hash: string }>(
      'SELECT id,email,password_hash FROM users WHERE email=$1',
      ['admin@local'],
    );
    const user = result.rows[0];
    if (!user || !(await compare(password, user.password_hash))) {
      throw new UnauthorizedException('Неверный пароль');
    }
    return this.issue(user);
  }

  async verify(token: string): Promise<{ sub: string; email: string }> {
    try {
      return await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Требуется вход');
    }
  }

  private async issue(user: { id: string; email: string }) {
    return { token: await this.jwt.signAsync({ sub: user.id, email: user.email }), user: { id: user.id, email: user.email } };
  }
}
