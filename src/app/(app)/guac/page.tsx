'use client';

import { useEffect, useMemo, useState } from 'react';

export default function GuacPage() {
  const [status, setStatus] = useState<string>('Initializing...');
  const [token, setToken] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const guacBase = useMemo(() => {
    // Expose GUAC_PUBLIC_BASE for iframe only (must be public and reachable from browser)
    return process.env.NEXT_PUBLIC_GUAC_BASE_URL?.replace(/\/$/, '') || '';
  }, []);

  useEffect(() => {
    let cancelled = false;
    let created = false;
    async function run() {
      try {
        setStatus('Creating connection via server...');
        const resp = await fetch('/api/guacamole/create-connection', {
          method: 'POST',
        });
        const data = await resp.json();
        if (!resp.ok || data.error) {
          throw new Error(data.error || resp.statusText);
        }
        if (cancelled) return;
        setToken(data.token);
        const id =
          data.connection?.identifier || data.connection?.id || data.connection;
        setConnectionId(id);
        created = Boolean(data.created);
        setStatus('Ready');
      } catch (e: any) {
        setStatus(`Error: ${e.message}`);
      }
    }
    run();
    return () => {
      cancelled = true;
      // Best-effort cleanup if we created an ephemeral connection
      if (created && connectionId) {
        fetch('/api/guacamole/delete-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: connectionId }),
        }).catch(() => {});
      }
    };
  }, []);

  if (!guacBase) {
    return (
      <div className="container mx-auto py-10 text-red-600">
        Missing NEXT_PUBLIC_GUAC_BASE_URL
      </div>
    );
  }

  const src =
    token && connectionId
      ? `${guacBase}/#/client/${encodeURIComponent(
          connectionId
        )}?token=${encodeURIComponent(token)}`
      : null;

  return (
    <div className="container mx-auto py-6 space-y-4">
      <h1 className="text-2xl font-semibold">Guacamole RDP</h1>
      <p className="text-sm text-gray-600">{status}</p>
      {src ? (
        <iframe
          src={src}
          width="100%"
          height="800"
          style={{ border: 'none' }}
          allow="display-capture; fullscreen; microphone; camera; clipboard-write"
          allowFullScreen
        />
      ) : (
        <div className="w-full h-[800px] bg-gray-50 border rounded flex items-center justify-center text-gray-500">
          Waiting for connection...
        </div>
      )}
    </div>
  );
}
