import {FilterQuery} from 'mongoose';
import {NotificationModel} from '../../models/notifications/notification.model';
import {NotificationEntity} from './notification.entity';


export default class NotificationRepo {
  create(doc: NotificationEntity) {return NotificationModel.create(doc);}
  findById(id: string) {return NotificationModel.findById(id);}
  find(filter: FilterQuery<NotificationEntity>, limit = 50, skip = 0) {
    return NotificationModel.find(filter).sort({createdAt: -1}).skip(skip).limit(limit);
  }
}