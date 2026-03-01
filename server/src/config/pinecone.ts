import { Pinecone } from '@pinecone-database/pinecone';

if (!process.env.PINECONE_API_KEY) {
  throw new Error('PINECONE_API_KEY environment variable is required');
}

if (!process.env.PINECONE_INDEX) {
  throw new Error('PINECONE_INDEX environment variable is required');
}

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

export const index = pc.index(process.env.PINECONE_INDEX);