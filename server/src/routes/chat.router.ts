import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware';
import { postChat, postIngest } from '../controllers/chat.controller';

const chatRouter = new Hono();

chatRouter.post('/chat', authMiddleware, postChat);
chatRouter.post('/ingest', authMiddleware, postIngest);

export default chatRouter;
