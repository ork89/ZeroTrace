import https from 'https';

const MAX_REDIRECTS = 5;

export async function fetchText(url: string): Promise<string> {
  return fetchTextWithRedirect(url, 0);
}

function fetchTextWithRedirect(url: string, redirectCount: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && location) {
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }

        res.resume();
        const nextUrl = new URL(location, url).toString();
        fetchTextWithRedirect(nextUrl, redirectCount + 1).then(resolve).catch(reject);
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
