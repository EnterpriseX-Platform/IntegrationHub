import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, User } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { DehLogo } from '../components/ui/DehLogo';
import { API_URL } from '../config/api';

declare const __APP_VERSION__: string;

export default function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
      <div className="bg-white rounded-xl border border-gray-200 w-full px-8 py-9">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <DehLogo size={40} className="shrink-0" />
          <div className="leading-tight">
            <h1 className="text-[18px] font-semibold text-gray-900">DEH</h1>
            <p className="text-[13px] text-gray-500">Data Exchange Hub</p>
          </div>
        </div>
        <h2 className="text-[16px] font-medium text-gray-900 mb-5">Sign in</h2>

        {/* Login Form */}
        <form onSubmit={handleLogin} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">
              Username
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-9 pr-3 h-10 text-[14px] border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                placeholder="admin"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-9 pr-10 h-10 text-[14px] border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <Button
            type="submit"
            fullWidth
            size="lg"
            className="!mt-6"
            isLoading={loading}
          >
            Sign In
          </Button>
        </form>

        {/* Version */}
      </div>
      <p className="text-center text-xs text-gray-400 mt-4">v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}
