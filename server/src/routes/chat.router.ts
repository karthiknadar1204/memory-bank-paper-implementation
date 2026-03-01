import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware';
import { postChat } from '../controllers/chat.controller';

const chatRouter = new Hono();

chatRouter.post('/chat', authMiddleware, postChat);

export default chatRouter;
