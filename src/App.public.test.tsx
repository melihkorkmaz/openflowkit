import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useParams } from 'react-router-dom';
import App from './App';

vi.mock('@/services/storage/v2/serverStorage', () => ({ serverStorage: { apiUrl: '/api', clerkPublishableKey: 'test' } }));
vi.mock('@/opencanvas/presentation/v2/V2AuthGate', () => ({
  V2AuthGate: () => <div>Sign in required</div>,
}));
vi.mock('@/opencanvas/presentation/v2/V2PublicPage', () => ({
  V2PublicPage: () => <div>Public diagram: {useParams().slug}</div>,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('anonymous public routing with signed-in storage', () => {
  it.each(['/p/shared-diagram', '/#/p/shared-diagram'])(
    'opens %s without the sign-in gate, including after reload', async (url) => {
      window.history.replaceState(null, '', url);
      const first = render(<App />);
      await screen.findByText('Public diagram: shared-diagram');
      expect(screen.queryByText('Sign in required')).toBeNull();
      expect(window.location.pathname + window.location.hash).toBe(url);
      first.unmount();
      render(<App />);
      await screen.findByText('Public diagram: shared-diagram');
    },
  );

  it('keeps owner routes behind sign-in', async () => {
    window.history.replaceState(null, '', '/#/home');
    render(<App />);
    await screen.findByText('Sign in required');
    expect(screen.queryByText(/Public diagram/)).toBeNull();
  });
});
