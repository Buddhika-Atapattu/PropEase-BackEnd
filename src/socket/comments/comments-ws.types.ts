// Path: src/socket/comments/comments-ws.types.ts
import type { CommentDto, CommentTargetDto } from "../../types/comment.types";

export interface CommentsWsSubscribePayload {
  target: CommentTargetDto;
  focus?: {
    subSection?: string;
    module?: string;
    scopeKey?: string;
    scopeValue?: string;
  };
}

export interface CommentsWsSubscribedPayload {
  target: CommentTargetDto;
  rooms: string[];
}

export interface CommentsWsUnsubscribePayload {
  target: CommentTargetDto;
  focus?: {
    subSection?: string;
    module?: string;
    scopeKey?: string;
    scopeValue?: string;
  };
}

export interface CommentsWsUnsubscribedPayload {
  target: CommentTargetDto;
  rooms: string[];
}

export interface CommentsWsCreatedPayload {
  target: CommentTargetDto;
  comment: CommentDto;
}

export interface CommentsWsUpdatedPayload {
  target: CommentTargetDto;
  id: string;
  patch?: Record<string, unknown>;
  updatedComment?: CommentDto;
}

export interface CommentsWsDeletedPayload {
  target: CommentTargetDto;
  id: string;
}

export interface CommentsWsPinnedPayload {
  target: CommentTargetDto;
  id: string;
  pinnedAtIso: string;
  pinnedByUserId: string;
}

export interface CommentsWsUnpinnedPayload {
  target: CommentTargetDto;
  id: string;
}

export interface CommentsWsErrorPayload {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}
