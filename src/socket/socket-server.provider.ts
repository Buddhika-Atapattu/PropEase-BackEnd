// Path: src/socket/socket-server.provider.ts
//
// Simple singleton-style accessor for the SocketConnectionHandler instance.
// You call `SocketServerProvider.register(handler)` once in your bootstrap
// and then use `SocketServerProvider.getHandler()` from controllers/services.

import type { SocketConnectionHandler } from './socket-connection.handler';

export class SocketServerProvider {

  private static handler: SocketConnectionHandler | null = null;

  public static register( handler: SocketConnectionHandler ): void {
    SocketServerProvider.handler = handler;
  }

  public static getHandler(): SocketConnectionHandler | null {
    return SocketServerProvider.handler;
  }
}
