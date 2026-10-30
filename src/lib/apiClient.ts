import { safeFetchJson } from './uploadClient';

export async function fetchJson<T = any>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const { data } = await safeFetchJson<T>(url, init);
  return data;
}
