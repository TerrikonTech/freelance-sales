import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  const webRoot = join(__dirname, '..', '..', 'web', 'dist');
  // The site lives under /sales, so the browser asks for /sales/assets/*.  Without this
  // mount those requests fell through to the SPA fallback and came back as index.html,
  // which the browser refuses to run — the page rendered unstyled and dead.
  app.use('/sales', express.static(webRoot, { index: false, maxAge: '1h' }));
  app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
  const expressApp = app.getHttpAdapter().getInstance() as express.Express;
  expressApp.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webRoot, 'index.html')));
  await app.listen(Number(process.env.APP_PORT || 3000), '0.0.0.0');
}

void bootstrap();
