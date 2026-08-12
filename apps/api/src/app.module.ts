import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AiService } from './ai.service';
import { AppController } from './app.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AutonomyController } from './autonomy.controller';
import { AutonomyService } from './autonomy.service';
import { CryptoService } from './crypto.service';
import { CodexInternalController } from './codex-internal.controller';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import { DesignConceptService } from './design-concept.service';
import { DocumentsService } from './documents.service';
import { FlService } from './fl.service';
import { InternalOwnerController } from './internal-owner.controller';
import { JobProgressService } from './job-progress.service';
import { ProcessorService } from './processor.service';
import { ProjectAttachmentsService } from './project-attachments.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { QueueService } from './queue.service';
import { ResearchService } from './research.service';
import { SalesAgentService } from './sales-agent.service';
import { SandboxService } from './sandbox.service';
import { SettingsService } from './settings.service';
import { TelegramController } from './telegram.controller';
import { TelegramInternalController } from './telegram-internal.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET, signOptions: { expiresIn: '7d', issuer: 'freelance-sales-v2' } }),
  ],
  controllers: [AuthController, AppController, TelegramController, TelegramInternalController, CodexInternalController, InternalOwnerController, PushController, AutonomyController],
  providers: [DatabaseService, CryptoService, SettingsService, AuthService, AuthGuard, QueueService, JobProgressService, CodexTaskService, AiService, DesignConceptService, SalesAgentService, SandboxService, DocumentsService, ProjectAttachmentsService, FlService, TelegramService, PushService, AutonomyService, ResearchService, ProcessorService],
})
export class AppModule {}
