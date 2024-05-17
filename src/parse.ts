const EventStreamContentType = "text/event-stream";
/**
 * Represents a message sent in an event stream
 * https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format
 */
export interface EventSourceMessage {
    /** The event ID to set the EventSource object's last event ID value. */
    id: string;
    /** A string identifying the type of event described. */
    event: string;
    /** The event data */
    data: string;
    /** The reconnection interval (in milliseconds) to wait before retrying the connection */
    retry?: number;
}


let retryInterval = 1000;
const LastEventId = 'last-event-id';
const headers: Record<string, string> = {};
if (!headers.accept) {
    headers.accept = EventStreamContentType;
}

/**
 * Converts a ReadableStream into a callback pattern.
 * @param stream The input ReadableStream.
 * @param onChunk A function that will be called on each new byte chunk in the stream.
 * @yields {{
 *  line: Uint8Array,
 *    id: string,
 *    event: string,
 *    data: string,
 *    retry?: number
 * }}
 */
export async function* getBytes(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let result: ReadableStreamReadResult<Uint8Array>;
    while (!(result = await reader.read()).done) {
        const onLine = getMessages()
        const onChunk = getLines();
        for await (const chunk of onChunk(result.value)) {
            for await (const msg of onLine(chunk.line, chunk.fieldLength)) {
                yield msg;
            }
        }
    }
}

const enum ControlChars {
    NewLine = 10,
    CarriageReturn = 13,
    Space = 32,
    Colon = 58,
}

/** 
 * Parses arbitary byte chunks into EventSource line buffers.
 * Each line should be of the format "field: value" and ends with \r, \n, or \r\n. 
 * @returns A function generator that should be called for each incoming byte chunk.
 */
export function getLines() {
    let buffer: Uint8Array | undefined;
    let position: number; // current read position
    let fieldLength: number; // length of the `field` portion of the line
    let discardTrailingNewline = false;

    // return a function that can process each incoming byte chunk:
    return function* onChunk(arr: Uint8Array) {
        if (buffer === undefined) {
            buffer = arr;
            position = 0;
            fieldLength = -1;
        } else {
            // we're still parsing the old line. Append the new bytes into buffer:
            buffer = concat(buffer, arr);
        }

        const bufLength = buffer.length;
        let lineStart = 0; // index where the current line starts
        while (position < bufLength) {
            if (discardTrailingNewline) {
                if (buffer[position] === ControlChars.NewLine) {
                    lineStart = ++position; // skip to next char
                }

                discardTrailingNewline = false;
            }

            // start looking forward till the end of line:
            let lineEnd = -1; // index of the \r or \n char
            for (; position < bufLength && lineEnd === -1; ++position) {
                switch (buffer[position]) {
                    case ControlChars.Colon:
                        if (fieldLength === -1) { // first colon in line
                            fieldLength = position - lineStart;
                        }
                        break;
                    // @ts-ignore:7029 \r case below should fallthrough to \n:
                    case ControlChars.CarriageReturn:
                        discardTrailingNewline = true;
                    case ControlChars.NewLine:
                        lineEnd = position;
                        break;
                }
            }

            if (lineEnd === -1) {
                // We reached the end of the buffer but the line hasn't ended.
                // Wait for the next arr and then continue parsing:
                break;
            }

            // we've reached the line end, send it out:
            yield {
                line: buffer.subarray(lineStart, lineEnd),
                fieldLength: fieldLength,
            }
            // onLine(buffer.subarray(lineStart, lineEnd), fieldLength);
            lineStart = position; // we're now on the next line
            fieldLength = -1;
        }

        if (lineStart === bufLength) {
            buffer = undefined; // we've finished reading it
        } else if (lineStart !== 0) {
            // Create a new view into buffer beginning at lineStart so we don't
            // need to copy over the previous lines when we get the new arr:
            buffer = buffer.subarray(lineStart);
            position -= lineStart;
        }
    }
}

/** 
 * Parses line buffers into EventSourceMessages.
 * @returns A function generator that should be called for each incoming line buffer.
 */
export function getMessages() {
    let message = newMessage();
    const decoder = new TextDecoder();

    // return a function that can process each incoming line buffer:
    return function* onLine(line: Uint8Array, fieldLength: number) {
        if (line.length === 0) {
            // empty line denotes end of message. Trigger the callback and start a new message:
            // onMessage(message);
            yield message;
            message = newMessage();
        } else if (fieldLength > 0) { // exclude comments and lines with no values
            // line is of format "<field>:<value>" or "<field>: <value>"
            // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
            const field = decoder.decode(line.subarray(0, fieldLength));
            const valueOffset = fieldLength + (line[fieldLength + 1] === ControlChars.Space ? 2 : 1);
            const value = decoder.decode(line.subarray(valueOffset));

            switch (field) {
                case 'data':
                    // if this message already has data, append the new value to the old.
                    // otherwise, just set to the new value:
                    message.data = message.data
                        ? message.data + '\n' + value
                        : value; // otherwise, 
                    break;
                case 'event':
                    message.event = value;
                    break;
                case 'id':
                    message.id = value
                    if (value) {
                        // store the id and send it back on the next retry:
                        headers[LastEventId] = value;
                    } else {
                        // don't send the last-event-id header anymore:
                        delete headers[LastEventId];
                    }
                    // NOTE: I would prefer something like a EventSourceIdMessage, , so a ts guard could be used
                    yield {
                        id: message.id,
                        event: message.event,
                        data: message.data,
                        retry: message.retry,
                    }
                    break;
                case 'retry':
                    const retry = parseInt(value, 10);
                    if (!isNaN(retry)) { // per spec, ignore non-integers
                        retryInterval = retry;
                        message.retry = retry;
                        // NOTE: I would prefer something like a EventSourceRetryMessage, so a ts guard could be used
                        yield {
                            id: message.id,
                            event: message.event,
                            data: message.data,
                            retry: retry,
                        }
                    }
                    break;
            }
        }
    }
}

function concat(a: Uint8Array, b: Uint8Array) {
    const res = new Uint8Array(a.length + b.length);
    res.set(a);
    res.set(b, a.length);
    return res;
}

function newMessage(): EventSourceMessage {
    // data, event, and id must be initialized to empty strings:
    // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
    // retry should be initialized to undefined so we return a consistent shape
    // to the js engine all the time: https://mathiasbynens.be/notes/shapes-ics#takeaways
    return {
        data: '',
        event: '',
        id: '',
        retry: undefined,
    };
}
