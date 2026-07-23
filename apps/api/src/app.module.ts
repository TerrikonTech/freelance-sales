import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AiService } from './ai.service';
import { AppController } from './app.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { CodexInternalController } from './codex-internal.controller';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import { DocumentsService } from './documents.service';
import { FlService } from './fl.service';
import { ProcessorService } from './processor.service';
import { ProjectAttachmentsService } from './project-attachments.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { QueueService } from './queue.service';
import { SettingsService } from './settings.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET, signOptions: { expiresIn: '7d', issuer: 'freelance-sales-v2' } }),
  ],
  controllers: [AuthController, AppController, TelegramController, CodexInternalController, PushController],
  providers: [DatabaseService, CryptoService, SettingsService, AuthService, AuthGuard, QueueService, CodexTaskService, AiService, DocumentsService, ProjectAttachmentsService, FlService, TelegramService, PushService, ProcessorService],
})
export class AppModule {}
