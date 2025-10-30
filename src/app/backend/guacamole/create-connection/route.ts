import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const baseUrl = process.env.GUAC_BASE_URL;
    const username = process.env.GUAC_USERNAME || 'guacadmin';
    const password = process.env.GUAC_PASSWORD || 'guacadmin';

    const rdpName = process.env.RDP_NAME || 'Windows VM';
    const rdpHost = process.env.RDP_HOSTNAME;
    const rdpPort = process.env.RDP_PORT || '3389';
    const rdpUser = process.env.RDP_USERNAME;
    const rdpPass = process.env.RDP_PASSWORD;

    if (!baseUrl)
      return NextResponse.json(
        { error: 'Missing GUAC_BASE_URL' },
        { status: 500 }
      );
    if (!rdpHost)
      return NextResponse.json(
        { error: 'Missing RDP_HOSTNAME' },
        { status: 500 }
      );
    if (!rdpUser)
      return NextResponse.json(
        { error: 'Missing RDP_USERNAME' },
        { status: 500 }
      );
    if (!rdpPass)
      return NextResponse.json(
        { error: 'Missing RDP_PASSWORD' },
        { status: 500 }
      );

    const base = baseUrl.replace(/\/$/, '');

    // 1) Login to get token
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

    // 2) Check for existing connection by name (idempotent behavior)
    const listResp = await fetch(
      `${base}/api/session/data/${encodeURIComponent(
        ds
      )}/connections?token=${encodeURIComponent(authToken)}`
    );
    if (!listResp.ok) {
      const text = await listResp.text();
      return NextResponse.json(
        { error: `List failed: ${text || listResp.statusText}` },
        { status: listResp.status }
      );
    }
    const listJson: unknown = await listResp.json();
    let existingId: string | null = null;
    if (listJson && typeof listJson === 'object') {
      for (const [key, value] of Object.entries(
        listJson as Record<string, unknown>
      )) {
        const v = value as { name?: string } | undefined;
        if (v?.name === rdpName) {
          existingId = key;
          break;
        }
      }
    }

    if (existingId) {
      return NextResponse.json({
        token: authToken,
        dataSource: ds,
        connection: { identifier: existingId, name: rdpName },
        created: false,
      });
    }

    // 3) Create connection (Guacamole expects token as query parameter)
    const createResp = await fetch(
      `${base}/api/session/data/${encodeURIComponent(
        ds
      )}/connections?token=${encodeURIComponent(authToken)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parentIdentifier: 'ROOT',
          name: rdpName,
          protocol: 'rdp',
          parameters: {
            hostname: rdpHost,
            port: String(rdpPort),
            username: rdpUser,
            password: rdpPass,
            security: 'any',
            'ignore-cert': 'true',
          },
          attributes: {},
        }),
      }
    );
    if (!createResp.ok) {
      const text = await createResp.text();
      return NextResponse.json(
        { error: `Create failed: ${text || createResp.statusText}` },
        { status: createResp.status }
      );
    }
    const created = await createResp.json();
    const createdId: string =
      (created && (created.identifier || created.id)) || String(created);

    return NextResponse.json({
      token: authToken,
      dataSource: ds,
      connection: { identifier: createdId, name: rdpName },
      created: true,
    });
  } catch (err: unknown) {
    console.log(err)
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message || 'Create connection error' },
      { status: 500 }
    );
  }
}


