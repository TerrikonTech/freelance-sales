import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProcessorService } from './processor.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.get(ProcessorService).start();
}

void bootstrap();
