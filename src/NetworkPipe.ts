import { INetworkPipeData, IDataBuffer, IPlatform } from "./types";
import EventEmitter from "./EventEmitter";
import DataBuffer from "./DataBuffer";

// have to redeclare assert since NrdpPlatform doesn't declare assert as asserting
function assert(platform: IPlatform, condition: any, msg?: string): asserts condition {
    platform.assert(condition, msg);
}

class NetworkPipe extends EventEmitter implements INetworkPipeData {
    public idle: boolean;
    public forbidReuse: boolean;
    public firstByteWritten?: number;
    public firstByteRead?: number;
    public dnsTime?: number;
    public connectTime?: number;

    private buffer?: IDataBuffer;
    protected platform: IPlatform;

    constructor(platform: IPlatform) {
        super();
        this.platform = platform;
        this.idle = true;
        this.forbidReuse = false;
    }

    stash(buf: ArrayBuffer | Uint8Array | IDataBuffer, offset: number, length?: number): void {
        if (length === undefined) {
            length = buf.byteLength - offset;
        }
        assert(this.platform, length > 0, "Must have length");
        if (this.buffer) {
            this.buffer.bufferLength = this.buffer.bufferLength + buf.byteLength;
            this.buffer.set(this.buffer.bufferLength - buf.byteLength, buf);
        } else if (buf instanceof DataBuffer) {
            this.buffer = buf;
        } else {
            this.buffer = new DataBuffer(buf);
        }
        this.emit("data");
    }

    unstash(buf: IDataBuffer, offset: number, length: number): number {
        if (this.buffer) {
            const byteLength = this.buffer.byteLength;
            if (length >= byteLength) {
                buf.set(offset, this.buffer, 0, byteLength);
                this.buffer = undefined;
                return byteLength;
            }

            buf.set(offset, this.buffer, 0, length);
            this.buffer.setView(this.buffer.byteOffset + length, this.buffer.byteLength - length);
            return length;
        }
        return -1;
    }
};

export default NetworkPipe;