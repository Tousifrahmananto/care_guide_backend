import { User } from '../models/user.model.js';
import { HttpError } from '../utils/HttpError.js';
import { userView } from '../utils/userView.js';

export function getMe(req, res) {
  res.json({ data: userView(req.user) });
}

export async function updateMe(req, res) {
  const user = await User.findOneAndUpdate({ _id: req.user._id }, { $set: req.body }, {
    returnDocument: 'after', runValidators: true,
  }).lean();
  if (!user) throw new HttpError(401, 'Missing or invalid token');
  res.json({ data: userView(user) });
}
