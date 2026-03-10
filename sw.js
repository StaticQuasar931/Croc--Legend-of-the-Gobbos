const PARTS = [
  { url: './big_data/ps/psx/croc.pbp.001', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.002', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.003', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.004', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.005', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.006', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.007', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.008', size: 15728640 },
  { url: './big_data/ps/psx/croc.pbp.009', size: 2317624 }
];

const TOTAL_SIZE = PARTS.reduce((sum, part) => sum + part.size, 0);
const VIRTUAL_PATH = new URL('./virtual/croc.pbp', self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if ((request.method !== 'GET' && request.method !== 'HEAD') || url.pathname !== VIRTUAL_PATH) {
    return;
  }

  event.respondWith(handleVirtualPbp(request));
});

function buildHeaders(contentLength, extra = {}) {
  return {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(contentLength),
    'Cache-Control': 'no-store',
    ...extra
  };
}

async function handleVirtualPbp(request) {
  const rangeHeader = request.headers.get('range');

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: rangeHeader ? 206 : 200,
      headers: rangeHeader
        ? buildHeaders(0, { 'Content-Range': `bytes */${TOTAL_SIZE}` })
        : buildHeaders(TOTAL_SIZE)
    });
  }

  if (!rangeHeader) {
    return new Response(streamWholeFile(), {
      status: 200,
      headers: buildHeaders(TOTAL_SIZE)
    });
  }

  const parsed = parseRange(rangeHeader, TOTAL_SIZE);
  if (!parsed) {
    return new Response(null, {
      status: 416,
      headers: buildHeaders(0, { 'Content-Range': `bytes */${TOTAL_SIZE}` })
    });
  }

  const { start, end } = parsed;
  const contentLength = end - start + 1;

  return new Response(streamRange(start, end), {
    status: 206,
    headers: buildHeaders(contentLength, {
      'Content-Range': `bytes ${start}-${end}/${TOTAL_SIZE}`
    })
  });
}

function parseRange(rangeHeader, totalSize) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || '');
  if (!match) return null;

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) return null;

  if (start === null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null;
    if (end === null || !Number.isFinite(end) || end >= totalSize) {
      end = totalSize - 1;
    }
  }

  if (end < start) return null;
  return { start, end };
}

function streamWholeFile() {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const part of PARTS) {
          const response = await fetch(new URL(part.url, self.registration.scope), { cache: 'no-store' });
          if (!response.ok || !response.body) {
            throw new Error(`Failed to fetch ${part.url} (${response.status})`);
          }

          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

function streamRange(start, end) {
  return new ReadableStream({
    async start(controller) {
      try {
        let cursor = 0;

        for (const part of PARTS) {
          const partStart = cursor;
          const partEnd = cursor + part.size - 1;
          cursor += part.size;

          if (end < partStart || start > partEnd) {
            continue;
          }

          const sliceStart = Math.max(start, partStart) - partStart;
          const sliceEnd = Math.min(end, partEnd) - partStart;
          const chunk = await fetchPartSlice(part.url, sliceStart, sliceEnd);
          controller.enqueue(chunk);
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

async function fetchPartSlice(partUrl, sliceStart, sliceEnd) {
  const url = new URL(partUrl, self.registration.scope);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Range: `bytes=${sliceStart}-${sliceEnd}`
    }
  });

  if (response.status === 206) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${partUrl} (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer.slice(sliceStart, sliceEnd + 1));
}
