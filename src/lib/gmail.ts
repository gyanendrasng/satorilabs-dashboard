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
