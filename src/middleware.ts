import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Define protected routes
  const protectedRoutes = ['/dashboard', '/guac', '/train'];
  const isProtectedRoute = protectedRoutes.some((route) =>
    pathname.startsWith(route)
  );

  // Allow public routes
  if (
    !isProtectedRoute ||
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/sign-up')
  ) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionToken = request.cookies.get('better-auth.session_token');

  if (!sessionToken) {
    // No session token, redirect to sign-in
    const signInUrl = new URL('/sign-in', request.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Verify session with Better Auth API
  try {
    const response = await fetch(
      new URL('/backend/auth/get-session', request.url),
      {
        headers: {
          cookie: request.headers.get('cookie') || '',
        },
      }
    );

    if (!response.ok) {
      // Invalid session, redirect to sign-in
      const signInUrl = new URL('/sign-in', request.url);
      signInUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(signInUrl);
    }

    const session = await response.json();

    if (!session || !session.user) {
      // No valid session, redirect to sign-in
      const signInUrl = new URL('/sign-in', request.url);
      signInUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(signInUrl);
    }

    // Valid session, allow access
    return NextResponse.next();
  } catch (error) {
    console.error('Middleware auth check failed:', error);
    // On error, redirect to sign-in to be safe
    const signInUrl = new URL('/sign-in', request.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }
}

export const config = {
  matcher: [],
};
