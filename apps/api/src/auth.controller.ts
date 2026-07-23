import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('setup-status')
  setupStatus() { return this.auth.setupStatus(); }

  @Post('setup')
  async setup(@Body() body: { token?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.setup(body.token || '', body.password || '');
    this.setCookie(res, result.token);
    return { user: result.user };
  }

  @Post('login')
  async login(@Body() body: { password?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body.password || '');
    this.setCookie(res, result.token);
    return { user: result.user };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('fs_session', { path: this.cookiePath(), secure: true, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: AuthenticatedRequest) { return { user: req.user }; }

  private setCookie(res: Response, token: string) {
    res.cookie('fs_session', token, {
      path: this.cookiePath(), httpOnly: true, secure: true, sameSite: 'strict', maxAge: 7 * 24 * 3600 * 1000,
    });
  }

  private cookiePath() {
    return process.env.PUBLIC_BASE_PATH || '/';
  }
}
