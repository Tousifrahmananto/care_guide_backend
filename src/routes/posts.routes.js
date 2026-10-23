import { Router } from 'express';
import { createPost, listPosts } from '../controllers/posts.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { createPostSchema } from '../utils/noteSchemas.js';
import { listUserPosts } from '../controllers/aggregations.controller.js';

export const postsRouter = Router();
postsRouter.get('/', listPosts);
postsRouter.get('/by-user/:userId', listUserPosts);
postsRouter.post('/', authenticate, validate(createPostSchema), createPost);
