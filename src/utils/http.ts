import https from 'https';

const MAX_REDIRECTS = 5;

export async function fetchText(url: string, trustedHosts: readonly string[]): Promise<string> {
  return fetchTextWithRedirect(url, 0, trustedHosts);
}

function fetchTextWithRedirect(url: string, redirectCount: number, trustedHosts: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestUrl = assertTrustedUrl(url, trustedHosts);
    const req = https.get(requestUrl, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && location) {
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }

        res.resume();
        const nextUrl = new URL(location, requestUrl).toString();
        fetchTextWithRedirect(nextUrl, redirectCount + 1, trustedHosts).then(resolve).catch(reject);
        return;
      }

      if (status >= 400) {
        reject(new Error(`Failed to fetch ${url}. HTTP ${status}`));
        res.resume();
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
  });
}

function assertTrustedUrl(url: string, trustedHosts: readonly string[]): string {
  const parsed = new URL(url);

  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch non-HTTPS URL: ${url}`);
  }

  if (!trustedHosts.includes(parsed.hostname)) {
    throw new Error(`Refusing to fetch untrusted host: ${parsed.hostname}`);
  }

  return parsed.toString();
}
