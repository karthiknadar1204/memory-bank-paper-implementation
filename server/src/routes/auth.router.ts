import { Hono } from "hono";
import { register, login, logout, getUser } from "../controllers/auth.controller";
const authRouter = new Hono();

authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/logout', logout);
authRouter.get('/user', getUser);
export default authRouter;