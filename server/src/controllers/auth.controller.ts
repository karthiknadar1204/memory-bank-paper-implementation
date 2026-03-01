import { Context } from "hono";
import { db } from "../config/db";
import { users } from "../config/schema";
import { eq } from "drizzle-orm";
import * as bcryptjs from "bcryptjs";
import { decode, sign, verify } from 'hono/jwt'
import {
    deleteCookie,
    getCookie,
    getSignedCookie,
    setCookie,
    setSignedCookie,
    generateCookie,
    generateSignedCookie,
  } from 'hono/cookie'

export const register = async (c: Context) => {
  const { name, email, password } = await c.req.json();
  if(!email||!password||!name){
    return c.json({ error: 'All fields are required' }, 400);
  }
  const hashedPassword = await bcryptjs.hashSync(password, 10);
  const existingUser = await db.select().from(users).where(eq(users.email, email));
  if (existingUser.length > 0) {
    return c.json({ error: 'User already exists' }, 400);
  }
  const user = await db.insert(users).values({ name, email, password: hashedPassword }).returning();
  return c.json(user);
};


export const login=async(c:Context)=>{
    const { email, password } = await c.req.json();
    if(!email||!password){
        return c.json({ error: 'All fields are required' }, 400);
    }
    const user = await db.select().from(users).where(eq(users.email, email));
    if (user.length === 0) {
        return c.json({ error: 'User not found' }, 404);
    }
    const isPasswordValid = bcryptjs.compareSync(password, user[0].password);
    if (!isPasswordValid) {
        return c.json({ error: 'Invalid password' }, 401);
    }
    //create payload for jwt token:https://hono.dev/docs/helpers/jwt#sign
    const payload = {
        id: user[0].id,
        email: user[0].email,
    };
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        return c.json({ error: 'Server misconfiguration: JWT_SECRET not set' }, 500);
    }
    const token = await sign(payload, secret);

    //set cookie for jwt token:https://hono.dev/docs/helpers/cookie#regular-cookies
    setCookie(c, 'token', token, {
        httpOnly: true,
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
        sameSite: 'Lax',
    });
    return c.json({ message: 'Login successful' }, 200);
}

export const logout=async(c:Context)=>{
    // delete cookie https://hono.dev/docs/helpers/cookie#deletecookie
    deleteCookie(c, 'token');
    return c.json({ message: 'Logout successful' }, 200);
}

export const getUser = async (c: Context) => {
    try {
        
        const token = getCookie(c, 'token');
        if (!token) {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        const secret = process.env.JWT_SECRET;
        if (!secret) {
            return c.json({ error: 'Server misconfiguration: JWT_SECRET not set' }, 500);
        }
        let decoded: any;
        try {
            decoded = await verify(token, secret, 'HS256');
        } catch (err) {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        if (!decoded?.id) {
            return c.json({ error: 'Invalid token payload' }, 401);
        }

        const user = await db.select().from(users).where(eq(users.id, decoded.id as number));
        if (!user || user.length === 0) {
            return c.json({ error: 'User not found' }, 404);
        }

        const { password, ...userWithoutPassword } = user[0] as any;

        return c.json(userWithoutPassword, 200);
    } catch (e) {
        return c.json({ error: 'Internal server error' }, 500);
    }
};