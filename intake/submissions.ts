export const eraseVisitorFields = "first_name = '', last_name = '', email = '', company = '', phone = '', message = ''";

export const eraseAgedSubmissions = `
  UPDATE submissions SET ${eraseVisitorFields}
  WHERE julianday(received_at) < julianday(?)
    AND (first_name <> '' OR last_name <> '' OR email <> '' OR company <> '' OR phone <> '' OR message <> '')
`;

export function retentionCutoff(now: Date): string {
  const retention = 30 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - retention).toISOString();
}
