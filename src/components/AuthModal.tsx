import React, { useState, useId, useEffect } from 'react';
import {
  X,
  LogIn,
  UserPlus,
  Mail,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Clock,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { validateOfficialEmail } from '../lib/emailValidation';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'signin' | 'signup';
  onSuccess?: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  initialMode = 'signin',
  onSuccess,
}) => {
  const {
    user,
    signInWithEmail,
    startOtpSignUp,
    signInWithGoogle,
    sendPasswordReset,
  } = useAuth();

  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>(initialMode);
  const [step, setStep] = useState<'form' | 'link_sent'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [timeLeft, setTimeLeft] = useState<number>(180);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const emailId = useId();
  const passwordId = useId();

  // Ensure modal always synchronizes to initialMode ('signin' or 'signup') when opened
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setStep('form');
      setError(null);
      setSuccessMsg(null);
      setTimeLeft(180);
      setLoading(false);
    }
  }, [isOpen, initialMode]);

  // When the confirmation link is clicked (in this tab or after the email
  // redirect), the Supabase session arrives and closes this dialog for us.
  useEffect(() => {
    if (isOpen && user) {
      onSuccess?.();
      onClose();
    }
  }, [user, isOpen]);

  useEffect(() => {
    if (step !== 'link_sent') return;
    setTimeLeft(180);
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [step]);

  if (!isOpen) return null;

  const emailValidation = email.trim().length > 0 ? validateOfficialEmail(email) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    // Validate email domain
    const validation = validateOfficialEmail(email);
    if (!validation.valid) {
      setError(validation.reason || 'Please provide an approved official email address.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'forgot') {
        await sendPasswordReset(email);
        setSuccessMsg(`Password reset link sent to ${email.trim()}. Please check your inbox.`);
      } else if (mode === 'signin') {
        if (!password) {
          setError('Please enter your password.');
          setLoading(false);
          return;
        }
        // Direct Free Sign-In with Email & Password (Zero external API keys needed!)
        await signInWithEmail(email, password);
        setSuccessMsg('Signed in successfully!');
        setTimeout(() => {
          onSuccess?.();
          onClose();
        }, 500);
      } else if (mode === 'signup') {
        if (!password || password.length < 6) {
          setError('Password must be at least 6 characters long.');
          setLoading(false);
          return;
        }
        // Creates the account. When email confirmation is enabled in Supabase,
        // a confirmation link is emailed and the account activates when the
        // user clicks it; when confirmation is disabled, signup completes instantly.
        const immediate = await startOtpSignUp(email, password);
        if (immediate) {
          setSuccessMsg('Account created — you are signed in!');
          setTimeout(() => {
            onSuccess?.();
            onClose();
          }, 600);
        } else {
          setStep('link_sent');
          setTimeLeft(180);
          setSuccessMsg(`A confirmation link was sent to ${email.trim()}. Open that email and click the link to activate your account.`);
        }
      }
    } catch (err: any) {
      let message = 'An unexpected authentication error occurred.';
      if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential') {
        message = 'Invalid email or password. Please verify your credentials or reset password.';
      } else if (err?.code === 'auth/user-not-found') {
        message = 'No account found with this email. Switch to "Create Account" below to register.';
      } else if (err?.code === 'auth/email-already-in-use') {
        message = 'An account already exists with this email. Switch to "Sign In" below.';
      } else if (err?.message) {
        message = err.message;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendLink = async () => {
    setError(null);
    setSuccessMsg(null);
    setLoading(true);
    try {
      // Supabase emails a fresh confirmation link for the pending signup.
      await startOtpSignUp(email, password);
      setTimeLeft(180);
      setSuccessMsg(`A new confirmation link has been sent to ${email.trim()}.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to resend the confirmation email.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
      onSuccess?.();
      onClose();
    } catch (err: any) {
      if (err?.code === 'auth/popup-closed-by-user') {
        return;
      }
      if (err?.code === 'auth/operation-not-allowed' || err?.code === 'auth/configuration-not-found') {
        setError('Google sign-in is currently unavailable. Please sign in with your email and password below.');
        return;
      }
      setError(err?.message || 'Failed to sign in with Google.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div className="modal-panel sm auth-modal-panel" style={{ maxWidth: 440, width: '92%' }}>
        {/* Header */}
        <div className="modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
          <div className="modal-heading" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: '8px',
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {step === 'link_sent' ? <Mail size={18} /> : mode === 'signup' ? <UserPlus size={18} /> : <LogIn size={18} />}
            </div>
            <div>
              <h2 id="auth-modal-title" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
                {step === 'link_sent'
                  ? 'Confirm Your Email'
                  : mode === 'signup'
                  ? 'Create Account'
                  : mode === 'forgot'
                  ? 'Reset Your Password'
                  : 'Sign In'}
              </h2>
              <span style={{ fontSize: 12, color: 'var(--secondary)' }}>
                {step === 'link_sent'
                  ? 'Click the link we emailed you to activate your account and sign in'
                  : mode === 'signup'
                  ? 'Pick an email and password — we\u2019ll email you a confirmation link'
                  : mode === 'forgot'
                  ? 'We will send a secure password reset link to your email'
                  : 'Sign in to access your saved LaTeX projects and cloud workspace'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={loading}
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        {/* Mode switcher tabs (if not forgot and not on the link-sent step) */}
        {mode !== 'forgot' && step === 'form' && (
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--line)',
              background: 'var(--surface)',
            }}
          >
            <button
              type="button"
              id="auth-tab-signin"
              style={{
                flex: 1,
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                borderBottom: mode === 'signin' ? '2px solid var(--accent)' : '2px solid transparent',
                color: mode === 'signin' ? 'var(--accent)' : 'var(--secondary)',
                fontWeight: mode === 'signin' ? 600 : 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
              onClick={() => {
                setMode('signin');
                setError(null);
                setSuccessMsg(null);
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              id="auth-tab-signup"
              style={{
                flex: 1,
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                borderBottom: mode === 'signup' ? '2px solid var(--accent)' : '2px solid transparent',
                color: mode === 'signup' ? 'var(--accent)' : 'var(--secondary)',
                fontWeight: mode === 'signup' ? 600 : 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
              onClick={() => {
                setMode('signup');
                setError(null);
                setSuccessMsg(null);
              }}
            >
              Create Account
            </button>
          </div>
        )}

        {/* Body */}
        <div className="modal-body" style={{ padding: '20px' }}>
          {/* Error banner */}
          {error && (
            <div
              id="auth-error-banner"
              style={{
                marginBottom: 14,
                padding: '8px 12px',
                borderRadius: 'var(--r-sm)',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                color: '#dc2626',
                fontSize: 12,
                lineHeight: 1.4,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
              }}
            >
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          {/* Success banner */}
          {successMsg && (
            <div
              id="auth-success-banner"
              style={{
                marginBottom: 14,
                padding: '8px 12px',
                borderRadius: 'var(--r-sm)',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                color: '#059669',
                fontSize: 12,
                lineHeight: 1.4,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
              }}
            >
              <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Social & Provider Logins (only on form signin/signup) */}
          {mode !== 'forgot' && step === 'form' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                <button
                  type="button"
                  id="btn-google-signin"
                  className="btn secondary"
                  style={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                  onClick={handleGoogleSignIn}
                  disabled={loading}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span>Continue with Google</span>
                </button>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  margin: '14px 0',
                  color: 'var(--secondary)',
                  fontSize: 12,
                }}
              >
                <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
                <span>or with email & password</span>
                <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              </div>
            </>
          )}

          {/* Confirmation-link step */}
          {step === 'link_sent' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ background: 'var(--surface-sunken)', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: 12, color: 'var(--secondary)', marginBottom: 2 }}>Link sent to:</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)', wordBreak: 'break-all' }}>{email}</div>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--secondary)', lineHeight: 1.5 }}>
                <Mail size={15} style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }} />
                <span>
                  Open the email and click the confirmation link — your account activates and you are signed in automatically.
                  Didn&apos;t get it? Check the spam folder.
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                <span style={{ fontSize: 11.5, color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Clock size={13} />
                  {timeLeft > 0 ? (
                    <>
                      Link valid for{' '}
                      <strong style={{ color: timeLeft < 30 ? '#dc2626' : 'var(--primary)' }}>
                        {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
                      </strong>
                    </>
                  ) : (
                    <strong style={{ color: '#dc2626' }}>Link expired — resend for a fresh one</strong>
                  )}
                </span>
                <button
                  type="button"
                  id="btn-resend-link"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                  onClick={handleResendLink}
                  disabled={loading}
                >
                  Resend Link
                </button>
              </div>

              <button
                type="button"
                className="btn quiet btn-sm"
                style={{ alignSelf: 'center', marginTop: 4 }}
                onClick={() => {
                  setStep('form');
                  setError(null);
                  setSuccessMsg(null);
                }}
              >
                Back to Sign In / Sign Up
              </button>
            </div>
          ) : (
            /* Form Step */
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Email field */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label
                    htmlFor={emailId}
                    style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--primary)' }}
                  >
                    Official Email Address
                  </label>
                  {emailValidation && (
                    <span
                      style={{
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        color: emailValidation.valid ? 'var(--positive, #10b981)' : 'var(--negative, #ef4444)',
                      }}
                    >
                      {emailValidation.valid ? (
                        <>
                          <CheckCircle2 size={12} />
                          <span>{emailValidation.providerName || 'Approved Domain'}</span>
                        </>
                      ) : (
                        <>
                          <AlertCircle size={12} />
                          <span>Restricted Domain</span>
                        </>
                      )}
                    </span>
                  )}
                </div>

                <div style={{ position: 'relative' }}>
                  <Mail
                    size={15}
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: 'var(--secondary)',
                    }}
                  />
                  <input
                    id={emailId}
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                    }}
                    style={{
                      width: '100%',
                      padding: '8px 12px 8px 34px',
                      borderRadius: 'var(--r-sm)',
                      border: '1px solid var(--line)',
                      background: 'var(--surface)',
                      color: 'var(--primary)',
                      fontSize: 13,
                    }}
                  />
                </div>

                {/* Domain restriction helper badge */}
                <div
                  style={{
                    marginTop: 6,
                    padding: '6px 8px',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--surface-sunken)',
                    border: '1px solid var(--line)',
                    fontSize: 11,
                    color: 'var(--secondary)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 6,
                    lineHeight: 1.4,
                  }}
                >
                  <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }} />
                  <span>
                    Only verified domains allowed: <strong>Gmail</strong>, <strong>Outlook</strong>,{' '}
                    <strong>Proton</strong>, <strong>iCloud</strong>, or official academic{' '}
                    <strong>.edu / .ac</strong> domains.
                  </span>
                </div>
              </div>

              {/* Password field (if not forgot) */}
              {mode !== 'forgot' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label
                      htmlFor={passwordId}
                      style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--primary)' }}
                    >
                      Password
                    </label>
                    {mode === 'signin' && (
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          fontSize: 11.5,
                          color: 'var(--accent)',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                        onClick={() => {
                          setMode('forgot');
                          setError(null);
                          setSuccessMsg(null);
                        }}
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>

                  <div style={{ position: 'relative' }}>
                    <Lock
                      size={15}
                      style={{
                        position: 'absolute',
                        left: 10,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: 'var(--secondary)',
                      }}
                    />
                    <input
                      id={passwordId}
                      type={showPassword ? 'text' : 'password'}
                      required
                      placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••'}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError(null);
                      }}
                      style={{
                        width: '100%',
                        padding: '8px 36px 8px 34px',
                        borderRadius: 'var(--r-sm)',
                        border: '1px solid var(--line)',
                        background: 'var(--surface)',
                        color: 'var(--primary)',
                        fontSize: 13,
                      }}
                    />
                    <button
                      type="button"
                      style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        color: 'var(--secondary)',
                        cursor: 'pointer',
                        padding: 4,
                        display: 'grid',
                        placeItems: 'center',
                      }}
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Submit button */}
              <button
                type="submit"
                id="btn-auth-submit"
                className="btn primary"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  padding: '9px 14px',
                  fontWeight: 600,
                  fontSize: 13.5,
                  marginTop: 4,
                }}
                disabled={loading}
              >
                {loading
                  ? mode === 'signup'
                    ? 'Creating Account…'
                    : mode === 'forgot'
                    ? 'Sending Reset Link…'
                    : 'Signing In…'
                  : mode === 'signup'
                  ? 'Create Account'
                  : mode === 'forgot'
                  ? 'Send Reset Link'
                  : 'Sign In'}
              </button>

              {/* Bottom switch between Sign In and Create Account */}
              {mode === 'signin' && (
                <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12.5, color: 'var(--secondary)' }}>
                  Don't have an account?{' '}
                  <button
                    type="button"
                    id="btn-switch-to-signup"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      fontWeight: 600,
                      color: 'var(--accent)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                    onClick={() => {
                      setMode('signup');
                      setError(null);
                      setSuccessMsg(null);
                    }}
                  >
                    Create Account
                  </button>
                </div>
              )}

              {mode === 'signup' && (
                <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12.5, color: 'var(--secondary)' }}>
                  Already have an account?{' '}
                  <button
                    type="button"
                    id="btn-switch-to-signin"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      fontWeight: 600,
                      color: 'var(--accent)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                    onClick={() => {
                      setMode('signin');
                      setError(null);
                      setSuccessMsg(null);
                    }}
                  >
                    Sign In
                  </button>
                </div>
              )}

              {/* Back to sign in option if in forgot mode */}
              {mode === 'forgot' && (
                <div style={{ textAlign: 'center', marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn quiet btn-sm"
                    onClick={() => {
                      setMode('signin');
                      setError(null);
                      setSuccessMsg(null);
                    }}
                  >
                    Back to Sign In
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
