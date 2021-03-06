import { MqttPacket } from './mqtt.packet';
import { PacketTypes } from './mqtt.constants';
import { PacketStream } from './packet-stream';
import Bluebird = require('bluebird');
import { EndOfStreamError } from './errors';
import {
    ConnectRequestPacket,
    ConnectResponsePacket,
    DisconnectRequestPacket,
    PingRequestPacket,
    PingResponsePacket,
    PublishAckPacket,
    PublishCompletePacket,
    PublishReceivedPacket,
    PublishReleasePacket,
    PublishRequestPacket,
    SubscribeRequestPacket,
    SubscribeResponsePacket,
    UnsubscribeRequestPacket,
    UnsubscribeResponsePacket,
} from './packets';

export class MqttParser {
    protected stream: PacketStream;
    protected errorCallback: (e: Error) => void;

    public mapping: [number, () => MqttPacket][] = [
        [PacketTypes.TYPE_CONNECT, () => new ConnectRequestPacket()],
        [PacketTypes.TYPE_CONNACK, () => new ConnectResponsePacket()],
        [PacketTypes.TYPE_PUBLISH, () => new PublishRequestPacket()],
        [PacketTypes.TYPE_PUBACK, () => new PublishAckPacket()],
        [PacketTypes.TYPE_PUBREC, () => new PublishReceivedPacket()],
        [PacketTypes.TYPE_PUBREL, () => new PublishReleasePacket()],
        [PacketTypes.TYPE_PUBCOMP, () => new PublishCompletePacket()],
        [PacketTypes.TYPE_SUBSCRIBE, () => new SubscribeRequestPacket()],
        [PacketTypes.TYPE_SUBACK, () => new SubscribeResponsePacket()],
        [PacketTypes.TYPE_UNSUBSCRIBE, () => new UnsubscribeRequestPacket()],
        [PacketTypes.TYPE_UNSUBACK, () => new UnsubscribeResponsePacket()],
        [PacketTypes.TYPE_PINGREQ, () => new PingRequestPacket()],
        [PacketTypes.TYPE_PINGRESP, () => new PingResponsePacket()],
        [PacketTypes.TYPE_DISCONNECT, () => new DisconnectRequestPacket()],
    ];

    /**
     * Some workaround for async requests:
     * This prevents the execution if there's already something in the buffer.
     * Note: if something fails, this will lock forever
     * @type {{unlock: () => void; resolve: null; lock: () => void; locked: boolean}}
     */
    private lock = {
        locked: false,
        lock: () => {
            this.lock.locked = true;
        },
        unlock: () => {
            this.lock.locked = false;
            if (this.lock.resolve) {
                this.lock.resolve();
                this.lock.resolve = null;
            }
        },
        resolve: null,
    };

    public constructor(errorCallback?: (e: Error) => void) {
        this.stream = PacketStream.empty();
        this.errorCallback = errorCallback;
    }

    public async parse(data: Buffer): Promise<MqttPacket[]> {
        await this.waitForLock();
        this.lock.lock();
        let startPos = this.stream.position;
        this.stream.write(data);
        this.stream.position = startPos;
        const results: MqttPacket[] = [];
        try {
            while (this.stream.remainingBytes > 0) {
                const type = this.stream.readByte() >> 4;

                let packet;
                try {
                    packet = this.mapping.find(x => x[0] === type)[1]();
                } catch (e) {
                    continue;
                }

                this.stream.seek(-1);
                let exitParser = false;
                await Bluebird.try(() => {
                    packet.read(this.stream);
                    results.push(packet);
                    this.stream.cut();
                    startPos = this.stream.position;
                })
                    .catch(EndOfStreamError, () => {
                        this.stream.position = startPos;
                        exitParser = true;
                    })
                    .catch(e => {
                        this.errorCallback(e);
                    });
                if (exitParser) break;
            }
        } catch (e) {
            this.errorCallback(e);
        }
        this.lock.unlock();
        return results;
    }

    private waitForLock(): Promise<void> {
        if (this.lock.locked) {
            return new Promise<void>(resolve => {
                this.lock.resolve = resolve;
            });
        } else {
            return Promise.resolve();
        }
    }
}
