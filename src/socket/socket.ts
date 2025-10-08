import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

export function setupSocket(httpServer: any) {
  const io = new Server(httpServer, {
    cors: {
      origin: ['http://localhost:4200'], // your Angular app origin
      credentials: true,
    },
  });

  // Optional: JWT auth for sockets
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers.cookie?.split('token=')[1];
      if (!token) return next(new Error('Unauthorized'));

      const payload: any = jwt.verify(token, process.env.JWT_SECRET!);
      (socket as any).userId = payload.sub;
      next();
    } catch (e) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket as any).userId;
    socket.join(`user:${userId}`);
    console.log(`✅ Socket connected: ${userId}`);
  });

  return io;
}