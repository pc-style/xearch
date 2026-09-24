export function redactEmail(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
}

export function sanitizeError(value: string): string {
  return redactEmail(value)
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\b(bearer|token|api[_-]?key|authorization)\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]")
    .slice(0, 300);
}
