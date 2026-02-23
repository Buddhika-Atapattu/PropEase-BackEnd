// Path: src/api/notifications/notification-hub.router.ts
// =============================================================================
// Notification Hub Router — 100% CLASS-BASED
// -----------------------------------------------------------------------------
// Mounts NotificationHubController routes under this router.
// You will mount this router in routes.bootstrap.ts (example):
//   app.use("/api-notification", new NotificationHubRoute().router);
// =============================================================================

import { Router } from "express";

import NotificationHubController from "../../controllers/notifications/notification-hub.controller";

export default class NotificationHubRoute {
  public readonly router: Router;

  private readonly controller: NotificationHubController;

  public constructor() {
    this.router = Router();
    this.controller = new NotificationHubController();

    // All endpoints are already defined inside the controller.router
    this.router.use("/", this.controller.router);
  }
}
