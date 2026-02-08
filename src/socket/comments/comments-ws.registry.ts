// Path: src/socket/comments/comments-ws.registry.ts
// ============================================================================
// CommentsWsRegistry (Singleton Registry)
// ----------------------------------------------------------------------------
// WHY:
// - Your CommentsEngineRouter constructor must have NO args.
// - Socket bootstrap creates the gateway with `io`.
// - REST/router/controller needs to broadcast without DI wiring.
// - This registry bridges those worlds in a safe, explicit way.
// ============================================================================

import type { CommentsWsGateway } from "./comments-ws.gateway";

export class CommentsWsRegistry {
  private static gateway: CommentsWsGateway | null = null;

  public static setGateway(gw: CommentsWsGateway): void {
    CommentsWsRegistry.gateway = gw;
  }

  public static getGateway(): CommentsWsGateway | null {
    return CommentsWsRegistry.gateway;
  }
}
