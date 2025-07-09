import { v4 as uuidv4 } from 'uuid';

interface UploadSession {
  token: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'uploaded';
  filePath?: string;
}

export class UploadSessionService {
  private static sessions: Map<string, UploadSession> = new Map();

  public static createSession(): UploadSession {
    const token = uuidv4();
    const now = Date.now();
    const session: UploadSession = {
      token,
      createdAt: now,
      expiresAt: now + 5 * 60 * 1000, // 5 minutes
      status: 'pending',
    };
    this.sessions.set(token, session);
    return session;
  }

  public static getSession(token: string): UploadSession | undefined {
    return this.sessions.get(token);
  }

  public static updateSession(token: string, filePath: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    session.status = 'uploaded';
    session.filePath = filePath;
    return true;
  }
}