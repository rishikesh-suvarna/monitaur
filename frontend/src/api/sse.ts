/**
 * Incremental parser for `text/event-stream` (the WHATWG event stream format).
 * Feed it decoded text chunks as they arrive; it emits one message per blank
 * line. Comments (`: ping`) are reported separately so callers can treat them
 * as keep-alives.
 */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export interface SseHandlers {
  onMessage: (message: SseMessage) => void;
  onComment?: (text: string) => void;
  onRetry?: (milliseconds: number) => void;
}

export interface SseParser {
  push: (chunk: string) => void;
}

const DEFAULT_EVENT = 'message';

export function createSseParser(handlers: SseHandlers): SseParser {
  let buffer = '';
  let eventType = '';
  let dataLines: string[] = [];
  let lastId: string | undefined;

  const dispatch = (): void => {
    if (dataLines.length > 0) {
      handlers.onMessage({
        event: eventType === '' ? DEFAULT_EVENT : eventType,
        data: dataLines.join('\n'),
        ...(lastId === undefined ? {} : { id: lastId }),
      });
    }
    eventType = '';
    dataLines = [];
  };

  const processLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) {
      handlers.onComment?.(line.slice(1).trimStart());
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) handlers.onRetry?.(Number(value));
        break;
      default:
        // Unknown fields are ignored, per spec.
        break;
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (ch === '\r' && i === buffer.length - 1) break;
        processLine(buffer.slice(start, i));
        if (ch === '\r' && buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}
