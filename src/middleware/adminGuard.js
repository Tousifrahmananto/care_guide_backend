import { User } from '../models/user.model.js';
import { HttpError } from '../utils/HttpError.js';
import { parseObjectId } from '../utils/objectId.js';

export function protectSelf(req, _res, next) {
  req.targetUserId = parseObjectId(req.params.id);
  if (req.targetUserId.equals(req.user._id) && (req.method === 'DELETE' || req.body.role === 'user')) {
    throw new HttpError(409, 'You cannot delete or demote yourself');
  }
  next();
}

export async function authorizeAdminMutation(actorId, session, targetId = actorId) {
  const actor = String(actorId);
  // Consistent parent-write order prevents opposing Admin actions from locking accounts in reverse order.
  const ids = [...new Set([actor, String(targetId)])].sort();
  for (const id of ids) {
    const isActor = id === actor;
    const filter = isActor ? { _id: id, role: 'admin' } : { _id: id };
    const result = await User.updateOne(filter, { $inc: { __v: 1 } }, { session });
    if (result.matchedCount !== 1) {
      throw new HttpError(isActor ? 403 : 404, isActor ? 'Admin access changed' : 'User not found');
    }
  }
}
