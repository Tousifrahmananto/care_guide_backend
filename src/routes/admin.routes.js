import { Router } from 'express';
import { listAdminNotes } from '../controllers/notes.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/requireRole.js';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'));
adminRouter.get('/notes', listAdminNotes);
