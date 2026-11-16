import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tile, Form, Stack, TextInput, PasswordInput, InlineNotification } from '@carbon/react';
import { Button } from '../components/ui/Button';
import { DehLogo } from '../components/ui/DehLogo';
import { APP_NAME, APP_TAGLINE } from '../config/brand';
import { API_URL } from '../config/api';

declare const __APP_VERSION__: string;

export default function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (data.success) {
        // Store token and user info
        localStorage.setItem('token', data.data.token);
        localStorage.setItem('user', JSON.stringify(data.data.user));
        // Back to the page that sent us here (e.g. a shared File Explorer link), else the dashboard
        const from = (location.state as { from?: string } | null)?.from
          ?? new URLSearchParams(location.search).get('from') ?? undefined;
        navigate(from && from.startsWith('/') && !from.startsWith('/login') ? from : '/dashboard', { replace: true });
      } else {
        setError(data.error || 'Invalid credentials');
      }
    } catch (err) {
      setError('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
      <Tile className="w-full !px-8 !py-9">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <DehLogo size={40} className="shrink-0 text-gray-900" />
          <div className="leading-tight">
            <h1 className="text-[18px] font-semibold text-gray-900">{APP_NAME}</h1>
            {APP_TAGLINE && <p className="text-[13px] text-gray-500">{APP_TAGLINE}</p>}
          </div>
        </div>
        <h2 className="text-[16px] font-medium text-gray-900 mb-5">Sign in</h2>

        <Form onSubmit={handleLogin}>
          <Stack gap={6}>
            {error && (
              <InlineNotification kind="error" title={error} lowContrast hideCloseButton />
            )}
            <TextInput
              id="login-username"
              labelText="Username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              required
            />
            <PasswordInput
              id="login-password"
              labelText="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <Button type="submit" fullWidth size="lg" isLoading={loading}>
              Sign In
            </Button>
          </Stack>
        </Form>

        {/* Version */}
      </Tile>
      <p className="text-center text-xs text-gray-400 mt-4">v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}
