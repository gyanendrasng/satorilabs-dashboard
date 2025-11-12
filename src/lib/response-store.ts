// Shared in-memory store for managing AI response generation status
// This store is shared across API routes for long polling

export type ResponseData = {
  status: 'pending' | 'generating' | 'complete' | 'error';
  chunks: string[];
  fullResponse: string;
  error?: string;
};

export const responseStore = new Map<string, ResponseData>();

// Helper to generate dummy AI response character by character
export async function generateDummyResponse(
  responseId: string,
  userMessage: string
) {
  const responses = [
    `I understand you're asking about "${userMessage}". As a training assistant, I can help guide you through the process.`,
    `That's a great question about "${userMessage}"! Let me break this down for you step by step.`,
    `Regarding "${userMessage}", here are some key points to consider...`,
    `Thanks for asking about "${userMessage}". I'm here to help with your training!`,
  ];

  const fullResponse =
    responses[Math.floor(Math.random() * responses.length)];

  // Update status to generating
  responseStore.set(responseId, {
    status: 'generating',
    chunks: [],
    fullResponse: '',
  });

  // Simulate character-by-character generation
  const words = fullResponse.split(' ');
  let accumulated = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    accumulated += (i > 0 ? ' ' : '') + word;

    const current = responseStore.get(responseId);
    if (current) {
      current.chunks.push(word);
      current.fullResponse = accumulated;
      responseStore.set(responseId, current);
    }

    // Simulate typing delay (50-200ms per word)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * 150 + 50)
    );
  }

  // Mark as complete
  const final = responseStore.get(responseId);
  if (final) {
    final.status = 'complete';
    responseStore.set(responseId, final);
  }

  // Cleanup after 5 minutes
  setTimeout(() => {
    responseStore.delete(responseId);
  }, 5 * 60 * 1000);
}





