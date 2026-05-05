import type net from "node:net";
import { Buffer } from "node:buffer";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
	AckSchema,
	BusEventSchema,
	ErrorSchema,
	FrameSchema,
	HelloSchema,
	HistoryRequestSchema,
	HistoryResponseSchema,
	PeersRequestSchema,
	PeersResponseSchema,
	PingSchema,
	PongSchema,
	PresenceSchema,
	PublishSchema,
	SubscribeSchema,
	WelcomeSchema,
	type Frame,
} from "./gen/pi_bus/v1/pi_bus_pb.ts";

const LENGTH_PREFIX_BYTES = 4;

export interface FrameInitMap {
	hello: MessageInitShape<typeof HelloSchema>;
	welcome: MessageInitShape<typeof WelcomeSchema>;
	publish: MessageInitShape<typeof PublishSchema>;
	subscribe: MessageInitShape<typeof SubscribeSchema>;
	historyRequest: MessageInitShape<typeof HistoryRequestSchema>;
	historyResponse: MessageInitShape<typeof HistoryResponseSchema>;
	peersRequest: MessageInitShape<typeof PeersRequestSchema>;
	peersResponse: MessageInitShape<typeof PeersResponseSchema>;
	event: MessageInitShape<typeof BusEventSchema>;
	presence: MessageInitShape<typeof PresenceSchema>;
	ack: MessageInitShape<typeof AckSchema>;
	ping: MessageInitShape<typeof PingSchema>;
	pong: MessageInitShape<typeof PongSchema>;
	error: MessageInitShape<typeof ErrorSchema>;
}

export type FrameCase = keyof FrameInitMap;
export type FrameValue<C extends FrameCase> = FrameInitMap[C];

export function makeFrame<C extends FrameCase>(caseName: C, value: FrameValue<C>): Frame {
	return create(FrameSchema, { body: { case: caseName, value } as MessageInitShape<typeof FrameSchema>["body"] });
}

export function encodeFrame<C extends FrameCase>(caseName: C, value: FrameValue<C>): Buffer {
	const frame = makeFrame(caseName, value);
	const payload = Buffer.from(toBinary(FrameSchema, frame));
	const header = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

export function writeFrame<C extends FrameCase>(socket: net.Socket, caseName: C, value: FrameValue<C>): boolean {
	if (socket.destroyed || !socket.writable) return false;
	return socket.write(encodeFrame(caseName, value));
}

export function decodeFrames(buffer: Buffer, maxFrameBytes: number): { frames: Frame[]; rest: Buffer } {
	const frames: Frame[] = [];
	let offset = 0;

	while (buffer.length - offset >= LENGTH_PREFIX_BYTES) {
		const length = buffer.readUInt32BE(offset);
		if (length > maxFrameBytes) throw new Error(`Protobuf frame exceeded ${maxFrameBytes} bytes`);
		if (buffer.length - offset - LENGTH_PREFIX_BYTES < length) break;

		const payloadStart = offset + LENGTH_PREFIX_BYTES;
		const payloadEnd = payloadStart + length;
		frames.push(fromBinary(FrameSchema, buffer.subarray(payloadStart, payloadEnd)));
		offset = payloadEnd;
	}

	return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) };
}
