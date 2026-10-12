/**
 * Password rules for choosing a new password. Deliberately minimal: a sensible minimum length, matching
 * confirmation, and Supabase's real upper bound (bcrypt only uses the first 72 bytes). No composition rules.
 * The Supabase project's own policy is still authoritative; its rejection is mapped in auth-errors.ts.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

export interface PasswordFieldErrors {
  password?: string;
  confirm?: string;
}

export function validateNewPassword(password: string, confirm: string): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {};
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    errors.password = `Use at most ${PASSWORD_MAX_BYTES} bytes (long passphrases with accented or non-Latin characters count extra).`;
  }
  if (!errors.password && password !== confirm) errors.confirm = "The two passwords do not match.";
  return errors;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 254 && EMAIL.test(email);
}
