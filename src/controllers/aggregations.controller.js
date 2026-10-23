import { User } from '../models/user.model.js';
import { Post } from '../models/post.model.js';
import { HttpError } from '../utils/HttpError.js';
import { parseObjectId } from '../utils/objectId.js';
import { parsePagination, pageResult } from '../utils/pagination.js';
import { interestSchema } from '../utils/userSchemas.js';

const queryInterestSchema = interestSchema.min(1).optional();

export function buildInterestPipeline({ pagination, memberLimit, interest, afterUserId }) {
  const matchInterest = interest === undefined ? [] : [{ $match: { interests: interest } }];
  return [
    ...matchInterest,
    { $unwind: '$interests' },
    ...matchInterest,
    { $group: { _id: '$interests', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $facet: {
      data: [
        { $skip: pagination.skip },
        { $limit: pagination.limit },
        { $lookup: {
          from: User.collection.name, localField: '_id', foreignField: 'interests',
          pipeline: [
            ...(afterUserId ? [{ $match: { _id: { $lt: afterUserId } } }] : []),
            { $sort: { _id: -1 } },
            { $limit: memberLimit + 1 },
            { $project: { _id: 1, name: 1 } },
          ],
          as: 'users',
        } },
      ],
      metadata: [{ $count: 'total' }],
    } },
  ];
}

export async function groupUsersByInterest(req, res) {
  const pagination = parsePagination(req.query);
  const memberLimit = parsePagination({ limit: req.query.memberLimit }).limit;
  const parsed = queryInterestSchema.safeParse(req.query.interest);
  if (!parsed.success) throw new HttpError(400, 'Invalid interest');
  const interest = parsed.data;
  const afterUserId = req.query.afterUserId === undefined ? undefined : parseObjectId(req.query.afterUserId);
  if (afterUserId && interest === undefined) throw new HttpError(400, 'interest is required with afterUserId');
  const [result] = await User.aggregate(buildInterestPipeline({ pagination, memberLimit, interest, afterUserId })).allowDiskUse(true);
  const data = result.data.map(({ _id: interest, count, users }) => {
    const hasMoreUsers = users.length > memberLimit;
    const members = users.slice(0, memberLimit);
    return { interest, count, users: members, hasMoreUsers, nextUserCursor: hasMoreUsers ? members.at(-1)._id : null };
  });
  res.json({ ...pageResult(data, result.metadata[0]?.total ?? 0, pagination), memberLimit });
}

export function buildUserPostsPipeline(userId, pagination) {
  return [
    { $match: { _id: userId } },
    { $lookup: {
      from: Post.collection.name, localField: '_id', foreignField: 'authorId',
      pipeline: [
        { $sort: { _id: -1 } },
        { $facet: {
          data: [
            { $skip: pagination.skip },
            { $limit: pagination.limit },
            { $project: { _id: 1, authorId: 1, title: 1, content: 1, createdAt: 1, updatedAt: 1 } },
          ],
          metadata: [{ $count: 'total' }],
        } },
      ],
      as: 'posts',
    } },
    { $project: { _id: 1, name: 1, posts: 1 } },
  ];
}

export async function listUserPosts(req, res) {
  const userId = parseObjectId(req.params.userId);
  const pagination = parsePagination(req.query);
  const [user] = await User.aggregate(buildUserPostsPipeline(userId, pagination));
  if (!user) throw new HttpError(404, 'User not found');
  const [posts] = user.posts;
  res.json({ ...pageResult(posts.data, posts.metadata[0]?.total ?? 0, pagination), author: { _id: user._id, name: user.name } });
}
