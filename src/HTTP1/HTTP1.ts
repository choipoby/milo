import ChunkyParser from "./ChunkyParser";
import EventEmitter from "../EventEmitter";
import IDataBuffer from "../IDataBuffer";
import IHTTP from "../IHTTP";
import IHTTPHeadersEvent from "../IHTTPHeadersEvent";
import IHTTPRequest from "../IHTTPRequest";
import NetworkPipe from "../NetworkPipe";
import Platform from "../Platform";
import { HTTPTransferEncoding } from "../types";
import { assert } from "../utils";

export default class HTTP1 extends EventEmitter implements IHTTP {
    private headerBuffer?: IDataBuffer;
    private connection?: string;
    private headersFinished: boolean;
    private chunkyParser?: ChunkyParser;
    private contentLength?: number;

    public networkPipe?: NetworkPipe;
    public request?: IHTTPRequest;

    public upgrade: boolean;
    constructor() {
        super();
        this.headersFinished = false;
        this.upgrade = false;
    }

    private getPathName(hostName: string, query: string): string {
        return `${hostName}${query}`;
    }
    send(networkPipe: NetworkPipe, request: IHTTPRequest): boolean {
        this.networkPipe = networkPipe;
        this.request = request;
        let str =
            `${request.method} ${this.getPathName(request.url.pathname || "/", request.url.query as unknown as string)} HTTP/1.1\r
Host: ${request.url.host}\r\n`;

        const standardHeaders = Platform.standardHeaders;
        for (const key in standardHeaders) {
            if (Platform.standardHeaders.hasOwnProperty(key) && !(key in request.requestHeaders)) {
                str += `${key}: ${standardHeaders[key]}\r\n`;
            }
        }
        for (const key in request.requestHeaders) {
            if (request.requestHeaders.hasOwnProperty(key)) {
                str += `${key}: ${request.requestHeaders[key]}\r\n`;
            }
        }
        str += "\r\n";
        this.networkPipe.write(str);

        switch (typeof request.body) {
        case "string":
            this.networkPipe.write(request.body);
            break;
        case "object":
            this.networkPipe.write(request.body, 0, request.body.byteLength);
            break;
        }

        // BRB, Upping my bits above 3000...
        const scratch = Platform.scratch;
        this.networkPipe.on("data", () => {
            while (true) {
                assert(this.networkPipe, "Must have network pipe");

                const read = this.networkPipe.read(scratch, 0, scratch.byteLength);
                Platform.trace("We read some bytes from the pipe", read, this.headersFinished);
                if (read <= 0) {
                    break;
                } else if (!this.headersFinished) {
                    if (this.headerBuffer) {
                        this.headerBuffer.bufferLength = this.headerBuffer.byteLength + read;
                        this.headerBuffer.set(-read, scratch, 0, read);
                    } else {
                        this.headerBuffer = scratch.slice(0, read);
                    }
                    assert(this.headerBuffer);
                    const rnrn = this.headerBuffer.indexOf("\r\n\r\n");
                    if (rnrn !== -1) {
                        this._parseHeaders(rnrn);
                        this.headersFinished = true;

                        let remaining = this.headerBuffer.byteLength - (rnrn + 4);

                        const hOffset = this.headerBuffer.byteLength - remaining;
                        if (!this.chunkyParser && !this.contentLength) {
                            this.networkPipe.stash(this.headerBuffer, hOffset, remaining);
                            remaining = 0;
                        }

                        if (remaining) {
                            this._processResponseData(this.headerBuffer, hOffset, remaining);
                        }

                        this.headerBuffer = undefined;
                        if (this.connection === "Upgrade") {
                            this.upgrade = true;
                            this.emit("finished");

                            // If you don't break, you will
                            // continue to process what's
                            // left in the buffer which is
                            // wrong on upgrade.
                            break;
                        }
                    }
                } else {
                    this._processResponseData(scratch, 0, read);
                }
            }
        });
        this.networkPipe.on("close", () => {
            this.emit("finished");
        });
        return true;
    }

