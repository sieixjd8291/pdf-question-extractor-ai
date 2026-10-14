import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { validateOfficialEmail } from '../lib/emailValidation';
import { deleteCloudWorkspace, provisionCloudWorkspace } from '../lib/workspaceCloudSync';
import { loadWorkspace } from '../lib/latexProjects';

export interface AppUser {
  uid: string;
  email: string | null;
  displayName?: string | null;
  emailVerified?: boolean;
}

interface AuthContextType {
  user: AppUser | User | null;
  loading: boolean;
  /** Existing account + password. Never creates an account. */
  signInWithEmail: (email: string, pass: string) => Promise<void>;
  /**
   * Signup: creates the account. Returns true when the session started
   * immediately (email confirmation disabled in Supabase — no OTP at all);
   * returns false when a 6-digit code was emailed and must be verified first.
   */
  startOtpSignUp: (email: string, pass: string) => Promise<boolean>;
  /** Sign-in step 1: email a 6-digit code to an EXISTING account only. */
  startOtpSignIn: (email: string) => Promise<void>;
  /** Step 2 for both flows: verify the code; on success the session starts. */
  verifyOtpCode: (email: string, otp: string, purpose: 'signup' | 'email') => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  validateEmailDomain: typeof validateOfficialEmail;
}

const SESSION_KEY = 'pdf_studio_user_session';

