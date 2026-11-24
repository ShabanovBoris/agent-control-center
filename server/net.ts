import { createServer } from 'node:net';

/** Проверка bind'ом: занятый порт не даст запуститься и останется сиротой. */
export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise(resolveFree => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolveFree(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolveFree(true)));
  });
}

/** Vite отдаёт HTML; JSON или чужой ответ не считаются готовностью панели. */
export async function probeWeb(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) });
    const html = response.headers.get('content-type')?.includes('text/html') ?? false;
    await response.body?.cancel();
    return response.status === 200 && html;
  } catch {
    return false;
  }
}
