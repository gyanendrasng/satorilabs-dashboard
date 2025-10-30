import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const baseUrl = process.env.GUAC_BASE_URL;
    const username = process.env.GUAC_USERNAME || 'guacadmin';
    const password = process.env.GUAC_PASSWORD || 'guacadmin';

    if (!baseUrl) {
      return NextResponse.json(
        { error: 'Missing GUAC_BASE_URL' },
        { status: 500 }
      );
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/tokens`;

    const body = new URLSearchParams();
    body.set('username', username);
    body.set('password', password);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json(
        { error: `Login failed: ${text || resp.statusText}` },
        { status: resp.status }
      );
    }

    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Login error' },
      { status: 500 }
    );
  }
}