    private _parseHeaders(rnrn: number): boolean {
        assert(this.networkPipe, "Gotta have a pipe");
        assert(this.request, "Gotta have a pipe");

        assert(this.headerBuffer, "Must have headerBuffer");
        const str = Platform.utf8toa(this.headerBuffer, 0, rnrn);
        const split = str.split("\r\n");
        // Platform.trace("got string\n", split);
        const statusLine = split[0];
        // Platform.trace("got status", statusLine);
        if (statusLine.lastIndexOf("HTTP/1.", 0) !== 0) {
            this.emit("error", new Error("Bad status line " + statusLine));
            return false;
        }
        let httpVersion;
        switch (statusLine.charCodeAt(7)) {
        case 49: // 1
            httpVersion = "1.1";
            break;
        case 48: // 0
            httpVersion = "1.0";
            break;
        default:
            this.emit("error", new Error("Bad status line " + statusLine));
            return false;
        }

        assert(this.request, "Gotta have request");
        const event = {
            contentLength: undefined,
            headers: [],
            headersSize: rnrn + 4,
            method: this.request.method,
            requestSize: this.networkPipe.bytesWritten,
            statusCode: -1,
            transferEncoding: 0,
            httpVersion,
            timeToFirstByteRead: this.networkPipe.firstByteRead - this.request.networkStartTime,
            timeToFirstByteWritten: this.networkPipe.firstByteWritten - this.request.networkStartTime
        } as IHTTPHeadersEvent;

        const space = statusLine.indexOf(' ', 9);
        // Platform.trace("got status", space, statusLine.substring(9, space))
        event.statusCode = parseInt(statusLine.substring(9, space), 10);
        if (isNaN(event.statusCode) || event.statusCode < 0) {
            this.emit("error", new Error("Bad status line " + statusLine));
            return false;
        }
        // this.requestResponse.headers = new ResponseHeaders;
        let contentLength: string | undefined;
        let transferEncoding: string | undefined;

        for (let i = 1; i < split.length; ++i) {
            // split \r\n\r\n by \r\n causes 2 empty lines.
            if (split.length === 0) {
                // Platform.trace("IGNORING LINE....");
                continue;
            }
            let idx = split[i].indexOf(":");
            if (idx <= 0) {
                this.emit("error", new Error("Bad header " + split[i]));
                return false;
            }
            const key = split[i].substr(0, idx);
            ++idx;
            while (split[i].charCodeAt(idx) === 32) {
                ++idx;
            }
            let end = split[i].length;
            while (end > idx && split[i].charCodeAt(end - 1) === 32)
                --end;

            const lower = key.toLowerCase();
            const value = split[i].substring(idx, end);
            if (lower === "content-length") {
                contentLength = value;
            } else if (lower === "transfer-encoding") {
                transferEncoding = value;
            } else if (lower === "connection") {
                this.connection = value;
            }
            event.headers.push(key + ": " + value);
        }

        if (transferEncoding) {
            const transferEncodings = transferEncoding.split(",");
            Platform.trace("got some encodings", transferEncodings);
            for (const encoding of transferEncodings) {
                switch (encoding.trim()) {
                case "chunked":
                    this.chunkyParser = new ChunkyParser();
                    this.chunkyParser.on("chunk", (chunk: IDataBuffer) => {
                        Platform.trace("got a chunk right here", chunk.byteLength);
                        this.emit("data", chunk, 0, chunk.byteLength);
                    });
                    this.chunkyParser.on("error", (err: Error) => {
                        this.emit("error", err);
                    });

                    this.chunkyParser.on("done", (buffer: IDataBuffer | undefined) => {
                        if (buffer) {
                            assert(this.networkPipe, "Must have networkPipe");
                            this.networkPipe.stash(buffer, 0, buffer.byteLength);
                        }
                        this.chunkyParser = undefined;
                        this.emit("finished");
                    });

                    event.transferEncoding |= HTTPTransferEncoding.Chunked;
                    break;
                case "compress":
                    event.transferEncoding |= HTTPTransferEncoding.Compress;
                    break;
                case "deflate":
                    event.transferEncoding |= HTTPTransferEncoding.Deflate;
                    break;
                case "gzip":
                    event.transferEncoding |= HTTPTransferEncoding.Gzip;
                    break;
                case "identity":
                    event.transferEncoding |= HTTPTransferEncoding.Identity;
                    break;
                }
            }
        }

        if (contentLength) {
            const len = parseInt(contentLength, 10);
            if (len < 0 || isNaN(len)) {
                this.emit("error", new Error("Bad content length " + contentLength));
                return false;
            }
            this.contentLength = len;
            event.contentLength = len;
        }

        this.emit("headers", event);
        return true;
    }

    // have to copy data, the buffer will be reused
    private _processResponseData(data: IDataBuffer, offset: number, length: number): void {
        Platform.trace("processing data", typeof this.chunkyParser, length);
        if (this.chunkyParser) {
            this.chunkyParser.feed(data, offset, length);
        } else {
            this.emit("data", data, offset, length);
        }
    }
};

