import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { identifier } = await request.json();
    if (!identifier) {
      return NextResponse.json(
        { error: 'Missing identifier' },
        { status: 400 }
      );
    }

    const baseUrl = process.env.GUAC_BASE_URL;
    const username = process.env.GUAC_USERNAME || 'guacadmin';
    const password = process.env.GUAC_PASSWORD || 'guacadmin';
    if (!baseUrl) {
      return NextResponse.json(
        { error: 'Missing GUAC_BASE_URL' },
        { status: 500 }
      );
    }
    const base = baseUrl.replace(/\/$/, '');

    // Login
    const tokenResp = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      return NextResponse.json(
        { error: `Auth failed: ${text || tokenResp.statusText}` },
        { status: tokenResp.status }
      );
    }
    const { authToken, dataSource } = await tokenResp.json();
    const ds = dataSource || 'mysql';

    // Delete connection
    const delResp = await fetch(
      `${base}/api/session/data/${encodeURIComponent(
        ds
      )}/connections/${encodeURIComponent(
        identifier
      )}?token=${encodeURIComponent(authToken)}`,
      {
        method: 'DELETE',
      }
    );
    if (!delResp.ok) {
      const text = await delResp.text();
      return NextResponse.json(
        { error: `Delete failed: ${text || delResp.statusText}` },
        { status: delResp.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message || 'Delete error' },
      { status: 500 }
    );
  }
}
