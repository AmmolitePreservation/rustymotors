import { runWithLogContext } from '@rustymotors/logging';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseProvider, LegacyMessage, type IDatabaseServices, type PersonaSummary } from 'rusty-motors-shared';
import { loggerMock } from 'rusty-motors-shared/test';
import { getPersonaMaps, personaMapsBody } from '../src/persona/getPersonaMaps.js';

const drBrown: PersonaSummary = { personaId: 21, customerId: 654321, name: 'Dr Brown', shardId: 44, createStamp: 0x66000000 };
const loginAddress = '10.111.111.11';

function registerStores(personas: PersonaSummary[]) {
    databaseProvider.register({
        auth: { findSessionAddress: (customerId: number) => (customerId === 654321 ? loginAddress : undefined) },
        persona: { listPersonas: async (customerId: number) => personas.filter((persona) => persona.customerId === customerId) },
    } as unknown as IDatabaseServices);
}

function listRequest(customerId: number): LegacyMessage {
    const packet = Buffer.alloc(16);
    packet.writeUInt16BE(0x532, 0);
    packet.writeUInt16BE(16, 2);
    packet.writeUInt32BE(customerId, 12);
    const message = new LegacyMessage();
    message._doDeserialize(packet);
    return message;
}

async function listFrom(remoteAddress: string, customerId: number): Promise<Buffer> {
    const result = await runWithLogContext({ remoteAddress }, () =>
        getPersonaMaps({ connectionId: 'test:8228', message: listRequest(customerId), log: loggerMock }),
    );
    expect(result.messages).toHaveLength(1);
    return Buffer.from(result.messages[0]!.serialize());
}

afterEach(() => databaseProvider.unregister());

describe('personaMapsBody', () => {
    it('lays each record out with its length, the ids, the stamp, and the name, then the persona limit', () => {
        expect(personaMapsBody([drBrown]).toString('hex')).toBe(
            '0001' + '001a' + '0009fbf1' + '00000015' + '0000002c' + '66000000' + '0008' + Buffer.from('Dr Brown').toString('hex') + '64',
        );
    });

    it('is a zero count and the limit when there are no personas', () => {
        expect(personaMapsBody([]).toString('hex')).toBe('000064');
    });
});

describe('getPersonaMaps', () => {
    it('answers 0x607 with the customer personas behind a 12-byte header of the real length', async () => {
        registerStores([drBrown]);
        const reply = await listFrom(loginAddress, 654321);
        const body = personaMapsBody([drBrown]);
        expect(reply.subarray(0, 12).toString('hex')).toBe('0607' + (12 + body.length).toString(16).padStart(4, '0') + '0101' + '0000' + '00000000');
        expect(reply.subarray(12)).toEqual(body);
    });

    it('answers 0x602 with no body to a request from another address', async () => {
        registerStores([drBrown]);
        const reply = await listFrom('203.0.113.9', 654321);
        expect(reply.toString('hex')).toBe('0602000c0101000000000000');
    });

    it('answers 0x602 for a customer that has not logged in', async () => {
        registerStores([drBrown]);
        const reply = await listFrom(loginAddress, 5551212);
        expect(reply.readUInt16BE(0)).toBe(0x602);
    });
});
