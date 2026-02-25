import { Router, Request, Response } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { prisma } from '../lib/prisma';
import { signJwt } from '../lib/jwt';

const router = Router();

// Configure Google Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await prisma.user.upsert({
          where: { googleId: profile.id },
          update: {
            displayName: profile.displayName,
            avatar: profile.photos?.[0]?.value || null,
          },
          create: {
            googleId: profile.id,
            email: profile.emails?.[0]?.value || '',
            displayName: profile.displayName,
            avatar: profile.photos?.[0]?.value || null,
          },
        });
        return done(null, user);
      } catch (err) {
        return done(err as Error);
      }
    }
  )
);

// Initiate Google OAuth
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  })
);

// Google OAuth callback
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failed' }),
  (req: Request, res: Response) => {
    const user = req.user as { id: string; email: string };
    const token = signJwt({ userId: user.id, email: user.email });

    // Redirect to frontend with token in query (frontend should store in localStorage/cookie)
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/auth/callback?token=${token}`);
  }
);

// Auth failed route
router.get('/failed', (_req: Request, res: Response) => {
  res.status(401).json({ message: 'Đăng nhập thất bại. Vui lòng thử lại.' });
});

// Get current user info
router.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : req.cookies?.token;

  if (!token) {
    res.status(401).json({ message: 'Bạn chưa đăng nhập.' });
    return;
  }

  const { verifyJwt } = await import('../lib/jwt');
  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ message: 'Token không hợp lệ.' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(404).json({ message: 'Người dùng không tồn tại.' });
    return;
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatar: user.avatar,
  });
});

export default router;
