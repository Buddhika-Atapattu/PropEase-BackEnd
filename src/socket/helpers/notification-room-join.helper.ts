// Path: src/socket/helpers/notification-room-join.helper.ts
// =============================================================================
// NotificationRoomsJoinHelper
// - Joins all notification rooms for the authenticated socket
// - Ensures Fix A WS emits actually reach clients
// =============================================================================

import type { Socket } from "socket.io";
import { NotificationRooms } from "../events/notifications/notification.events";

type AuthUserLike = {
  username?: string;
  role?: string;
  teamCodes?: string[]; // optional in your AuthUserNormalized
};

export class NotificationRoomsJoinHelper {
  private constructor() {}

  public static joinForAuth(socket: Socket, auth: AuthUserLike): void {
    const username = typeof auth.username === "string" ? auth.username.trim() : "";
    const roleKey = typeof auth.role === "string" ? auth.role.trim() : "";

    // Always join company room (because Company audience exists)
    socket.join(NotificationRooms.COMPANY);

    // Join role room if available
    if (roleKey) {
      socket.join(NotificationRooms.role(roleKey));
    }

    // Join user room if available
    if (username) {
      socket.join(NotificationRooms.user(username));
    }

    // Join team rooms (if your auth carries teamCodes)
    const teams = Array.isArray(auth.teamCodes) ? auth.teamCodes : [];
    for (const t of teams) {
      const team = typeof t === "string" ? t.trim() : "";
      if (!team) continue;
      socket.join(NotificationRooms.team(team));
    }
  }
}