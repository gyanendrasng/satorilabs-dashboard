'use client';

import { useRouter } from 'next/navigation';
import { TrainingList } from '@/components/training/TrainingList';

interface TrainingSession {
  id: string;
  title: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    content: string;
    role: string;
    createdAt: string;
  }>;
}

export default function TrainPage() {
  const router = useRouter();

  const handleSelectSession = (session: TrainingSession) => {
    // Navigate to the session page
    router.push(`/train/${session.id}`);
  };

  const handleCreateSession = async () => {
    try {
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'New Training Session',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create session');
      }

      const data = await response.json();

      // Navigate to the new session
      router.push(`/train/${data.chat.id}`);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  return (
    <div className="container mx-auto py-6">
      <div className="max-w-4xl mx-auto">
        <div className="rounded-lg border">
          <TrainingList
            onSelectSession={handleSelectSession}
            onCreateSession={handleCreateSession}
          />
        </div>
      </div>
    </div>
  );
}
