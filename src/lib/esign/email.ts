export function isValidEsignEmail(value: string): boolean {
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");

  return (
    at > 0 &&
    at === trimmed.lastIndexOf("@") &&
    at < trimmed.length - 1 &&
    !/\s/.test(trimmed)
  );
}
