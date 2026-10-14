/**
 * Email validation utility enforcing verified and official domain providers:
 * - Gmail / Google (@gmail.com, @googlemail.com)
 * - Microsoft Outlook / Hotmail (@outlook.com, @hotmail.com, @live.com, @msn.com)
 * - Proton Mail (@proton.me, @protonmail.com, @pm.me)
 * - Apple iCloud (@icloud.com, @me.com)
 * - Official academic & university domains (.edu, .ac.uk, .ac.*, .edu.*)
 * - Official governmental and institutional domains (.gov, .org)
 */

export const ALLOWED_PROVIDER_DOMAINS = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'pm.me',
  'protonmail.ch',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Yahoo (major trusted)
  'yahoo.com',
  'ymail.com',
  // GitHub
  'github.com',
  'users.noreply.github.com',
]);

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'tempmail.com',
  'guerrillamail.com',
  'sharklasers.com',
  'trashmail.com',
  'yopmail.com',
  'throwawaymail.com',
  'fakeinbox.com',
]);

export interface EmailValidationResult {
  valid: boolean;
  reason?: string;
  domain?: string;
  isAcademic?: boolean;
  providerName?: string;
}

export function validateOfficialEmail(email: string): EmailValidationResult {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, reason: 'Email address is required.' };
  }

  // Basic RFC email regex check
  const emailRegex = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
  const match = trimmed.match(emailRegex);
  if (!match) {
    return { valid: false, reason: 'Please enter a valid email format (e.g. name@gmail.com).' };
  }

  const domain = match[1];

  // Block disposable addresses
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      valid: false,
      reason: 'Temporary or disposable email addresses are not permitted.',
      domain,
    };
  }

  // 1. Check known allowed providers
  if (ALLOWED_PROVIDER_DOMAINS.has(domain)) {
    let providerName = 'Official Provider';
    if (domain.includes('gmail') || domain.includes('google')) providerName = 'Gmail';
    else if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live') || domain.includes('msn')) providerName = 'Outlook';
    else if (domain.includes('proton') || domain.includes('pm.me')) providerName = 'Proton Mail';
    else if (domain.includes('icloud') || domain.includes('me.com')) providerName = 'iCloud';
    else if (domain.includes('yahoo')) providerName = 'Yahoo';
    else if (domain.includes('github')) providerName = 'GitHub';

    return { valid: true, domain, providerName };
  }

  // 2. Check academic / university official domains
  // Examples: *.edu, *.ac.uk, *.edu.au, *.ac.in, *.ac.jp, *.edu.*
  const isAcademic =
    domain.endsWith('.edu') ||
    domain.includes('.edu.') ||
    domain.endsWith('.ac.uk') ||
    domain.includes('.ac.') ||
    domain.endsWith('.ac');

  if (isAcademic) {
    return { valid: true, domain, isAcademic: true, providerName: 'Academic / Institutional' };
  }

  // 3. Check governmental or accredited research organization domains
  const isGovOrOrg = domain.endsWith('.gov') || domain.includes('.gov.') || domain.endsWith('.org');
  if (isGovOrOrg) {
    return { valid: true, domain, providerName: 'Official Organization' };
  }

  return {
    valid: false,
    reason: 'Only official email providers (Gmail, Outlook, Proton, iCloud) or academic (.edu, .ac) and institutional domains are allowed.',
    domain,
  };
}
