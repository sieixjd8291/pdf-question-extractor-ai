import React, { useEffect, useRef, useState } from 'react';
import {
  User as UserIcon,
  LogOut,
  X,
  ShieldCheck,
  Mail,
  CheckCircle2,
  Trash2,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { validateOfficialEmail } from '../lib/emailValidation';
import { ConfirmDialog } from './ConfirmDialog';

interface UserProfileProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export const UserProfile: React.FC<UserProfileProps> = ({ isOpen, onClose }) => {
  const { user, signOut, deleteAccount } = useAuth();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setShowDeleteConfirm(false);
      setIsDeleting(false);
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (showDeleteConfirm) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (showDeleteConfirm) return;
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, showDeleteConfirm]);

  if (!isOpen || !user) return null;

  const email = user.email || 'user@official.domain';
  const initial = email[0]?.toUpperCase() || 'U';
  const validation = validateOfficialEmail(email);

  const handleSignOut = async () => {
    try {
      await signOut();
      onClose();
    } catch (err) {
      console.error('Failed to sign out:', err);
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await deleteAccount();
      setShowDeleteConfirm(false);
      onClose();
    } catch (err) {
      console.error('Failed to delete account:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  // Determine provider name and brand styling
  const providerId = (user as any).providerData?.[0]?.providerId;
  let providerLabel = validation.providerName || 'Official Domain';
  if (providerId === 'google.com') providerLabel = 'Google Account';
  else if (providerId === 'microsoft.com') providerLabel = 'Microsoft / Outlook';
  else if (providerId === 'github.com') providerLabel = 'GitHub';
  else if (email.includes('proton')) providerLabel = 'Proton Mail (Encrypted)';

  return (
    <div
      className="modal-backdrop"
      style={{
        background: 'rgba(0, 0, 0, 0.35)',
        backdropFilter: 'blur(2px)',
        zIndex: 100,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-profile-title"
    >
      <div
        ref={menuRef}
        className="modal-panel sm user-profile-panel"
        style={{
          maxWidth: 380,
          width: '92%',
          animation: 'fadeIn 0.15s ease',
        }}
      >
        {/* Header */}
        <div
          className="modal-header"
          style={{
            padding: '16px 18px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserIcon size={17} color="var(--accent)" />
            <h3 id="user-profile-title" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              User Profile
            </h3>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close user profile"
            style={{ width: 28, height: 28 }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Profile Content */}
        <div className="modal-body" style={{ padding: '20px' }}>
          {/* Avatar & Identity Box */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 14px',
              borderRadius: 'var(--r-md)',
              background: 'var(--surface-sunken)',
              border: '1px solid var(--line)',
              marginBottom: 16,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--accent) 0%, #6366f1 100%)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 18,
                fontWeight: 700,
                flexShrink: 0,
                boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
              }}
            >
              {initial}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'var(--primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={email}
              >
                {email}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  marginTop: 2,
                }}
              >
                <ShieldCheck size={13} color="var(--positive, #10b981)" />
                <span>{providerLabel}</span>
              </div>
            </div>
          </div>

          {/* Account Status Details */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontSize: 12,
              color: 'var(--secondary)',
              marginBottom: 20,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 10px',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={13} color="var(--positive, #10b981)" />
                Cloud Synchronization
              </span>
              <span style={{ fontWeight: 600, color: 'var(--positive, #10b981)' }}>Active</span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 10px',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Mail size={13} />
                Domain Status
              </span>
              <span style={{ fontWeight: 500, color: 'var(--primary)' }}>
                {validation.valid ? 'Approved Official' : 'Registered'}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              id="btn-profile-signout"
              className="btn secondary"
              style={{
                width: '100%',
                justifyContent: 'center',
                padding: '9px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                fontWeight: 500,
              }}
              onClick={handleSignOut}
            >
              <LogOut size={15} />
              <span>Sign Out</span>
            </button>

            <button
              type="button"
              id="btn-profile-delete-account"
              className="btn quiet"
              style={{
                width: '100%',
                justifyContent: 'center',
                padding: '8px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                fontWeight: 500,
                color: 'var(--danger, #ef4444)',
                marginTop: 4,
                border: '1px solid rgba(239, 68, 68, 0.2)',
                background: 'rgba(239, 68, 68, 0.04)',
              }}
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isDeleting}
            >
              {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              <span>{isDeleting ? 'Deleting Account…' : 'Delete Account & Cloud Data'}</span>
            </button>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Permanently Delete Account?"
          message={`Are you sure you want to delete your account (${email})? All stored projects, LaTeX documents, and cloud synchronization files will be permanently deleted immediately. This action cannot be undone.`}
          confirmLabel={isDeleting ? 'Deleting…' : 'Yes, Delete Everything'}
          danger={true}
          onConfirm={handleDeleteAccount}
          onClose={() => {
            if (!isDeleting) {
              setShowDeleteConfirm(false);
            }
          }}
        />
      )}
    </div>
  );
};
