import { Hono } from 'hono'
import authRouter from './routes/auth.router'
import { logger } from 'hono/logger'
const app = new Hono()


app.use(logger())
app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/health',(c)=>{
  return c.json({ status: 'ok', message: 'Server is running' })
})

app.route('/auth', authRouter);

export default { 
  port: 3004, 
  fetch: app.fetch, 
} 
