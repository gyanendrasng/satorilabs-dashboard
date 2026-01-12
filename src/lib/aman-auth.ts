import { NextResponse } from 'next/server';

const AMAN_API_KEY = process.env.AMAN_API_KEY;

export function validateAmanApiKey(request: Request): { valid: boolean; error?: NextResponse } {
  const apiKey = request.headers.get('x-api-key');

  if (!AMAN_API_KEY) {
    console.error('[Aman Auth] AMAN_API_KEY not configured in environment');
    return {
      valid: false,
      error: NextResponse.json(
        { error: 'API not configured' },
        { status: 500 }
      ),
    };
  }

  if (!apiKey) {
    return {
      valid: false,
      error: NextResponse.json(
        { error: 'Missing API key. Provide x-api-key header.' },
        { status: 401 }
      ),
    };
  }

  if (apiKey !== AMAN_API_KEY) {
    return {
      valid: false,
      error: NextResponse.json(
        { error: 'Invalid API key' },
        { status: 403 }
      ),
    };
  }

  return { valid: true };
}
