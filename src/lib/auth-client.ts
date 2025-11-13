import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: 'https://app.satorilabs.tech',
  basePath: '/backend/auth',
});

export const { signIn, signUp, signOut, useSession } = authClient;
