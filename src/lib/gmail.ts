import { google } from 'googleapis';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground' // Redirect URL for token generation
);

// Set credentials with refresh token
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

export const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

/**
 * Creates a MIME message with PDF attachment
 */
export function createMimeMessage(
  to: string,
  subject: string,
  body: string,
  attachment: {
    filename: string;
    content: Buffer;
    mimeType: string;
  }
): string {
  const boundary = 'boundary_' + Date.now().toString(16);

  const mimeMessage = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
    '',
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    attachment.content.toString('base64'),
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Send an email with attachment
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  attachment: {
    filename: string;
    content: Buffer;
    mimeType: string;
  }
): Promise<{ messageId: string; threadId: string }> {
  const raw = createMimeMessage(to, subject, body, attachment);

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
    },
  });

  if (!response.data.id || !response.data.threadId) {
    throw new Error('Failed to send email: missing message or thread ID');
  }

  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
  };
}

/**
 * Send a plain text email (no attachments)
 */
export async function sendPlainEmail(
  to: string,
  subject: string,
  body: string
): Promise<{ messageId: string; threadId: string }> {
  const mimeMessage = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');

  const raw = Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  if (!response.data.id || !response.data.threadId) {
    throw new Error('Failed to send plain email: missing message or thread ID');
  }

  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
  };
}

/**
 * Get the RFC 822 Message-ID header from a Gmail message (needed for In-Reply-To)
 */
export async function getMessageRfc822Id(gmailMessageId: string): Promise<string | null> {
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: gmailMessageId,
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  });
  const header = message.data.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === 'message-id'
  );
  return header?.value || null;
}

/**
 * Send a plain text email as a reply in an existing thread
 */
export async function sendReplyEmail(
  to: string,
  subject: string,
  body: string,
  threadId: string,
  inReplyToRfc822Id: string
): Promise<{ messageId: string; threadId: string }> {
  const mimeMessage = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyToRfc822Id}`,
    `References: ${inReplyToRfc822Id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');

  const raw = Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });

  if (!response.data.id || !response.data.threadId) {
    throw new Error('Failed to send reply email: missing message or thread ID');
  }

  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
  };
}

/**
 * Extract HTML or text body from a Gmail message
 */
export async function getMessageBody(messageId: string): Promise<string> {
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
  });

  const payload = message.data.payload;
  if (!payload) return '';

  // Recursively search parts for text/html, fall back to text/plain
  type GmailParts = NonNullable<typeof payload>['parts'];
  function findBody(
    parts: GmailParts,
    mimeType: string
  ): string | null {
    if (!parts) return null;
    for (const part of parts) {
      if (part.mimeType === mimeType && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) {
        const found = findBody(part.parts, mimeType);
        if (found) return found;
      }
    }
    return null;
  }

  // Check if body is directly on payload (no parts)
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Search parts: prefer HTML, fall back to plain text
  const html = findBody(payload.parts, 'text/html');
  if (html) return html;

  const plain = findBody(payload.parts, 'text/plain');
  if (plain) return plain;

  return '';
}

/**
 * List recent messages matching a query (e.g. newer_than:1d, from:branch@example.com)
 */
export async function listMessages(
  query: string,
  maxResults: number = 20
): Promise<Array<{ id: string; threadId: string }>> {
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  return (response.data.messages || []).map((m) => ({
    id: m.id!,
    threadId: m.threadId!,
  }));
}

/**
 * Get the subject of a Gmail message
 */
export async function getMessageSubject(messageId: string): Promise<string> {
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Subject'],
  });

  const subjectHeader = message.data.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === 'subject'
  );
  return subjectHeader?.value || '';
}

/**
 * Get messages in a thread
 */
export async function getThreadMessages(threadId: string) {
  const response = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
  });

  return response.data.messages || [];
}

/**
 * Get attachment from a message
 */
export async function getAttachment(
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  if (!response.data.data) {
    throw new Error('Failed to get attachment data');
  }

  // Gmail returns base64url encoded data
  const base64Data = response.data.data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Extract PDF attachments from a message
 */
export async function extractPdfAttachments(
  messageId: string
): Promise<Array<{ filename: string; content: Buffer }>> {
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
  });

  const parts = message.data.payload?.parts || [];
  const attachments: Array<{ filename: string; content: Buffer }> = [];

  for (const part of parts) {
    if (
      part.filename &&
      part.filename.toLowerCase().endsWith('.pdf') &&
      part.body?.attachmentId
    ) {
      const content = await getAttachment(messageId, part.body.attachmentId);
      attachments.push({
        filename: part.filename,
        content,
      });
    }
  }

  return attachments;
}
