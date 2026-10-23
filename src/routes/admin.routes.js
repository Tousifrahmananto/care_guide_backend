import { Router } from 'express';
import { listAdminNotes } from '../controllers/notes.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { protectSelf } from '../middleware/adminGuard.js';
import { adminCreateSchema, adminUpdateSchema } from '../utils/userSchemas.js';
import { createUser, listUsers, getUser, updateUser, deleteUser } from '../controllers/admin.controller.js';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'));
adminRouter.get('/notes', listAdminNotes);
adminRouter.post('/users', validate(adminCreateSchema), createUser);
adminRouter.get('/users', listUsers);
adminRouter.get('/users/:id', getUser);
adminRouter.patch('/users/:id', validate(adminUpdateSchema), protectSelf, updateUser);
adminRouter.delete('/users/:id', protectSelf, deleteUser);
