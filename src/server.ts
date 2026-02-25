import 'dotenv/config';
import http from 'http';
import app from './app';
import { setupSocketIO } from './socket';
import { prisma } from './lib/prisma';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const httpServer = http.createServer(app);
  const io = setupSocketIO(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`✅ Word Guesser Server chạy tại http://localhost:${PORT}`);
    console.log(`📡 Socket.IO đã sẵn sàng`);
  });

  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    io.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Lỗi khởi động server:', err);
  process.exit(1);
});
