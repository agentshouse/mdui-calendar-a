import { ZodError } from 'zod';

const labels: Record<string, string> = {
  title: 'Title', start: 'Start', end: 'End', location: 'Location',
  description: 'Description', backgroundColor: 'Background color', color: 'Text color',
};

export function validationMessage(error: unknown): string {
  if (!(error instanceof ZodError)) return error instanceof Error ? error.message : String(error);
  return [...new Set(error.issues.map(issue => {
    const field = String(issue.path[0] ?? 'Event');
    const label = labels[field] ?? field;
    if ((field === 'start' || field === 'end') && issue.code === 'invalid_format') {
      return `${label}: enter a complete ISO date and time with a timezone.`;
    }
    return `${label}: ${issue.message}`;
  }))].join(' ');
}