function getStoredSession(): AppUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveStoredSession(user: AppUser | null) {
  try {
    if (user) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

function appUserFrom(supabaseUser: User): AppUser | null {
  if (!supabaseUser.email) return null;
  const meta = (supabaseUser.user_metadata ?? {}) as Record<string, unknown>;
  const displayName =
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    null;
  return {
    uid: supabaseUser.id,
    email: supabaseUser.email,
    displayName,
    emailVerified: Boolean(supabaseUser.email_confirmed_at || supabaseUser.confirmed_at),
  };
}

/**
 * Translates Supabase auth errors into clear, user-facing messages.
 * The key rule of the login system: sign-in only succeeds for accounts that
 * actually exist — a missing account or wrong password always throws.
 */
function describeAuthError(err: unknown): Error {
  const msg = String((err as { message?: string })?.message || err || '');
  const rules: Array<[RegExp, string]> = [
    [/invalid login credentials/i, 'Incorrect email or password — or no account exists for this email. New here? Use Sign Up.'],
    [/email ?not ?confirmed/i, 'This email is not verified yet. Use "Create Account" to receive a fresh verification code, or sign in with the OTP option.'],
    [/user already registered|already been registered|already exists/i, 'An account with this email already exists. Please sign in instead.'],
    [/signups? not allowed/i, 'New sign-ups are currently disabled on the authentication server.'],
    [/rate limit|too many/i, 'Too many emails or attempts right now — please wait a few minutes and try again.'],
    [/otp ?expired|expired/i, 'The code has expired (3 minutes passed). Please request a new one.'],
    [/invalid otp|invalid token|invalid claim|token has? ?been/i, 'Invalid code. Please check the 6-digit code, or request a new one.'],
    [/failed to fetch|network|fetch failed/i, 'Network error — check your connection (or disable your ad-blocker for this site) and try again.'],
    [/provider (is )?not (enabled|supported)|unsupported provider/i, 'Google sign-in is not enabled yet on the authentication server.'],
    [/popup|user cancelled|closed/i, 'Sign-in was interrupted before finishing. Please try again.'],
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(msg)) return new Error(message);
  }
  return new Error(msg || 'Authentication failed. Please try again.');
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Optimistic UI only: the Supabase session is the single source of truth,
  // and the onAuthStateChange listener below overrides this as soon as it fires.
  const [user, setUser] = useState<AppUser | null>(() => getStoredSession());
  const [loading, setLoading] = useState(true);

  const adoptSession = (session: Session | null) => {
    const supabaseUser = session?.user;
    const appUser = supabaseUser ? appUserFrom(supabaseUser) : null;
    if (appUser) {
      setUser(appUser);
      saveStoredSession(appUser);
    } else {
      // No real session (signed out or stale local blob) → signed out.
      // Never resurrect fake sessions.
      setUser(null);
      saveStoredSession(null);
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      adoptSession(data.session);
      setLoading(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      adoptSession(session);
      setLoading(false);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const validate = (email: string) => {
    const validation = validateOfficialEmail(email);
    if (!validation.valid) {
      throw new Error(validation.reason || 'Invalid email domain.');
    }
    return email.trim().toLowerCase();
  };

  /** After a confirmed session, hand the app user state + provision cloud space. */
  const finishSignIn = (appUser: AppUser) => {
    setUser(appUser);
    saveStoredSession(appUser);
    provisionCloudWorkspace(appUser.uid, appUser.email, loadWorkspace())
      .catch((err) => console.warn('Cloud workspace provisioning skipped:', err));
  };

  const signInWithEmail = async (email: string, pass: string) => {
    const cleanEmail = validate(email);
    if (!pass) throw new Error('Please enter your password.');
    const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pass });
    if (error) throw describeAuthError(error);
    const appUser = data.user ? appUserFrom(data.user) : null;
    if (appUser) finishSignIn(appUser);
  };

  const startOtpSignUp = async (email: string, pass: string) => {
    const cleanEmail = validate(email);
    if (!pass || pass.length < 6) {
      throw new Error('Password must be at least 6 characters long.');
    }
    const { data, error } = await supabase.auth.signUp({
      email: cleanEmail,
      password: pass,
      // Where the emailed confirmation link brings the user back to.
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) throw describeAuthError(error);

    // Anti-enumeration trick: an already-registered user comes back with an
    // empty `identities` array. Tell the user honestly instead of pretending
    // a code was sent (no email goes out for existing confirmed accounts).
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('An account with this email already exists. Please sign in instead.');
    }

    // If the project doesn't require email confirmation, the session is live
    // immediately — adopt it and report "no OTP needed". Otherwise the
    // 6-digit code email is on its way.
    if (data.session) {
      const appUser = data.user ? appUserFrom(data.user) : null;
      if (appUser) finishSignIn(appUser);
      return true;
    }
    return false;
  };

  const startOtpSignIn = async (email: string) => {
    const cleanEmail = validate(email);
    // shouldCreateUser: false — the OTP sign-in flow can NEVER create an
    // account; accounts are only created through the verified signup flow.
    const { error } = await supabase.auth.signInWithOtp({
      email: cleanEmail,
      options: { shouldCreateUser: false },
    });
    if (error) throw describeAuthError(error);
  };

  const verifyOtpCode = async (email: string, otp: string, purpose: 'signup' | 'email') => {
    const cleanEmail = validate(email);
    if (!otp || otp.trim().length !== 6) {
      throw new Error('Please enter the 6-digit code from your email.');
    }
    const { data, error } = await supabase.auth.verifyOtp({
      email: cleanEmail,
      token: otp.trim(),
      type: purpose,
    });
    if (error) throw describeAuthError(error);
    const appUser = data.user ? appUserFrom(data.user) : null;
    if (appUser) finishSignIn(appUser);
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw describeAuthError(error);
    // The session arrives via redirect — onAuthStateChange adopts it.
  };

  const signOut = async () => {
    saveStoredSession(null);
    setUser(null);
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore sign out errors
    }
  };

  const deleteAccount = async () => {
    const currentUid = user?.uid;

    // 1. Delete the user's cloud workspace rows (RLS: owner only).
    if (currentUid) {
      try {
        await deleteCloudWorkspace(currentUid);
      } catch (err) {
        console.warn('Error deleting cloud workspace during account deletion:', err);
      }
    }

    // 2. Wipe all local storage credentials & cached data
    try {
      saveStoredSession(null);
      if (currentUid) {
        localStorage.removeItem(`pdf_studio_cloud_backup_${currentUid}`);
      }
      localStorage.removeItem('pdf_studio_latex_workspace_v2');
      localStorage.removeItem('pdf_studio_chapter_draft');
      localStorage.removeItem('pdf_studio_recent_files');
      localStorage.removeItem('pdf-studio-activity-v1');

      // Thoroughly clear any user-specific localStorage entries
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('pdf_studio_') || key.startsWith('sb-') || (currentUid && key.includes(currentUid)))) {
          localStorage.removeItem(key);
        }
      }
    } catch (err) {
      console.warn('Error clearing local storage:', err);
    }

    // 3. Sign out and reset UI state. (The auth record itself can only be
    // removed from the Supabase dashboard — the anon key cannot delete users.)
    try {
      await supabase.auth.signOut();
    } catch { /* ignore */ }
    setUser(null);
    saveStoredSession(null);
  };

  const sendPasswordReset = async (email: string) => {
    const cleanEmail = validate(email);
    const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo: window.location.origin,
    });
    if (error) throw describeAuthError(error);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signInWithEmail,
        startOtpSignUp,
        startOtpSignIn,
        verifyOtpCode,
        signInWithGoogle,
        signOut,
        deleteAccount,
        sendPasswordReset,
        validateEmailDomain: validateOfficialEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
