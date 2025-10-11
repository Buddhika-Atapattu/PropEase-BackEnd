import {UserNotificationModel} from '../../models/notifications/user-notification.model';

export default class UserNotificationRepo {
  upsert(username: string, notificationId: string) {
    return UserNotificationModel.findOneAndUpdate(
      {username, notificationId},
      {$setOnInsert: {deliveredAt: new Date(), isRead: false, isArchived: false}},
      {upsert: true, new: true},
    );
  }
  markRead(username: string, notificationId: string) {
    return UserNotificationModel.updateOne(
      {username, notificationId},
      {$set: {isRead: true, readAt: new Date()}},
      {upsert: true},
    );
  }
  markAllRead(username: string) {
    return UserNotificationModel.updateMany(
      {username, isRead: false},
      {$set: {isRead: true, readAt: new Date()}},
    );
  }
  findForUser(username: string, limit = 50, skip = 0, onlyUnread?: boolean) {
    const filter: any = {username};
    if(onlyUnread) filter.isRead = false;
    return UserNotificationModel.find(filter).sort({deliveredAt: -1}).skip(skip).limit(limit);
  }
}