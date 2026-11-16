import { runWithLogContext } from '@rustymotors/logging';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseProvider, isPlateTextWellFormed, LegacyMessage, type IDatabaseServices, type PersonaSummary } from 'rusty-motors-shared';
import { loggerMock } from 'rusty-motors-shared/test';
import { gamePersonaRecord } from '../src/persona/gamePersonaRecord.js';
import { checkToken } from '../src/persona/handlers/checkToken.js';
import { createPersona } from '../src/persona/handlers/createPersona.js';
import { deletePersona } from '../src/persona/handlers/deletePersona.js';

const loginAddress = '10.111.111.11';
const customerId = 654321;
const drBrown: PersonaSummary = { personaId: 21, customerId, name: 'Dr Brown', shardId: 44, createStamp: 0x66000000 };

type Store = {
    personas: PersonaSummary[];
    created: { customerId: number; name: string; shardId: number }[];
    deleted: { customerId: number; personaId: number }[];
};

function registerStore(personas: PersonaSummary[], takenNames: string[] = []): Store {
    const store: Store = { personas: [...personas], created: [], deleted: [] };
    databaseProvider.register({
        auth: { findSessionAddress: (customer: number) => (customer === customerId ? loginAddress : undefined) },
        persona: {
            listPersonas: async (customer: number) => store.personas.filter((persona) => persona.customerId === customer),
            createPersona: async (customer: number, name: string, shardId: number) => {
                if (takenNames.includes(name)) {
                    return undefined;
                }
                store.created.push({ customerId: customer, name, shardId });
                return { personaId: 1000, customerId: customer, name, shardId, createStamp: 0x66000010 };
            },
            deletePersona: async (customer: number, personaId: number) => {
                store.deleted.push({ customerId: customer, personaId });
                return store.personas.some((persona) => persona.customerId === customer && persona.personaId === personaId);
            },
        },
    } as unknown as IDatabaseServices);
    return store;
}

function u32(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value, 0);
    return bytes;
}

function u16(value: number): Buffer {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value, 0);
    return bytes;
}

function text(value: string): Buffer {
    return Buffer.concat([u16(value.length), Buffer.from(value, 'latin1')]);
}

function request(id: number, body: Buffer): LegacyMessage {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(12 + body.length, 2);
    header.writeUInt16BE(0x0101, 4);
    const message = new LegacyMessage();
    message._doDeserialize(Buffer.concat([header, body]));
    return message;
}

/** The create request as the client serializes it: its persona record, the game name, 3 stray bytes. */
function createRequest(name: string, shardId: number): LegacyMessage {
    return request(0x507, Buffer.concat([
        u32(customerId), text(name), u32(0), u32(0), u32(0), u32(0), u32(0), u16(0), u32(0), text(''), u32(0), u32(0),
        text(''), text(''), text(''), Buffer.from([0]), u32(0), text(''), u16(0), u32(shardId), text('Motor City'),
        Buffer.from([0xcd, 0xcd, 0xcd]),
    ]));
}

async function reply(handler: typeof createPersona, message: LegacyMessage, remoteAddress = loginAddress): Promise<Buffer> {
    const result = await runWithLogContext({ remoteAddress }, () => handler({ connectionId: 'test:8228', message, log: loggerMock }));
    expect(result.messages).toHaveLength(1);
    const bytes = Buffer.from(result.messages[0]!.serialize());
    expect(bytes.readUInt16BE(2)).toBe(bytes.length);
    return bytes;
}

afterEach(() => databaseProvider.unregister());

describe('gamePersonaRecord', () => {
    it('is the 61 fixed bytes plus the name, with the ids and stamps where the client reads them', () => {
        const record = gamePersonaRecord(drBrown);
        expect(record.length).toBe(61 + 'Dr Brown'.length);
        expect(record.readUInt32BE(0)).toBe(customerId);
        expect(record.subarray(4, 14).toString('latin1')).toBe('\u0000\u0008Dr Brown');
        expect(record.readUInt32BE(18)).toBe(0x66000000);
        expect(record.readUInt32BE(30)).toBe(21);
        expect(record.readUInt32BE(record.length - 4)).toBe(44);
    });
});

describe('createPersona', () => {
    it('creates the persona and answers 0x601 with its record', async () => {
        const store = registerStore([drBrown]);
        const bytes = await reply(createPersona, createRequest('Marty', 44));
        expect(store.created).toEqual([{ customerId, name: 'Marty', shardId: 44 }]);
        expect(bytes.readUInt16BE(0)).toBe(0x601);
        expect(bytes.subarray(12)).toEqual(gamePersonaRecord({ personaId: 1000, customerId, name: 'Marty', shardId: 44, createStamp: 0x66000010 }));
    });

    it('answers 0x612 with the limit once the account has 100 personas', async () => {
        const full = Array.from({ length: 100 }, (_, index) => ({ ...drBrown, personaId: 21 + index, name: `P${21 + index}` }));
        const store = registerStore(full);
        const bytes = await reply(createPersona, createRequest('Marty', 44));
        expect(store.created).toEqual([]);
        expect(bytes.toString('hex')).toBe('06120010010100000000000000000064');
    });

    it('answers 0x20A when the name was taken first', async () => {
        registerStore([drBrown], ['Marty']);
        expect((await reply(createPersona, createRequest('Marty', 44))).readUInt16BE(0)).toBe(0x20a);
    });

    it('answers 0x641 for a shard the shard list does not offer', async () => {
        const store = registerStore([drBrown]);
        expect((await reply(createPersona, createRequest('Marty', 88))).readUInt16BE(0)).toBe(0x641);
        expect(store.created).toEqual([]);
    });

    it('answers 0x602 to a request from another address', async () => {
        const store = registerStore([drBrown]);
        expect((await reply(createPersona, createRequest('Marty', 44), '203.0.113.9')).readUInt16BE(0)).toBe(0x602);
        expect(store.created).toEqual([]);
    });
});

describe('deletePersona', () => {
    it('deletes the persona and answers 0x60C with no body', async () => {
        const store = registerStore([drBrown]);
        const bytes = await reply(deletePersona, request(0x512, Buffer.concat([u32(customerId), u32(21)])));
        expect(store.deleted).toEqual([{ customerId, personaId: 21 }]);
        expect(bytes.toString('hex')).toBe('060c000c0101000000000000');
    });

    it('answers 0x602 for a persona the customer does not have', async () => {
        registerStore([drBrown]);
        expect((await reply(deletePersona, request(0x512, Buffer.concat([u32(customerId), u32(99)])))).readUInt16BE(0)).toBe(0x602);
    });
});

describe('checkToken', () => {
    it('answers 0x207 for a plate the dialog can produce and 0x635 for one it cannot', async () => {
        registerStore([]);
        const accepted = await reply(checkToken, request(0x534, Buffer.concat([u32(2), text('OUTATIM')])));
        const refused = await reply(checkToken, request(0x534, Buffer.concat([u32(2), text('OUTATIME')])));
        expect([accepted.readUInt16BE(0), refused.readUInt16BE(0)]).toEqual([0x207, 0x635]);
    });

    it('accepts 1 to 7 printable characters with inner spaces only', () => {
        expect(['A', 'BTTF 88', 'OUTATIM', '', ' LEAD', 'TRAIL ', 'EIGHTCHR'].map(isPlateTextWellFormed)).toEqual([
            true, true, true, false, false, false, false,
        ]);
    });
});
