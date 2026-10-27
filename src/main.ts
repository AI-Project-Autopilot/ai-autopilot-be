import 'dotenv/config';
import 'reflect-metadata';

import cookieParser from 'cookie-parser';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import passport from './auth/strategies/index';
import { errorHandler } from './common/filters/error-handler';
import { useSwagger } from './common/swagger/swagger';
import routes from './routes/index-route';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(passport.initialize());
  app.use(routes);
  app.use(errorHandler);
  useSwagger(app.getHttpAdapter().getInstance());

  const port = process.env.PORT ?? 5000;

  await app.listen(port);
  console.log(`Server running on ${await app.getUrl()}`);
}

void bootstrap();
