export interface UserNotificationEntity {
  _id?: string;
  username: string;           // primary identity
  notificationId: string;     // references Notification._id
  isRead: boolean;
  isArchived: boolean;
  deliveredAt: Date;
  readAt?: Date;
}