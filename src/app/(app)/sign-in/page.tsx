import { Suspense } from 'react';
import { SignInForm } from '@/components/auth/sign-in-form';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Suspense fallback={<div>Loading...</div>}>
        <SignInForm />
      </Suspense>
    </div>
  );
}
