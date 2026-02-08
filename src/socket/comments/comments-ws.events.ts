// Path: src/socket/comments/comments-ws.events.ts
export const COMMENTS_WS_EVENTS = {
  // Client -> Server
  SUBSCRIBE: "comments:subscribe",
  UNSUBSCRIBE: "comments:unsubscribe",

  // Server -> Client
  SUBSCRIBED: "comments:subscribed",
  UNSUBSCRIBED: "comments:unsubscribed",

  CREATED: "comments:created",
  UPDATED: "comments:updated",
  DELETED: "comments:deleted",

  PINNED: "comments:pinned",
  UNPINNED: "comments:unpinned",

  // Optional
  ERROR: "comments:error",
} as const;

export type CommentsWsEventKey =
  (typeof COMMENTS_WS_EVENTS)[keyof typeof COMMENTS_WS_EVENTS];
