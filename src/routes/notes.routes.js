import { Router } from 'express';
import { createNote, listOwnNotes, getNote, updateNote, deleteNote } from '../controllers/notes.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { createNoteSchema, updateNoteSchema } from '../utils/noteSchemas.js';
import { parseObjectId } from '../utils/objectId.js';

export const notesRouter = Router();
notesRouter.use(authenticate);
notesRouter.post('/', validate(createNoteSchema), createNote);
notesRouter.get('/', listOwnNotes);
notesRouter.get('/:id', (req, _res, next) => {
  req.noteReadFilter = { _id: parseObjectId(req.params.id) };
  if (req.user.role !== 'admin') req.noteReadFilter.ownerId = req.user._id;
  next();
}, getNote);
notesRouter.patch('/:id', validate(updateNoteSchema), updateNote);
notesRouter.delete('/:id', deleteNote);
