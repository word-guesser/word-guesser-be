import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import authRouter from './routes/auth';
import roomRouter from './routes/rooms';
import wordRouter from './routes/words';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(passport.initialize());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Routes
  app.use('/auth', authRouter);
  app.use('/rooms', roomRouter);
  app.use('/words', wordRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ message: 'Không tìm thấy trang.' });
  });

  return app;
}

export default createApp();
