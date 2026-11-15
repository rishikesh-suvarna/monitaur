// A pragmatic single-address check; the backend (net/mail) has the final say.
const EMAIL_PATTERN = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export const isEmail = (value: string): boolean => EMAIL_PATTERN.test(value.trim());
